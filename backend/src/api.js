'use strict';
const { sql, upsertUser } = require('./db');
const { validateInitData, json, level, escapeHtml } = require('./util');
const { buildQuiz, getQuestions } = require('./questions');
const { notifyQuizCompleted } = require('./notify');
const { createInvoiceLink } = require('./tg');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const BOT_USERNAME = process.env.BOT_USERNAME || '';
const REVEAL_STARS = 99;

function auth(body) {
  return validateInitData(body && body.initData, BOT_TOKEN);
}

function shareUrl(quizId) {
  return `https://t.me/${BOT_USERNAME}/app?startapp=${quizId}`;
}

const SHARE_TEXT = (name) =>
  `${name || 'Я'} проверяет(ют), кто знает его лучше всех 👁 Пройди квиз за 1 минуту:`;

/** POST /api/session */
async function session(req, res, body) {
  const user = auth(body);
  if (!user) return json(res, 401, { ok: false, error: 'auth' });
  await upsertUser(user);
  const quizzes = await sql`
    SELECT q.id, q.created_at, q.pack,
           (SELECT COUNT(*)::int FROM answers a WHERE a.quiz_id = q.id) AS takers,
           (SELECT a.taker_name FROM answers a WHERE a.quiz_id = q.id ORDER BY a.pct DESC, a.created_at ASC LIMIT 1) AS top_name,
           (SELECT a.pct FROM answers a WHERE a.quiz_id = q.id ORDER BY a.pct DESC, a.created_at ASC LIMIT 1) AS top_pct
    FROM quizzes q
    WHERE q.creator_id = ${user.id.toString()} AND q.key IS NOT NULL
    ORDER BY q.created_at DESC LIMIT 20`;
  const [me] = await sql`SELECT muted FROM users WHERE id = ${user.id.toString()}`;
  return json(res, 200, {
    ok: true,
    user: { id: user.id, name: user.first_name || 'Друг', muted: me ? me.muted : false },
    quizzes,
  });
}

/** POST /api/quiz/create */
async function quizCreate(req, res, body) {
  const user = auth(body);
  if (!user) return json(res, 401, { ok: false, error: 'auth' });
  await upsertUser(user);

  // не даём плодить больше 5 активных квизов подряд
  const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM quizzes
    WHERE creator_id = ${user.id.toString()} AND key IS NOT NULL AND created_at > now() - interval '1 day'`;
  if (n >= 5) return json(res, 429, { ok: false, error: 'limit', message: 'Не больше 5 квизов в сутки. Качество важнее количества 😌' });

  const pack = body.pack === 'party' ? 'party' : 'classic';
  const built = buildQuiz(pack);
  const { newId } = require('./util');
  const id = newId();

  await sql`INSERT INTO quizzes (id, creator_id, creator_name, pack, q_ids, votes)
            VALUES (${id}, ${user.id.toString()}, ${user.first_name || 'Друг'}, ${pack},
                    ${JSON.stringify(built.q_ids)}::jsonb, ${JSON.stringify(built.votes)}::jsonb)`;

  const questions = getQuestions(built.q_ids).map((q, i) => ({ i, q: q.q, opts: q.opts }));
  return json(res, 200, { ok: true, quiz: { id, pack, questions, votes: built.votes } });
}

/** POST /api/quiz/key — создатель фиксирует свои ответы */
async function quizKey(req, res, body) {
  const user = auth(body);
  if (!user) return json(res, 401, { ok: false, error: 'auth' });
  const { quiz_id, answers } = body;
  if (!quiz_id || !Array.isArray(answers) || answers.length !== 7 || answers.some((a) => a < 0 || a > 3)) {
    return json(res, 400, { ok: false, error: 'bad_input' });
  }
  const [quiz] = await sql`SELECT id FROM quizzes WHERE id = ${quiz_id} AND creator_id = ${user.id.toString()}`;
  if (!quiz) return json(res, 404, { ok: false, error: 'not_found' });

  await sql`UPDATE quizzes SET key = ${JSON.stringify(answers)}::jsonb WHERE id = ${quiz_id}`;
  return json(res, 200, { ok: true, share: { url: shareUrl(quiz_id), text: SHARE_TEXT(user.first_name) } });
}

/** GET /api/quiz/take?id= */
async function quizTake(req, res, url) {
  const id = new URL(url, 'http://x').searchParams.get('id');
  if (!id) return json(res, 400, { ok: false, error: 'bad_input' });
  const [quiz] = await sql`SELECT id, creator_name, pack, q_ids, votes, key, creator_id FROM quizzes WHERE id = ${id}`;
  if (!quiz || !quiz.key) return json(res, 404, { ok: false, error: 'not_found' });
  const questions = getQuestions(quiz.q_ids).map((q, i) => ({ i, q: q.q, opts: q.opts }));
  return json(res, 200, {
    ok: true,
    quiz: {
      id: quiz.id,
      creator_name: quiz.creator_name,
      creator_id: quiz.creator_id,
      pack: quiz.pack,
      questions,
      votes: quiz.votes || [],
    },
  });
}

/** POST /api/quiz/submit */
async function quizSubmit(req, res, body) {
  const user = auth(body);
  if (!user) return json(res, 401, { ok: false, error: 'auth' });
  const { quiz_id, picks, votes } = body;
  if (!quiz_id || !Array.isArray(picks) || picks.length !== 7 || picks.some((a) => a < 0 || a > 3)) {
    return json(res, 400, { ok: false, error: 'bad_input' });
  }

  const [quiz] = await sql`SELECT id, creator_id, creator_name, key, votes FROM quizzes WHERE id = ${quiz_id}`;
  if (!quiz || !quiz.key) return json(res, 404, { ok: false, error: 'not_found' });

  if (quiz.creator_id === user.id.toString()) {
    return json(res, 400, { ok: false, error: 'self', message: 'Это твой квиз — друзьям виднее 😄' });
  }

  const key = quiz.key;
  const correct = picks.reduce((acc, p, i) => acc + (p === key[i] ? 1 : 0), 0);
  const pct = Math.round((correct / 7) * 100);
  const cleanVotes = Array.isArray(votes) && votes.length === 3 && votes.every((v) => v >= 0 && v <= 3) ? votes : null;

  await upsertUser(user);
  try {
    await sql`INSERT INTO answers (quiz_id, taker_id, taker_name, picks, votes, correct, pct)
              VALUES (${quiz_id}, ${user.id.toString()}, ${user.first_name || 'Друг'},
                      ${JSON.stringify(picks)}::jsonb, ${cleanVotes ? JSON.stringify(cleanVotes) : null}::jsonb, ${correct}, ${pct})`;
  } catch (e) {
    if (String(e.code) === '23505') {
      const [prev] = await sql`SELECT pct FROM answers WHERE quiz_id = ${quiz_id} AND taker_id = ${user.id.toString()}`;
      const lv = level(prev.pct);
      return json(res, 200, { ok: true, already: true, pct: prev.pct, level: lv, place: 0, total: 0 });
    }
    throw e;
  }

  const rows = await sql`SELECT pct FROM answers WHERE quiz_id = ${quiz_id} ORDER BY pct DESC, created_at ASC`;
  const place = rows.findIndex((r) => r.pct <= pct) + 1;
  const total = rows.length;

  await notifyQuizCompleted(quiz, user.first_name, pct, place, total);

  return json(res, 200, { ok: true, pct, level: level(pct), place, total });
}

/** POST /api/quiz/results — только создатель */
async function quizResults(req, res, body) {
  const user = auth(body);
  if (!user) return json(res, 401, { ok: false, error: 'auth' });
  const { quiz_id } = body;

  const [quiz] = await sql`SELECT * FROM quizzes WHERE id = ${quiz_id}`;
  if (!quiz || !quiz.key) return json(res, 404, { ok: false, error: 'not_found' });
  if (quiz.creator_id !== user.id.toString()) return json(res, 403, { ok: false, error: 'forbidden' });

  const rows = await sql`SELECT taker_id, taker_name, picks, votes, pct, created_at
                         FROM answers WHERE quiz_id = ${quiz_id} ORDER BY pct DESC, created_at ASC`;

  const leaderboard = rows.map((r, i) => ({ place: i + 1, name: r.taker_name, pct: r.pct, taker_id: r.taker_id }));

  // агрегаты голосований
  const voteQuestions = quiz.votes || [];
  const votesAgg = voteQuestions.map((v, vi) => {
    const counts = new Array(v.opts.length).fill(0);
    let voted = 0;
    for (const r of rows) {
      if (r.votes && r.votes[vi] != null) { counts[r.votes[vi]]++; voted++; }
    }
    const topIdx = counts.indexOf(Math.max(...counts));
    return { q: v.q, opts: v.opts, counts, voted, top: topIdx >= 0 ? { idx: topIdx, share: voted ? Math.round((counts[topIdx] / voted) * 100) : 0 } : null };
  });

  const details = quiz.reveal_unlocked
    ? rows.map((r) => ({ name: r.taker_name, pct: r.pct, picks: r.picks, votes: r.votes || [] }))
    : null;

  const questions = getQuestions(quiz.q_ids).map((q, i) => ({ i, q: q.q, opts: q.opts }));

  return json(res, 200, {
    ok: true,
    quiz: {
      id: quiz.id,
      questions,
      votes: voteQuestions,
      key: quiz.key,
      reveal_unlocked: quiz.reveal_unlocked,
      leaderboard,
      votes_agg: votesAgg,
      details,
      stars: REVEAL_STARS,
      share: { url: shareUrl(quiz.id), text: SHARE_TEXT(quiz.creator_name) },
    },
  });
}

/** POST /api/quiz/reveal — счёт Stars на раскрытие */
async function quizReveal(req, res, body) {
  const user = auth(body);
  if (!user) return json(res, 401, { ok: false, error: 'auth' });
  const { quiz_id } = body;
  const [quiz] = await sql`SELECT id, creator_id, reveal_unlocked FROM quizzes WHERE id = ${quiz_id}`;
  if (!quiz) return json(res, 404, { ok: false, error: 'not_found' });
  if (quiz.creator_id !== user.id.toString()) return json(res, 403, { ok: false, error: 'forbidden' });
  if (quiz.reveal_unlocked) return json(res, 200, { ok: true, already: true });

  const payload = `reveal:${quiz_id}:${user.id}`;
  const link = await createInvoiceLink(payload);
  if (!link.ok) return json(res, 500, { ok: false, error: 'invoice' });

  await sql`INSERT INTO purchases (payload, user_id, quiz_id, stars)
            VALUES (${payload}, ${user.id.toString()}, ${quiz_id}, ${REVEAL_STARS})
            ON CONFLICT (payload) DO NOTHING`;
  return json(res, 200, { ok: true, invoice_link: link.result, stars: REVEAL_STARS });
}

/** POST /api/payments/confirm — оптимистичное подтверждение из Mini App */
async function paymentsConfirm(req, res, body) {
  const user = auth(body);
  if (!user) return json(res, 401, { ok: false, error: 'auth' });
  const { payload } = body;
  const parts = String(payload || '').split(':');
  if (parts[0] !== 'reveal' || parts.length !== 3 || parts[2] !== String(user.id)) {
    return json(res, 400, { ok: false, error: 'bad_input' });
  }
  const [row] = await sql`SELECT id FROM purchases WHERE payload = ${payload} AND user_id = ${user.id.toString()}`;
  if (!row) return json(res, 404, { ok: false, error: 'not_found' });

  await sql`UPDATE purchases SET confirmed = true WHERE payload = ${payload}`;
  await sql`UPDATE quizzes SET reveal_unlocked = true WHERE id = ${parts[1]}`;
  return json(res, 200, { ok: true });
}

/** POST /api/settings */
async function settings(req, res, body) {
  const user = auth(body);
  if (!user) return json(res, 401, { ok: false, error: 'auth' });
  await upsertUser(user);
  await sql`UPDATE users SET muted = ${!!body.muted} WHERE id = ${user.id.toString()}`;
  return json(res, 200, { ok: true, muted: !!body.muted });
}

module.exports = {
  handlers: {
    'POST /api/session': session,
    'POST /api/quiz/create': quizCreate,
    'POST /api/quiz/key': quizKey,
    'POST /api/quiz/submit': quizSubmit,
    'POST /api/quiz/results': quizResults,
    'POST /api/quiz/reveal': quizReveal,
    'POST /api/payments/confirm': paymentsConfirm,
    'POST /api/settings': settings,
  },
  quizTake,
};
