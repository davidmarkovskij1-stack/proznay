'use strict';
const postgres = require('postgres');

// Supabase / любой Postgres. prepare:false — совместимость с transaction-pooler.
const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
});

let schemaReady = null;
async function initSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS users (
        id BIGINT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        username TEXT,
        muted BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        reminders_total INT NOT NULL DEFAULT 0,
        last_reminder_at TIMESTAMPTZ
      )`;
      await sql`CREATE TABLE IF NOT EXISTS quizzes (
        id TEXT PRIMARY KEY,
        creator_id BIGINT NOT NULL,
        creator_name TEXT NOT NULL DEFAULT '',
        pack TEXT NOT NULL DEFAULT 'classic',
        q_ids JSONB NOT NULL,
        key JSONB,
        votes JSONB,
        status TEXT NOT NULL DEFAULT 'active',
        reveal_unlocked BOOLEAN NOT NULL DEFAULT false,
        reminders_sent INT NOT NULL DEFAULT 0,
        last_reminder_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS answers (
        id SERIAL PRIMARY KEY,
        quiz_id TEXT NOT NULL,
        taker_id BIGINT NOT NULL,
        taker_name TEXT NOT NULL DEFAULT '',
        picks JSONB NOT NULL,
        votes JSONB,
        correct INT NOT NULL DEFAULT 0,
        pct INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (quiz_id, taker_id)
      )`;
      await sql`CREATE TABLE IF NOT EXISTS purchases (
        id SERIAL PRIMARY KEY,
        payload TEXT UNIQUE,
        user_id BIGINT NOT NULL,
        quiz_id TEXT NOT NULL,
        stars INT NOT NULL DEFAULT 0,
        confirmed BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS notifs (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        kind TEXT NOT NULL,
        quiz_id TEXT,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS idx_answers_quiz ON answers(quiz_id)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_quizzes_creator ON quizzes(creator_id)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_notifs_user_time ON notifs(user_id, sent_at)`;
      // миграция: храним ссылку счёта, чтобы повторный тап не создавал новый счёт
      await sql`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS invoice_link TEXT`;
      await sql`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS claimed BOOLEAN NOT NULL DEFAULT false`;
      // анонимные «шептунки» — сообщения друзей создателю
      await sql`ALTER TABLE answers ADD COLUMN IF NOT EXISTS whisper TEXT`;
      // подписка Про+
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS pro_until TIMESTAMPTZ`;
      // редактируемый профиль
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT`;
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS color TEXT`;
      // личные шептунки между друзьями (общий раздел «Шептунки»)
      await sql`CREATE TABLE IF NOT EXISTS whispers (
        id SERIAL PRIMARY KEY,
        from_id BIGINT NOT NULL,
        to_id BIGINT NOT NULL,
        text TEXT NOT NULL,
        from_quiz TEXT,
        read BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS idx_whispers_to ON whispers(to_id, created_at)`;
      // купленные паки (или открытые за донат)
      await sql`CREATE TABLE IF NOT EXISTS user_packs (
        user_id BIGINT NOT NULL,
        pack TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, pack)
      )`;
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

async function upsertUser(tgUser) {
  // имя — только при первой записи (профиль можно менять в приложении)
  await sql`INSERT INTO users (id, name, username)
            VALUES (${tgUser.id.toString()}, ${tgUser.first_name || 'Друг'}, ${tgUser.username || null})
            ON CONFLICT (id) DO UPDATE
            SET last_seen_at = now(),
                username = COALESCE(${tgUser.username || null}, users.username)`;
}

module.exports = { sql, initSchema, upsertUser };
