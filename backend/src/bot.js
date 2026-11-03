'use strict';
const { call, sendMessage, answerCallbackQuery, createInvoiceLink } = require('./tg');
const { sql } = require('./db');
const { escapeHtml } = require('./util');
const { PACKS } = require('./questions');

const APP_URL = process.env.APP_URL || '';

function mainKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🎮 Создать квиз', web_app: { url: APP_URL } }],
      [{ text: '📊 Мои квизы', web_app: { url: `${APP_URL}?startapp=my` } }],
      [{ text: '💎 Поддержать проект', callback_data: 'donate' }],
      [{ text: '🔔 Уведомления', callback_data: 'notif' }, { text: 'ℹ️ Как это работает', callback_data: 'how' }],
    ],
  };
}

function quizKeyboard(quizId) {
  return {
    inline_keyboard: [
      [{ text: '👉 Пройти квиз', web_app: { url: `${APP_URL}?startapp=${quizId}` } }],
    ],
  };
}

const HOW_TEXT =
  'Как работает <b>Прознай</b> 👁\n\n' +
  '<b>1.</b> Отвечаешь на 7 вопросов о себе — это твой «ключ»\n' +
  '<b>2.</b> Отправляешь квиз друзьям одной кнопкой\n' +
  '<b>3.</b> Друзья угадывают твои ответы и получают процент\n' +
  '<b>4.</b> Ты видишь рейтинг: кто знает тебя лучше всех 💜\n\n' +
  'Бесплатно · 1 минута · без регистрации\n' +
  'Хочешь знать больше? Раскрой, <b>кто именно что ответил</b> — за 99 ⭐';

async function handleStart(msg, payload) {
  const chatId = msg.chat.id;
  const name = escapeHtml((msg.from && msg.from.first_name) || 'друг');

  await sql`INSERT INTO users (id, name, username) VALUES (${chatId.toString()}, ${name}, ${msg.from.username || null})
            ON CONFLICT (id) DO UPDATE SET last_seen_at = now()`.catch(() => {});

  if (payload && /^[A-Za-z0-9_-]{6,12}$/.test(payload)) {
    const [quiz] = await sql`SELECT creator_name FROM quizzes WHERE id = ${payload}`;
    if (quiz) {
      const who = escapeHtml(quiz.creator_name || 'твой друг');
      return sendMessage(chatId,
        `🎯 <b>ЧЕЛЛЕНДЖ ОТ ${who.toUpperCase()}</b>\n\n` +
        `Насколько хорошо ты знаешь этого человека? Проверим!\n\n` +
        `· <b>7 вопросов</b> — угадай, как ответил(а) бы он(а)\n` +
        `· <b>3 анонимных</b> — что ты о нём(ней) думаешь 🤫\n` +
        `· Твой результат попадёт в личный лидерборд 🏆\n\n` +
        `⏱ Займёт меньше минуты`,
        { reply_markup: quizKeyboard(payload) });
    }
  }

  return sendMessage(chatId,
    `Привет, ${name}! Я — <b>Прознай</b> 👁\n\n` +
    'Я составлю квиз о тебе: друзья ответят — и ты узнаешь, <b>кто знает тебя лучше всех</b> (а кто просто делает вид 😏)\n\n' +
    'Бесплатно · 1 минута · без регистрации',
    { reply_markup: mainKeyboard() });
}

async function handleNotifToggle(msg) {
  const [user] = await sql`SELECT muted FROM users WHERE id = ${msg.chat.id.toString()}`;
  const muted = user ? user.muted : false;
  await sql`UPDATE users SET muted = ${!muted} WHERE id = ${msg.chat.id.toString()}`;
  return sendMessage(msg.chat.id,
    muted
      ? '🔔 Уведомления включены. Буду писать редко и по делу: когда друзья проходят твой квиз.'
      : '🔕 Уведомления выключены. Результаты квизов всегда доступны в приложении.',
    { reply_markup: mainKeyboard() });
}

async function handleDonate(cb) {
  await answerCallbackQuery(cb.id);
  const userId = cb.from.id;
  // создаём счёт сразу и отдаём как URL-кнопки
  const rows = [];
  for (const amount of [25, 50, 100]) {
    const payload = `donate:${userId}:${amount}:${Date.now()}`;
    const link = await createInvoiceLink({
      payload,
      title: 'Поддержать «Прознай»',
      description: 'Донат идёт на развитие проекта. Спасибо! 💜',
      amount,
    });
    if (link.ok) rows.push([{ text: `💎 ${amount} ⭐`, url: link.result }]);
  }
  if (!rows.length) {
    return sendMessage(cb.message.chat.id, 'Не получилось создать счёт. Попробуй позже 🙏');
  }
  return sendMessage(cb.message.chat.id,
    'Хочешь поддержать «Прознай»? 💜\n\nВсе звёзды идут на развитие проекта. Выбери любую сумму — оплата в один тап:',
    { reply_markup: { inline_keyboard: rows } });
}

async function onUpdate(update) {
  try {
    if (update.message) {
      const msg = update.message;
      const text = (msg.text || '').trim();
      const chatId = msg.chat && msg.chat.id;

      if (text.startsWith('/start')) {
        const payload = text.split(/\s+/)[1] || '';
        return handleStart(msg, payload);
      }
      if (text.startsWith('/quiz')) {
        return sendMessage(chatId, 'Создай свой квиз — и узнаешь, кто из друзей знает тебя лучше всех 👁',
          { reply_markup: { inline_keyboard: [[{ text: '🎮 Создать квиз', web_app: { url: `${APP_URL}?startapp=create` } }]] } });
      }
      if (text.startsWith('/my')) {
        return sendMessage(chatId, 'Твои квизы и лидерборды — здесь:',
          { reply_markup: { inline_keyboard: [[{ text: '📊 Открыть', web_app: { url: `${APP_URL}?startapp=my` } }]] } });
      }
      if (text.startsWith('/mute')) return handleNotifToggle(msg);
      if (text.startsWith('/unmute')) {
        await sql`UPDATE users SET muted = false WHERE id = ${chatId.toString()}`;
        return sendMessage(chatId, '🔔 Уведомления включены.');
      }
      if (text.startsWith('/help')) {
        return sendMessage(chatId, HOW_TEXT, { reply_markup: mainKeyboard() });
      }
      if (msg.successful_payment) {
        return handlePayment(msg);
      }
      if (text) {
        return sendMessage(chatId, 'Я работаю кнопками 👇 Создай квиз и отправь друзьям!',
          { reply_markup: mainKeyboard() });
      }
      return;
    }

    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message && cb.message.chat.id;
      if (cb.data === 'donate') {
        return handleDonate(cb);
      }
      if (cb.data === 'how') {
        await answerCallbackQuery(cb.id);
        return sendMessage(chatId, HOW_TEXT, { reply_markup: mainKeyboard() });
      }
      if (cb.data === 'notif') {
        await answerCallbackQuery(cb.id);
        return handleNotifToggle(cb.message);
      }
      await answerCallbackQuery(cb.id, 'Прознай 👁');
      return;
    }

    if (update.pre_checkout_query) {
      await call('answerPreCheckoutQuery', { pre_checkout_query_id: update.pre_checkout_query.id, ok: true }).catch(() => {});
      return;
    }
  } catch (e) {
    console.error('onUpdate error:', e.message);
  }
}

async function handlePayment(msg) {
  const p = msg.successful_payment;
  const parts = (p.invoice_payload || '').split(':');
  const name = escapeHtml((msg.from && msg.from.first_name) || 'друг');

  // донат: фиксируем и обещаем награду в приложении
  if (parts[0] === 'donate' && parts.length === 4) {
    await sql`INSERT INTO purchases (payload, user_id, quiz_id, stars, confirmed, claimed)
              VALUES (${p.invoice_payload}, ${msg.from.id.toString()}, 'donate', ${p.total_amount}, true, false)
              ON CONFLICT (payload) DO UPDATE SET confirmed = true, claimed = false`.catch(() => {});
    return sendMessage(msg.chat.id,
      `Спасибо, ${name}! ${p.total_amount} ⭐ 💜\n\nТеперь забери награду:\nоткрой приложение → <b>Настройки → 🎁 Награда за донат</b>`,
      { reply_markup: { inline_keyboard: [[{ text: '🎁 Забрать награду', web_app: { url: `${APP_URL}?startapp=my` } }]] } })
      .catch(() => {});
  }

  // покупка пака: открываем сразу
  if (parts[0] === 'pack' && parts.length === 4) {
    const code = PACKS[parts[2]] ? parts[2] : null;
    if (code) {
      await sql`INSERT INTO user_packs (user_id, pack) VALUES (${msg.from.id.toString()}, ${code}) ON CONFLICT DO NOTHING`.catch(() => {});
      const pk = PACKS[code];
      return sendMessage(msg.chat.id,
        `Пак открыт 🔓\n\n<b>${pk.emoji} ${pk.title}</b> — теперь можно создать квиз с этим вайбом!`,
        { reply_markup: { inline_keyboard: [[{ text: '🎮 Создать квиз', web_app: { url: `${APP_URL}?startapp=my` } }]] } })
        .catch(() => {});
    }
  }

  if (parts[0] !== 'reveal' || parts.length !== 3) return;
  const [, quizId, userIdStr] = parts;
  const userId = Number(userIdStr);

  await sql`UPDATE purchases SET confirmed = true WHERE payload = ${p.invoice_payload}`;
  await sql`UPDATE quizzes SET reveal_unlocked = true WHERE id = ${quizId}`;

  await sendMessage(msg.chat.id,
    'Раскрыто 🔓\n\nТеперь в лидерборде видно, <b>кто именно как ответил</b> — и кто что написал в секретных голосованиях 😏',
    { reply_markup: { inline_keyboard: [[{ text: '👀 Открыть лидерборд', web_app: { url: `${APP_URL}?startapp=${quizId}` } }]] } })
    .catch(() => {});
  console.log(`Payment ok: user ${userId} quiz ${quizId} stars ${p.total_amount}`);
}

module.exports = { onUpdate, mainKeyboard, HOW_TEXT };
