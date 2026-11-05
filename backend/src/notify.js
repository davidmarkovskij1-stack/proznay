'use strict';
const { sendMessage } = require('./tg');
const { sql } = require('./db');
const { level, escapeHtml } = require('./util');
const APP_URL = process.env.APP_URL || '';

/**
 * Уведомление только о шептунках (прохождение квиза — без уведомления).
 * Анти-спам: не более 8 уведомлений на квиз в час.
 */
async function notifyWhisper(creatorId, whisper) {
  if (!creatorId || !whisper) return;
  const [u] = await sql`SELECT muted FROM users WHERE id = ${creatorId}`;
  if (u && u.muted) return;

  const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM notifs
    WHERE kind = 'whisper' AND sent_at > now() - interval '1 hour'`;
  if (n >= 8) return;

  await sendMessage(creatorId,
    `🤫 <b>Кто-то шепнул тебе анонимно:</b>\n\n«${escapeHtml(whisper)}»`,
    { reply_markup: { inline_keyboard: [[{ text: '💌 Открыть шептунки', web_app: { url: `${APP_URL}?startapp=whispers` } }]] } })
    .catch(() => {});
  await sql`INSERT INTO notifs (user_id, kind) VALUES (${creatorId.toString()}, 'whisper')`;
}

/**
 * Ежедневный обход (cron): мягкие напоминания без спама.
 * 1) Квиз создан 48ч+ назад, никто не прошёл → до 2 напоминаний (не чаще раз в 72ч).
 * 2) Создатель не заходил 5+ дней, но у квиза есть результаты → дайджест (раз в неделю, всего до 4).
 */
async function sweep() {
  const sent = [];

  // 1) Пустые квизы
  const lonely = await sql`
    SELECT q.id, q.creator_id, q.creator_name, q.reminders_sent, q.last_reminder_at
    FROM quizzes q
    WHERE q.status = 'active'
      AND q.key IS NOT NULL
      AND q.created_at < now() - interval '48 hours'
      AND q.reminders_sent < 2
      AND (q.last_reminder_at IS NULL OR q.last_reminder_at < now() - interval '72 hours')
      AND NOT EXISTS (SELECT 1 FROM answers a WHERE a.quiz_id = q.id)
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = q.creator_id AND u.muted = true)`;
  for (const q of lonely) {
    const ok = await sendMessage(q.creator_id,
      'Привет! Твой квиз пока одиноко ждёт друзей 🥺\n\nОдно сообщение в чат — и рейтинг оживёт.',
      { reply_markup: { inline_keyboard: [[{ text: '📨 Отправить друзьям', web_app: { url: `${APP_URL}?startapp=${q.id}` } }]] } })
      .then(() => true).catch(() => false);
    await sql`UPDATE quizzes SET reminders_sent = reminders_sent + 1, last_reminder_at = now() WHERE id = ${q.id}`;
    if (ok) { sent.push({ kind: 'lonely', quiz: q.id }); await sql`INSERT INTO notifs (user_id, kind, quiz_id) VALUES (${q.creator_id}, 'lonely', ${q.id})`; }
  }

  // 2) Дайджест по активным квизам для «остывших» создателей
  const sleepy = await sql`
    SELECT q.id AS quiz_id, q.creator_id, q.reminders_sent,
           (SELECT COUNT(*)::int FROM answers a WHERE a.quiz_id = q.id) AS takers,
           (SELECT a.pct FROM answers a WHERE a.quiz_id = q.id ORDER BY a.pct DESC, a.created_at ASC LIMIT 1) AS top_pct,
           (SELECT a.taker_name FROM answers a WHERE a.quiz_id = q.id ORDER BY a.pct DESC, a.created_at ASC LIMIT 1) AS top_name
    FROM quizzes q
    JOIN users u ON u.id = q.creator_id
    WHERE q.status = 'active'
      AND u.muted = false
      AND u.last_seen_at < now() - interval '5 days'
      AND (u.last_reminder_at IS NULL OR u.last_reminder_at < now() - interval '7 days')
      AND q.reminders_sent < 4
    LIMIT 50`;
  for (const s of sleepy) {
    if (!s.takers) continue;
    const lv = level(s.top_pct || 0);
    const ok = await sendMessage(s.creator_id,
      `Пока тебя не было: <b>${s.takers}</b> ${plural(s.takers, 'человек прошёл', 'человека прошли', 'человек прошли')} твой квиз 👀\n\n` +
      `Лидер — <b>${escapeHtml(s.top_name || 'кто-то')}</b> с результатом <b>${s.top_pct}%</b> ${lv.emoji}`,
      { reply_markup: { inline_keyboard: [[{ text: '📊 Открыть рейтинг', web_app: { url: `${APP_URL}?startapp=${s.quiz_id}` } }]] } })
      .then(() => true).catch(() => false);
    await sql`UPDATE users SET last_reminder_at = now(), reminders_total = reminders_total + 1 WHERE id = ${s.creator_id}`;
    await sql`UPDATE quizzes SET reminders_sent = reminders_sent + 1, last_reminder_at = now() WHERE id = ${s.quiz_id}`;
    if (ok) { sent.push({ kind: 'digest', quiz: s.quiz_id }); await sql`INSERT INTO notifs (user_id, kind, quiz_id) VALUES (${s.creator_id}, 'digest', ${s.quiz_id})`; }
  }

  return sent;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

module.exports = { sweep, notifyWhisper };
