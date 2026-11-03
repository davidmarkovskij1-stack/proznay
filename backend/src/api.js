'use strict';
const { sql, upsertUser } = require('./db');
const { validateInitData, json, level, escapeHtml, jparse } = require('./util');
const { buildQuiz, getQuestions, PACKS, isAdultPack } = require('./questions');
const { notifyQuizCompleted } = require('./notify');
const { createInvoiceLink } = require('./tg');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const BOT_USERNAME = process.env.BOT_USERNAME || '';
const REVEAL_STARS = 99;

function auth(body) {
  return validateInitData(body && body.initData, BOT_TOKEN);
}

function shareUrl(quizId) {
  // deep link на бота: получателю приходит вызов от бота
  return `https://t.me/${BOT_USERNAME}?start=${quizId}`;
}

const SHARE_TEXT = (name) =>
  `Челлендж от ${name} 👁 Насколько хорошо ты знаешь ${name}? Пройди квиз за 1 минуту!`;

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

  const pack = PACKS[body.pack] ? body.pack : 'classic';

  // платный пак — проверяем доступ
  if (PACKS[pack].price > 0) {
    const [owned] = await sql`SELECT 1 FROM user_packs WHERE user_id = ${user.id.toString()} AND pack = ${pack}`;
    if (!owned) {
      return json(res, 402, {
        ok: false, error: 'locked', pack,
        message: `Пак «${PACKS[pack].title}» ещё не открыт 🔒`,
      });
    }
  }

  const built = buildQuiz(pack);
  const { newId } = require('./util');
  const id = newId();

  await sql`INSERT INTO quizzes (id, creator_id, creator_name, pack, q_ids, votes)
            VALUES (${id}, ${user.id.toString()}, ${user.first_name || 'Друг'}, ${pack},
                    ${JSON.stringify(built.q_ids)}::jsonb, ${JSON.stringify(built.votes)}::jsonb)`;

  const questions = getQuestions(built.q_ids).map((q, i) => ({ i, q: q.q, opts: q.opts }));
  return json(res, 200, { ok: true, quiz: { id, pack, questions, votes: built.votes } });
}

/** POST /api/packs — список паков с флагом доступа */
async function packsList(req, res, body) {
  const user = auth(body);
  if (!user) return json(res, 401, { ok: false, error: 'auth' });
  const rows = await sql`SELECT pack FROM user_packs WHERE user_id = ${user.id.toString()}`;
  const owned = new Set(rows.map((r) => r.pack));
  const packs = Object.values(PACKS).map((p) => ({
    code: p.code, title: p.title, emoji: p.emoji, desc: p.desc,
    price: p.price, owned: p.price === 0 || owned.has(p.code),
    adult: isAdultPack(p.code),
  }));
  return json(res, 200, { ok: true, packs });
}

/** POST /api/pack/buy — счёт на открытие пака */
async function packBuy(req, res, body) {
  const user = auth(body);
  if (!user) return json(res, 401, { ok: false, error: 'auth' });
  const code = PACKS[body.pack] ? body.pack : null;
  if (!code || PACKS[code].price === 0) return json(res, 400, { ok: false, error: 'bad_input' });

  const [owned] = await sql`SELECT 1 FROM user_packs WHERE user_id = ${user.id.toString()} AND pack = ${code}`;
  if (owned) return json(res, 200, { ok: true, already: true });

  const payload = `pack:${user.id}:${code}:${Date.now()}`;
  const link = await createInvoiceLink({
    payload,
    title: `Прознай: пак «${PACKS[code].title}» ${PACKS[code].emoji}`,
    description: PACKS[code].desc + ' — открывается навсегда',
    amount: PACKS[code].price,
  });
  if (!link.ok) return json(res, 500, { ok: false, error: 'invoice' });

  await sql`INSERT INTO purchases (payload, user_id, quiz_id, stars, invoice_link)
            VALUES (${payload}, ${user.id.toString()}, ${'pack:' + code}, ${PACKS[code].price}, ${link.result})
            ON CONFLICT (payload) DO UPDATE SET invoice_link = ${link.result}`;
  return json(res, 200, { ok: true, invoice_link: link.result, stars: PACKS[code].price, payload });
}

/** POST /api/quiz/delete — удалить свой квиз (и ответы) */
async function quizDelete(req, res, body) {
  const user = auth(body);
  if (!user) return json(res, 401, { ok: false, error: 'auth' });
  const { quiz_id } = body;
  if (!quiz_id) return json(res, 400, { ok: false, error: 'bad_input' });
  const [quiz] = await sql`SELECT id FROM quizzes WHERE id = ${quiz_id} AND creator_id = ${user.id.toString()}`;
  if (!quiz) return json(res, 404, { ok: false, error: 'not_found' });
  await sql`DELETE FROM answers WHERE quiz_id = ${quiz_id}`;
  await sql`DELETE FROM quizzes WHERE id = ${quiz_id}`;
  await sql`DELETE FROM notifs WHERE quiz_id = ${quiz_id}`;
  return json(res, 200, { ok: true });
}

/** POST /api/donate/claim — забрать награду за донат */
async function donateClaim(req, res, body) {
  const user = auth(body);
  if (!user) return json(res, 401, { ok: false, error: 'auth' });
  const uid = user.id.toString();
  const purchases = await sql`SELECT payload, stars FROM purchases
    WHERE user_id = ${uid} AND payload LIKE 'donate:%' AND confirmed = true AND claimed = false`;
  if (!purchases.length) return json(res, 400, { ok: false, error: 'nothing', message: 'Нет необработанных наград' });

  const paidPacks = Object.values(PACKS).filter((p) => p.price > 0);
  const owned = new Set((await sql`SELECT pack FROM user_packs WHERE user_id = ${uid}`).map((r) => r.pack));
  const locked = paidPacks.filter((p) => !owned.has(p.code));
  const chosen = Array.isArray(body.packs) ? body.packs.filter((c) => PACKS[c] && PACKS[c].price > 0) : [];
  const granted = [];
  let mecenat = false;

  for (const p of purchases) {
    await sql`UPDATE purchases SET claimed = true WHERE payload = ${p.payload}`;
    if (p.stars >= 100) {
      // меценат: все платные паки навсегда
      for (const pp of paidPacks) {
        await sql`INSERT INTO user_packs (user_id, pack) VALUES (${uid}, ${pp.code}) ON CONFLICT DO NOTHING`;
      }
      granted.push(...paidPacks.map((pp) => pp.code));
      mecenat = true;
      break;
    }
    const slots = p.stars >= 50 ? 2 : 1;
    let give;
    if (slots === 2 && chosen.length) {
      give = chosen.filter((c) => !owned.has(c) && !granted.includes(c)).slice(0, slots);
    } else {
      give = locked.filter((c) => !granted.includes(c)).slice(0, slots);
    }
    if (!give.length && locked.length) give = [locked[locked.length - 1]];
    for (const code of give) {
      await sql`INSERT INTO user_packs (user_id, pack) VALUES (${uid}, ${code}) ON CONFLICT DO NOTHING`;
      granted.push(code);
    }
  }

  const unique = [...new Set(granted)];
  return json(res, 200, {
    ok: true,
    granted: unique.map((c) => ({ code: c, title: PACKS[c].title, emoji: PACKS[c].emoji })),
    mecenat,
  });
}

/** POST /api/donate/status — есть ли необработанные награды */
async function donateStatus(req, res, body) {
  const user = auth(body);
  if (!user) return json(res, 401, { ok: false, error: 'auth' });
  const rows = await sql`SELECT payload, stars FROM purchases
    WHERE user_id = ${user.id.toString()} AND payload LIKE 'donate:%' AND confirmed = true AND claimed = false`;
  return json(res, 200, { ok: true, unclaimed: rows.length, amounts: rows.map((r) => r.stars) });
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
  const qIds = jparse(quiz.q_ids);
  const voteQs = jparse(quiz.votes) || [];
  const questions = getQuestions(qIds).map((q, i) => ({ i, q: q.q, opts: q.opts }));
  return json(res, 200, {
    ok: true,
    quiz: {
      id: quiz.id,
      creator_name: quiz.creator_name,
      creator_id: quiz.creator_id,
      pack: quiz.pack,
      questions,
      votes: voteQs,
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

  const key = jparse(quiz.key);
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

  // самовосстановление: если оплата прошла (webhook/confirm), но флаг не успел выставиться
  let revealUnlocked = quiz.reveal_unlocked;
  if (!revealUnlocked) {
    const [p] = await sql`SELECT confirmed FROM purchases WHERE payload = ${'reveal:' + quiz_id + ':' + user.id.toString()}`;
    if (p && p.confirmed) {
      await sql`UPDATE quizzes SET reveal_unlocked = true WHERE id = ${quiz_id}`;
      revealUnlocked = true;
    }
  }

  const rows = await sql`SELECT taker_id, taker_name, picks, votes, pct, created_at
                         FROM answers WHERE quiz_id = ${quiz_id} ORDER BY pct DESC, created_at ASC`;
  for (const r of rows) { r.picks = jparse(r.picks); r.votes = jparse(r.votes) || []; }

  const leaderboard = rows.map((r, i) => ({ place: i + 1, name: r.taker_name, pct: r.pct, taker_id: r.taker_id }));

  // агрегаты голосований
  const voteQuestions = jparse(quiz.votes) || [];
  const votesAgg = voteQuestions.map((v, vi) => {
    const counts = new Array(v.opts.length).fill(0);
    let voted = 0;
    for (const r of rows) {
      if (r.votes && r.votes[vi] != null) { counts[r.votes[vi]]++; voted++; }
    }
    const topIdx = counts.indexOf(Math.max(...counts));
    return { q: v.q, opts: v.opts, counts, voted, top: topIdx >= 0 && voted ? { idx: topIdx, share: Math.round((counts[topIdx] / voted) * 100) } : null };
  });

  const details = revealUnlocked
    ? rows.map((r) => ({ name: r.taker_name, pct: r.pct, picks: r.picks, votes: r.votes || [] }))
    : null;

  const questions = getQuestions(jparse(quiz.q_ids)).map((q, i) => ({ i, q: q.q, opts: q.opts }));

  return json(res, 200, {
    ok: true,
    quiz: {
      id: quiz.id,
      questions,
      votes: voteQuestions,
      key: jparse(quiz.key),
      reveal_unlocked: revealUnlocked,
      leaderboard,
      votes_agg: votesAgg,
      details,
      stars: REVEAL_STARS,
      share: { url: shareUrl(quiz.id), text: SHARE_TEXT(quiz.creator_name) },
    },
  });
}

/** POST /api/quiz/reveal — счёт Stars на раскрытие (повторно отдаём ту же ссылку — двойная оплата невозможна) */
async function quizReveal(req, res, body) {
  const user = auth(body);
  if (!user) return json(res, 401, { ok: false, error: 'auth' });
  const { quiz_id } = body;
  const [quiz] = await sql`SELECT id, creator_id, reveal_unlocked FROM quizzes WHERE id = ${quiz_id}`;
  if (!quiz) return json(res, 404, { ok: false, error: 'not_found' });
  if (quiz.creator_id !== user.id.toString()) return json(res, 403, { ok: false, error: 'forbidden' });
  if (quiz.reveal_unlocked) return json(res, 200, { ok: true, already: true });

  const payload = `reveal:${quiz_id}:${user.id}`;
  const [existing] = await sql`SELECT invoice_link FROM purchases WHERE payload = ${payload} AND invoice_link IS NOT NULL`;
  if (existing && existing.invoice_link) {
    return json(res, 200, { ok: true, invoice_link: existing.invoice_link, stars: REVEAL_STARS });
  }

  const link = await createInvoiceLink({
    payload,
    title: 'Прознай: кто что ответил',
    description: 'Раскрыть имена и ответы всех друзей в твоём квизе',
    amount: REVEAL_STARS,
  });
  if (!link.ok) return json(res, 500, { ok: false, error: 'invoice' });

  await sql`INSERT INTO purchases (payload, user_id, quiz_id, stars, invoice_link)
            VALUES (${payload}, ${user.id.toString()}, ${quiz_id}, ${REVEAL_STARS}, ${link.result})
            ON CONFLICT (payload) DO UPDATE SET invoice_link = ${link.result}`;
  return json(res, 200, { ok: true, invoice_link: link.result, stars: REVEAL_STARS });
}

/** POST /api/donate — ссылка на донат Stars (просто монетка, ничего не разблокирует) */
async function donate(req, res, body) {
  const user = auth(body);
  if (!user) return json(res, 401, { ok: false, error: 'auth' });
  const amount = [25, 50, 100].includes(Number(body.amount)) ? Number(body.amount) : 50;
  const payload = `donate:${user.id}:${amount}:${Date.now()}`;
  const link = await createInvoiceLink({
    payload,
    title: 'Поддержать «Прознай»',
    description: 'Донат идёт на развитие проекта. Спасибо! 💜',
    amount,
  });
  if (!link.ok) return json(res, 500, { ok: false, error: 'invoice' });
  return json(res, 200, { ok: true, invoice_link: link.result, amount, payload });
}

/** POST /api/payments/confirm — подтверждение из Mini App (reveal / pack / donate) */
async function paymentsConfirm(req, res, body) {
  const user = auth(body);
  if (!user) return json(res, 401, { ok: false, error: 'auth' });
  const { payload } = body;
  const parts = String(payload || '').split(':');
  const uid = user.id.toString();

  if (parts[0] === 'reveal' && parts.length === 3 && parts[2] === uid) {
    const [row] = await sql`SELECT id FROM purchases WHERE payload = ${payload} AND user_id = ${uid}`;
    if (!row) return json(res, 404, { ok: false, error: 'not_found' });
    await sql`UPDATE purchases SET confirmed = true WHERE payload = ${payload}`;
    await sql`UPDATE quizzes SET reveal_unlocked = true WHERE id = ${parts[1]}`;
    return json(res, 200, { ok: true });
  }

  if (parts[0] === 'pack' && parts.length === 4 && parts[1] === uid) {
    const code = PACKS[parts[2]] ? parts[2] : null;
    if (!code || PACKS[code].price === 0) return json(res, 400, { ok: false, error: 'bad_input' });
    const [row] = await sql`SELECT id FROM purchases WHERE payload = ${payload} AND user_id = ${uid}`;
    if (!row) return json(res, 404, { ok: false, error: 'not_found' });
    await sql`UPDATE purchases SET confirmed = true WHERE payload = ${payload}`;
    await sql`INSERT INTO user_packs (user_id, pack) VALUES (${uid}, ${code}) ON CONFLICT DO NOTHING`;
    return json(res, 200, { ok: true });
  }

  if (parts[0] === 'donate' && parts.length === 4 && parts[1] === uid) {
    const [row] = await sql`SELECT id FROM purchases WHERE payload = ${payload} AND user_id = ${uid}`;
    if (!row) return json(res, 404, { ok: false, error: 'not_found' });
    await sql`UPDATE purchases SET confirmed = true, claimed = false WHERE payload = ${payload}`;
    return json(res, 200, { ok: true });
  }

  return json(res, 400, { ok: false, error: 'bad_input' });
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
    'POST /api/quiz/delete': quizDelete,
    'POST /api/quiz/reveal': quizReveal,
    'POST /api/packs': packsList,
    'POST /api/pack/buy': packBuy,
    'POST /api/payments/confirm': paymentsConfirm,
    'POST /api/donate': donate,
    'POST /api/donate/claim': donateClaim,
    'POST /api/donate/status': donateStatus,
    'POST /api/settings': settings,
  },
  quizTake,
};
