-- ============================================================
-- Схема базы данных для Telegram-бота на Cloudflare D1
-- Выполни этот скрипт через: wrangler d1 execute <DB_NAME> --file=schema.sql
-- ============================================================

-- Таблица пользователей
-- Хранит API-ключ Gemini и текущего активного персонажа
CREATE TABLE IF NOT EXISTS users (
    chat_id     INTEGER PRIMARY KEY,       -- Уникальный ID чата Telegram
    api_key     TEXT,                      -- API-ключ Gemini пользователя
    char_id     INTEGER                    -- ID текущего активного персонажа (NULL = нет выбранного)
);

-- Таблица персонажей
-- Хранит кастомных персонажей, созданных пользователями
CREATE TABLE IF NOT EXISTS characters (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,           -- Имя персонажа
    system_prompt TEXT NOT NULL,           -- Системный промпт (роль/инструкция для ИИ)
    creator_id    INTEGER NOT NULL,        -- chat_id создателя персонажа
    FOREIGN KEY (creator_id) REFERENCES users(chat_id)
);

-- Таблица истории сообщений
-- Хранит контекст диалога для каждой пары (пользователь + персонаж)
CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id      INTEGER NOT NULL,         -- ID чата Telegram
    character_id INTEGER,                  -- ID персонажа (NULL = дефолтный ассистент)
    role         TEXT NOT NULL CHECK(role IN ('user', 'model')), -- Роль отправителя
    text         TEXT NOT NULL,            -- Текст сообщения
    timestamp    INTEGER NOT NULL          -- Unix-timestamp создания сообщения
);

-- Индексы для ускорения выборки истории сообщений
CREATE INDEX IF NOT EXISTS idx_messages_chat_char
    ON messages (chat_id, character_id, timestamp);
