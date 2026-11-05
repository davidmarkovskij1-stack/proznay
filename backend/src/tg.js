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

const createInvoiceLink = (o) => {
  const params = {
    title: o.title || 'Прознай',
    description: o.description || 'Спасибо за поддержку!',
    payload: o.payload,
    currency: 'XTR',
    prices: [{ label: o.label || 'Прознай', amount: o.amount || 99 }],
  };
  if (o.subscription_period) params.subscription_period = o.subscription_period;
  return call('createInvoiceLink', params);
};

module.exports = { call, sendMessage, answerCallbackQuery, createInvoiceLink, API };
