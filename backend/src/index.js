'use strict';
const http = require('http');
const { initSchema, sql } = require('./db');
const { json, readBody } = require('./util');
const { onUpdate } = require('./bot');
const { sweep } = require('./notify');
const { handlers, quizTake } = require('./api');
const { call } = require('./tg');

const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const APP_URL = process.env.APP_URL || '';
const BACKEND_URL = process.env.BACKEND_URL || '';
const BOT_USERNAME = process.env.BOT_USERNAME || '';

async function adminSetup() {
  const results = {};
  results.me = await call('getMe');
  results.webhook = await call('setWebhook', {
    url: `${BACKEND_URL}/webhook`,
    secret_token: WEBHOOK_SECRET,
    drop_pending_updates: true,
    allowed_updates: ['message', 'callback_query', 'pre_checkout_query'],
  });
  results.name = await call('setMyName', { name: 'Прознай 👁' });
  results.desc = await call('setMyDescription', {
    description: 'Узнай, кто из друзей знает тебя лучше всех. Квиз о тебе — за 1 минуту, бесплатно.',
  });
  results.short = await call('setMyShortDescription', {
    short_description: 'Квиз о тебе: проверь, кто из друзей знает тебя лучше всех 👁',
  });
  results.commands = await call('setMyCommands', {
    commands: [
      { command: 'start', description: 'Создать квиз о себе' },
      { command: 'my', description: 'Мои квизы и рейтинги' },
      { command: 'help', description: 'Как это работает' },
      { command: 'mute', description: 'Выключить уведомления' },
    ],
  });
  results.menu = await call('setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Прознай', web_app: { url: APP_URL } },
  });
  return results;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // --- Telegram webhook ---
    if (path === '/webhook' && req.method === 'POST') {
      const secret = req.headers['x-telegram-bot-api-secret-token'];
      if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) {
        res.writeHead(403); return res.end('forbidden');
      }
      const raw = await readBody(req, 256 * 1024);
      res.writeHead(200); res.end('ok');
      let update;
      try { update = JSON.parse(raw); } catch { return; }
      if (update && update.update_id) setImmediate(() => onUpdate(update));
      return;
    }

    // --- CORS preflight для Mini App ---
    if (path.startsWith('/api/') && req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': APP_URL,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Init-Data',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }

    // --- healthcheck (держит Render живым, проверяет БД) ---
    if (path === '/health') {
      try {
        await initSchema();
        await sql`SELECT 1`;
        return json(res, 200, { ok: true, db: true, ts: Date.now() });
      } catch (e) {
        return json(res, 500, { ok: false, db: false, error: e.message });
      }
    }

    // --- ежедневный обход напоминаний (cron-job.org) ---
    if (path === '/cron/remind' && req.method === 'GET') {
      if (!ADMIN_KEY || url.searchParams.get('key') !== ADMIN_KEY) {
        res.writeHead(403); return res.end('forbidden');
      }
      await initSchema();
      const sent = await sweep();
      return json(res, 200, { ok: true, sent });
    }

    // --- однократная настройка бота (webhook, имя, меню) ---
    if (path === '/admin/setup' && req.method === 'GET') {
      if (!ADMIN_KEY || url.searchParams.get('key') !== ADMIN_KEY) {
        res.writeHead(403); return res.end('forbidden');
      }
      const results = await adminSetup();
      return json(res, 200, { ok: true, results });
    }

    // --- публичный конфиг для Mini App ---
    if (path === '/api/config' && req.method === 'GET') {
      return json(res, 200, { ok: true, bot_username: BOT_USERNAME });
    }

    // --- Mini App API ---
    if (path === '/api/quiz/take' && req.method === 'GET') {
      await initSchema();
      return quizTake(req, res, req.url);
    }
    const handler = handlers[`${req.method} ${path}`];
    if (handler) {
      await initSchema();
      const raw = await readBody(req);
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return json(res, 400, { ok: false, error: 'bad_json' }); }
      return await handler(req, res, body);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Прознай 👁');
  } catch (e) {
    console.error('route error:', path, e.message);
    if (!res.headersSent) return json(res, 500, { ok: false, error: 'server' });
    try { res.end(); } catch {}
  }
});

initSchema()
  .then(() => console.log('DB schema ready'))
  .catch((e) => console.error('DB schema FAILED:', e.message));
server.listen(PORT, () => console.log(`Прознай backend on :${PORT}`));
