// Полный E2E-тест против живого сервера. Запуск: node test-e2e.js
'use strict';
const crypto = require('crypto');

const API = 'https://proznay.onrender.com';
const BOT_TOKEN = process.env.BOT_TOKEN || '9137322570:AAGUVEQ0Z3Z6Y4Nwxi6VH6kHtJ6TjgUds7A';
const CREATOR_ID = 900001, FRIEND_ID = 900002;

function makeInitData(userId, firstName) {
  const params = new URLSearchParams();
  params.set('auth_date', String(Math.floor(Date.now() / 1000)));
  params.set('user', JSON.stringify({ id: userId, first_name: firstName }));
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const pairs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort();
  const hash = crypto.createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

async function post(path, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  assert(data.ok === true, `${path} → HTTP ${res.status} ${JSON.stringify(data).slice(0, 150)}`);
  return data;
}

async function get(path) {
  const res = await fetch(API + path);
  const data = await res.json();
  assert(data.ok === true, `${path} → HTTP ${res.status} ${JSON.stringify(data).slice(0, 150)}`);
  return data;
}

(async () => {
  // предочистка: если прошлый прогон упал до уборки
  const { default: pg } = await import('postgres');
  const sqlPre = pg(process.env.DATABASE_URL_TEST || 'postgresql://postgres.lmplpfcieauniylnvsxs:w0hZsmF0kNY1FDO4@aws-0-eu-west-1.pooler.supabase.com:6543/postgres', { prepare: false, max: 1 });
  await sqlPre`DELETE FROM user_packs WHERE user_id IN (${CREATOR_ID}, ${FRIEND_ID})`;
  await sqlPre`DELETE FROM purchases WHERE user_id IN (${CREATOR_ID}, ${FRIEND_ID})`;
  await sqlPre`DELETE FROM notifs WHERE user_id IN (${CREATOR_ID}, ${FRIEND_ID})`;
  await sqlPre`DELETE FROM users WHERE id IN (${CREATOR_ID}, ${FRIEND_ID})`;
  const oldQuizzes = await sqlPre`SELECT id FROM quizzes WHERE creator_id IN (${CREATOR_ID}, ${FRIEND_ID})`;
  for (const q of oldQuizzes) {
    await sqlPre`DELETE FROM answers WHERE quiz_id = ${q.id}`;
    await sqlPre`DELETE FROM quizzes WHERE id = ${q.id}`;
  }
  await sqlPre.end({ timeout: 5 });

  console.log('— 1. session создателя');
  const creatorInit = makeInitData(CREATOR_ID, 'ТестВладелец');
  const s = await post('/api/session', { initData: creatorInit });
  assert(Array.isArray(s.quizzes), 'session.quizzes array');

  console.log('— 2. create quiz');
  const c = await post('/api/quiz/create', { initData: creatorInit, pack: 'classic' });
  assert(c.quiz.questions.length === 7, '7 вопросов');
  assert(c.quiz.votes.length === 3, '3 голосования');

  console.log('— 3. key');
  const picks = c.quiz.questions.map(() => Math.floor(Math.random() * 4));
  const k = await post('/api/quiz/key', { initData: creatorInit, quiz_id: c.quiz.id, answers: picks });
  assert(k.share.url.includes('?start='), 'share url имеет ?start=');

  console.log('— 4. take (GET)');
  const t = await get(`/api/quiz/take?id=${c.quiz.id}`);
  assert(t.quiz.questions.length === 7, 'take 7 вопросов');
  assert(t.quiz.votes.length === 3, 'take 3 голосования');
  assert(t.quiz.questions.every((q) => q.opts && q.opts.length === 4), 'у всех вопросов 4 опции');

  console.log('— 5. submit от друга (3 из 7 верных) + шептунок');
  const friendInit = makeInitData(FRIEND_ID, 'ТестДруг');
  const friendPicks = picks.map((p, i) => (i < 3 ? p : (p + 1) % 4));
  const sub = await post('/api/quiz/submit', { initData: friendInit, quiz_id: c.quiz.id, picks: friendPicks, votes: [0, 1, 2], whisper: 'Ты классный! 🤫 блять тест фильтра' });
  const expectedPct = Math.round((3 / 7) * 100);
  assert(sub.pct === expectedPct, `pct ${sub.pct} === ${expectedPct} (подсчёт очков!)`);
  assert(sub.level && sub.level.title, 'level присутствует');

  console.log('— 6. results до оплаты');
  const r = await post('/api/quiz/results', { initData: creatorInit, quiz_id: c.quiz.id });
  assert(r.quiz.leaderboard.length === 1, '1 игрок в лидерборде');
  assert(r.quiz.votes_agg.length === 3, '3 агрегата голосований');
  assert(r.quiz.votes_agg[0].top !== null, 'агрегат имеет top');
  assert(r.quiz.details === null, 'детали скрыты до оплаты');
  assert(r.quiz.stars === 99, 'цена 99 звёзд');
  // шептунок теперь в общем разделе (whispers-таблица), не в results
  const whEarly = await post('/api/whispers', { initData: creatorInit });
  assert(whEarly.whispers.some((w) => w.text.includes('Ты классный')), 'шептунок в общем разделе');
  assert(whEarly.whispers.find((w) => w.text.includes('Ты классный')).author === null, 'автор скрыт без Про');

  console.log('— 7. reveal (создание счёта)');
  const rev = await post('/api/quiz/reveal', { initData: creatorInit, quiz_id: c.quiz.id });
  assert(String(rev.invoice_link).startsWith('https://t.me/'), 'invoice link валидный');

  console.log('— 7b. reveal повторно (та же ссылка — защита от двойной оплаты)');
  const rev2 = await post('/api/quiz/reveal', { initData: creatorInit, quiz_id: c.quiz.id });
  assert(rev2.invoice_link === rev.invoice_link, 'ссылка переиспользуется');

  console.log('— 8. payments/confirm (как после оплаты)');
  await post('/api/payments/confirm', { initData: creatorInit, payload: `reveal:${c.quiz.id}:${CREATOR_ID}` });

  console.log('— 9. results после оплаты → детали раскрыты');
  const r2 = await post('/api/quiz/results', { initData: creatorInit, quiz_id: c.quiz.id });
  assert(r2.quiz.reveal_unlocked === true, 'reveal_unlocked true');
  assert(r2.quiz.details !== null && r2.quiz.details.length === 1, 'details раскрыты');
  assert(JSON.stringify(r2.quiz.details[0].picks) === JSON.stringify(friendPicks), 'в деталях верные пики друга');
  // фильтр мата проверяем в общем разделе: мат заменён звёздочками
  const whF = await post('/api/whispers', { initData: creatorInit });
  const wF = whF.whispers.find((w) => w.text.includes('тест фильтра'));
  assert(wF && wF.text.includes('***') && !wF.text.includes('блять'), 'фильтр мата работает');

  console.log('— 9b. пак «Психология» (Скоро) отклоняется');
  const psyTry = await fetch(API + '/api/quiz/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData: creatorInit, pack: 'psy' }),
  });
  const psyData = await psyTry.json();
  assert(psyData.ok === false && psyData.error === 'soon', 'soon-пак отклонён');

  console.log('— 10. donate');
  const d = await post('/api/donate', { initData: friendInit, amount: 25 });
  assert(String(d.invoice_link).startsWith('https://t.me/'), 'donate invoice link');

  console.log('— 11. settings mute/unmute');
  await post('/api/settings', { initData: friendInit, muted: true });
  await post('/api/settings', { initData: friendInit, muted: false });

  console.log('— 12. my quizzes содержит квиз');
  const s2 = await post('/api/session', { initData: creatorInit });
  assert(s2.quizzes.some((q) => q.id === c.quiz.id), 'квиз в списке моих');

  console.log('— 13. submit повторно (уже отвечал)');
  const sub2 = await post('/api/quiz/submit', { initData: friendInit, quiz_id: c.quiz.id, picks: friendPicks, votes: [0, 1, 2] });
  assert(sub2.already === true, 'already=true при повторе');

  console.log('— 14. packs list (платные закрыты)');
  const pl = await post('/api/packs', { initData: creatorInit });
  assert(pl.packs.length === 7, '7 паков');
  const truthPack = pl.packs.find((p) => p.code === 'truth');
  assert(truthPack && !truthPack.owned && truthPack.price === 99, 'truth закрыт, 99 звёзд');
  assert(pl.packs.find((p) => p.code === 'love').owned, 'love бесплатный и открыт');

  console.log('— 15. создать квиз с закрытым паком → 402');
  const lockedTry = await fetch(API + '/api/quiz/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData: creatorInit, pack: 'truth' }),
  });
  const lockedData = await lockedTry.json();
  assert(lockedData.ok === false && lockedData.error === 'locked', 'locked для закрытого пака');

  console.log('— 16. купить пак truth → invoice → confirm');
  const buy = await post('/api/pack/buy', { initData: creatorInit, pack: 'truth' });
  assert(String(buy.invoice_link).startsWith('https://t.me/'), 'pack invoice link');
  assert(buy.payload.startsWith('pack:900001:truth:'), 'pack payload');
  await post('/api/payments/confirm', { initData: creatorInit, payload: buy.payload });
  const pl2 = await post('/api/packs', { initData: creatorInit });
  assert(pl2.packs.find((p) => p.code === 'truth').owned, 'truth открыт после оплаты');

  console.log('— 17. создать квиз с открытым паком → OK, 5 вопросов пака');
  const c2 = await post('/api/quiz/create', { initData: creatorInit, pack: 'truth' });
  assert(c2.ok && c2.quiz.questions.length === 7, 'квиз с платным паком создался');

  console.log('— 18. donate → confirm → claim (меценат 100⭐)');
  const d2 = await post('/api/donate', { initData: friendInit, amount: 100 });
  assert(String(d2.invoice_link).startsWith('https://t.me/'), 'donate 100 invoice');
  await post('/api/payments/confirm', { initData: friendInit, payload: d2.payload });
  const claim = await post('/api/donate/claim', { initData: friendInit, packs: [] });
  assert(claim.mecenat === true, 'меценат при 100⭐');
  const pl3 = await post('/api/packs', { initData: friendInit });
  assert(pl3.packs.filter((p) => p.price > 0).every((p) => p.owned), 'все платные паки у друга');

  console.log('— 19. donate status пуст после claim');
  const dst = await post('/api/donate/status', { initData: friendInit });
  assert(dst.unclaimed === 0, 'нет необработанных наград');

  console.log('— 20. delete квиза');
  await post('/api/quiz/delete', { initData: creatorInit, quiz_id: c2.quiz.id });
  const delTry = await fetch(API + '/api/quiz/take?id=' + c2.quiz.id);
  const delData = await delTry.json();
  assert(delData.ok === false, 'квиз удалён (take 404)');

  console.log('— 21. профиль: сохранить и получить');
  const pfSave = await post('/api/profile', { initData: friendInit, name: 'ТестДруг', bio: 'Я люблю тесты', color: '#ff6ec7' });
  assert(pfSave.profile.name === 'ТестДруг', 'имя сохранено');
  assert(pfSave.profile.color === '#ff6ec7', 'цвет сохранён');
  const pfGet = await post('/api/profile', { initData: friendInit });
  assert(pfGet.profile.bio === 'Я люблю тесты', 'био получено');

  console.log('— 22. друзья: друг видит создателя с quiz_id');
  const fr = await post('/api/friends', { initData: friendInit });
  assert(fr.friends.length >= 1, 'минимум 1 друг');
  const creatorFriend = fr.friends.find((f) => Number(f.id) === CREATOR_ID);
  assert(creatorFriend, 'создатель в списке друзей друга');
  assert(creatorFriend.quiz_id, 'у создателя есть активный квиз для прохождения');

  console.log('— 23. шепоток другу из вкладки Друзья');
  await post('/api/whisper/send', { initData: friendInit, to_id: CREATOR_ID, text: 'Привет от друга 🤫' });
  const wh = await post('/api/whispers', { initData: creatorInit });
  assert(wh.whispers.some((w) => w.text.includes('Привет от друга') && !w.fromMe), 'шептунок получен создателем');
  assert(wh.whispers.find((w) => w.text.includes('Привет от друга')).author === null, 'автор скрыт без Про');

  console.log('— 24. лимит: второй шептунок тому же другу в сутки → 429');
  const limTry = await fetch(API + '/api/whisper/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData: friendInit, to_id: CREATOR_ID, text: 'Ещё раз' }),
  });
  const limData = await limTry.json();
  assert(limData.ok === false && limData.error === 'limit', 'лимит 1/сутки на друга работает');

  console.log('— 25. Про+ подписка: buy → confirm → pro активен, паки открыты');
  const sub2b = await post('/api/sub/buy', { initData: friendInit });
  assert(String(sub2b.invoice_link).startsWith('https://t.me/'), 'sub invoice link');
  await post('/api/payments/confirm', { initData: friendInit, payload: sub2b.payload });
  const sessPro = await post('/api/session', { initData: friendInit });
  assert(sessPro.user.pro === true, 'pro активен после оплаты');
  const plPro = await post('/api/packs', { initData: friendInit });
  assert(plPro.packs.filter((p) => p.price > 0).every((p) => p.owned), 'Про открывает все паки');
  const whPro = await post('/api/whispers', { initData: friendInit });
  assert(whPro.whispers.some((w) => w.author !== null), 'Про раскрывает авторов полученных шептунков');

  console.log('— 26. qotd: вопрос дня доступен');
  const qres = await fetch(API + '/api/qotd');
  const qd = await qres.json();
  assert(qd.ok && qd.q && qd.opts.length === 4, 'вопрос дня работает');

  console.log('\n✅ E2E ПРОЙДЕН ПОЛНОСТЬЮ — 26 шагов ок. Квиз: ' + c.quiz.id);

  // уборка тестовых данных
  const { default: pg2 } = await import('postgres');
  const sql = pg2(process.env.DATABASE_URL_TEST || 'postgresql://postgres.lmplpfcieauniylnvsxs:w0hZsmF0kNY1FDO4@aws-0-eu-west-1.pooler.supabase.com:6543/postgres', { prepare: false, max: 1 });
  await sql`DELETE FROM whispers WHERE from_id IN (${CREATOR_ID}, ${FRIEND_ID}) OR to_id IN (${CREATOR_ID}, ${FRIEND_ID})`;
  await sql`DELETE FROM notifs WHERE user_id IN (${CREATOR_ID}, ${FRIEND_ID})`;
  await sql`DELETE FROM purchases WHERE user_id IN (${CREATOR_ID}, ${FRIEND_ID})`;
  await sql`DELETE FROM answers WHERE quiz_id = ${c.quiz.id}`;
  await sql`DELETE FROM quizzes WHERE id = ${c.quiz.id}`;
  await sql`DELETE FROM user_packs WHERE user_id IN (${CREATOR_ID}, ${FRIEND_ID})`;
  await sql`DELETE FROM users WHERE id IN (${CREATOR_ID}, ${FRIEND_ID})`;
  await sql.end({ timeout: 5 });
  console.log('🧹 Тестовые данные удалены из БД');
  process.exit(0);
})().catch((e) => { console.error('\n❌ E2E ПРОВАЛЕН:', e.message); process.exit(1); });
