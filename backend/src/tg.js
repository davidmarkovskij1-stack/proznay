'use strict';
const TOKEN = process.env.BOT_TOKEN || '';
const API = `https://api.telegram.org/bot${TOKEN}`;

async function call(method, payload) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) console.error(`TG ${method} error:`, JSON.stringify(data).slice(0, 400));
  return data;
}

const sendMessage = (chat_id, text, extra = {}) =>
  call('sendMessage', {
    chat_id,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...extra,
  });

const answerCallbackQuery = (callback_query_id, text) =>
  call('answerCallbackQuery', { callback_query_id, text });

const createInvoiceLink = (payload) =>
  call('createInvoiceLink', {
    title: 'Прознай: кто что ответил',
    description: 'Раскрыть имена и ответы всех друзей в твоём квизе',
    payload,
    currency: 'XTR',
    prices: [{ label: 'Прознай', amount: 99 }],
  });

module.exports = { call, sendMessage, answerCallbackQuery, createInvoiceLink, API };
