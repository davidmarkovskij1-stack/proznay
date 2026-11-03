# Прознай 👁 — Telegram Mini App

**«Узнай, кто знает тебя лучше всех»** — квиз-челлендж для друзей.

## Архитектура

```
┌─────────────────┐      ┌──────────────────────┐      ┌──────────────┐
│ Telegram         │─────▶│ Backend (Render)     │─────▶│ Neon Postgres│
│  бот + webhook   │      │ Node.js, REST API    │      │ users, quizzes│
└─────────────────┘      └──────────────────────┘      │ answers, paid │
        │                        ▲                      └──────────────┘
        ▼                        │
┌─────────────────────────────────┴──┐
│ Mini App (GitHub Pages)            │
│ index.html + app.js + styles.css   │
└────────────────────────────────────┘
```

- **Mini App** — статика на GitHub Pages (бесплатно, CDN, из РФ доступен)
- **Backend** — Node.js (без зависимостей кроме драйвера БД) на Render free
- **БД** — Neon Postgres free
- **Напоминания** — cron-job.org пингует `/cron/remind?key=...` раз в сутки
- **Оплата** — Telegram Stars (XTR), invoice link + webhook `successful_payment`

## Файлы

| Путь | Что это |
|---|---|
| `backend/src/index.js` | HTTP-сервер: webhook, REST, health, admin-setup, cron |
| `backend/src/api.js` | REST для Mini App (create/key/take/submit/results/reveal) |
| `backend/src/bot.js` | Логика бота: /start, кнопки, оплата, ответы |
| `backend/src/questions.js` | Банк: 94 вопроса + 20 голосований, сборка квиза |
| `backend/src/notify.js` | Уведомления + анти-спам + ежедневный sweep |
| `backend/src/db.js` | Neon serverless, схема |
| `backend/src/util.js` | HMAC-валидация initData, хелперы |
| `miniapp/` | Фронт Mini App (3 файла) |

## Переменные окружения (Render)

| Ключ | Значение |
|---|---|
| `BOT_TOKEN` | токен от @BotFather |
| `BOT_USERNAME` | имя бота без @ |
| `NEON_DATABASE_URL` | строка подключения Neon (postgres://…) |
| `APP_URL` | URL GitHub Pages, напр. `https://USER.github.io/proznay/` |
| `BACKEND_URL` | URL сервиса Render, напр. `https://proznay.onrender.com` |
| `WEBHOOK_SECRET` | случайная строка (любая) |
| `ADMIN_KEY` | случайная строка для /admin/setup и /cron/remind |
| `REVEAL_STARS` | 99 (цена раскрытия, опционально) |

## Деплой (порядок)

1. **GitHub**: создать репо `proznay`, загрузить `miniapp/*` (Pages из корня main) и `backend/`
2. **GitHub Pages**: Settings → Pages → Deploy from branch → main → root
3. **Neon**: создать проект → скопировать connection string
4. **Render**: New → Web Service → подключить репо
   - Root Directory: `backend`
   - Build: `npm install`; Start: `npm start`
   - Instance: Free
   - Environment: все переменные из таблицы
5. **Разовая настройка бота**: открыть в браузере `https://<render-url>/admin/setup?key=<ADMIN_KEY>` — ставит webhook, имя, описание, команды, меню-кнопку
6. **cron-job.org**: GET `https://<render-url>/cron/remind?key=<ADMIN_KEY>` каждые 24 ч (можно чаще — sweep идемпотентен)
7. **BotFather**: `/setuserpic` — аватар; включить payments через `@BotFather` → Payments → Stars не требует провайдера

### Анти-сон Render (free)
Free-инстанс засыпает через 15 мин простоя. Webhook сам будит сервис при каждом сообщении боту (задержка ~30 сек на первый запрос). Чтобы Mini App не тормозил, cron-job.org может пинговать `/health` каждые 10 мин (бесплатный план позволяет).

## Проверка

- `GET /health` → `{"ok":true,"db":true}`
- Бот: /start → приветствие с кнопкой Mini App
- Mini App: создать квиз → шаринг → прохождение с другого аккаунта → лидерборд → покупка Stars (в тестовых платежах Stars реальные, но дешёвые)

## Цена

Всё — на free-тарифах: **0 ₽/мес**. Платные лимиты начнут ощущаться после ~сотен тысяч прохождений в месяц.
