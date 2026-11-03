'use strict';
const crypto = require('crypto');

/** Короткий уникальный id квиза (base64url, 8 символов) */
function newId() {
  return crypto.randomBytes(6).toString('base64url');
}

/** Уровень знания по проценту */
function level(pct) {
  if (pct >= 85) return { title: 'Родственная душа', emoji: '✨' };
  if (pct >= 57) return { title: 'Близкий друг', emoji: '💜' };
  if (pct >= 29) return { title: 'Знакомый', emoji: '🙂' };
  return { title: 'Случайный прохожий', emoji: '🚶' };
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickN(arr, n) {
  return shuffle(arr).slice(0, n);
}

/**
 * Валидация Telegram WebApp initData.
 * Возвращает объект пользователя или null.
 */
function validateInitData(initData, botToken) {
  try {
    if (!initData || !botToken) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const pairs = [...params.entries()].map(([k, v]) => `${k}=${v}`);
    pairs.sort();
    const dataCheckString = pairs.join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calc = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    if (calc !== hash) return null;
    const userRaw = params.get('user');
    if (!userRaw) return null;
    const user = JSON.parse(userRaw);
    if (!user || typeof user.id !== 'number') return null;
    // защита от подмены времени (окно 24 часа)
    const authDate = Number(params.get('auth_date') || 0);
    if (authDate && Date.now() / 1000 - authDate > 86400) return null;
    return user;
  } catch {
    return null;
  }
}

// CORS требует origin без пути: из APP_URL берём только scheme://host
function appOrigin() {
  try { return new URL(process.env.APP_URL || '').origin; } catch { return ''; }
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': appOrigin(),
    'Access-Control-Allow-Headers': 'Content-Type, X-Init-Data',
  });
  res.end(body);
}

async function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** JSONB из разных драйверов приходит строкой или объектом — приводим к объекту */
function jparse(v) {
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}

module.exports = { newId, level, shuffle, pickN, validateInitData, json, readBody, escapeHtml, jparse };
