/**
 * Telegram-бот на Cloudflare Workers + D1 + Gemini API
 *
 * Переменные окружения (wrangler.toml / Cloudflare Dashboard → Settings → Variables):
 *   TELEGRAM_TOKEN  — токен бота от @BotFather
 *
 * Привязка D1 (wrangler.toml):
 *   [[d1_databases]]
 *   binding = "DB"
 *   database_name = "your-db-name"
 *   database_id   = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 */

// ============================================================
// КОНСТАНТЫ
// ============================================================

/** Модель Gemini для генерации ответов */
const GEMINI_MODEL = "gemini-3.1-flash-lite";

/** Базовый URL Gemini REST API */
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Дефолтный системный промпт, если персонаж не выбран.
 * Используется как запасной вариант, если GLOBAL_SYSTEM_PROMPT не задан в env.
 */
const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

/** Порог сообщений, после которого запускается сжатие контекста */
const COMPRESS_THRESHOLD = 25;

/** Сколько старых сообщений сжимать в резюме */
const COMPRESS_COUNT = 20;

// ============================================================
// ТОЧКА ВХОДА CLOUDFLARE WORKER
// ============================================================

export default {
    async fetch(request, env) {
        // Принимаем только POST-запросы (Telegram Webhook шлёт именно их)
        if (request.method !== "POST") {
            return new Response("OK", { status: 200 });
        }

        try {
            const update = await request.json();
            await handleUpdate(update, env);
        } catch (e) {
            console.error("Ошибка обработки обновления:", e);
        }

        // Telegram ждёт 200 OK в любом случае
        return new Response("OK", { status: 200 });
    },
};

// ============================================================
// ГЛАВНЫЙ ДИСПЕТЧЕР ОБНОВЛЕНИЙ
// ============================================================

/**
 * Разбирает входящее обновление от Telegram и направляет
 * его в нужный обработчик.
 */
async function handleUpdate(update, env) {
    // Обработка нажатий на Inline-кнопки
    if (update.callback_query) {
        await handleCallbackQuery(update.callback_query, env);
        return;
    }

    // Обработка текстовых сообщений
    if (update.message) {
        await handleMessage(update.message, env);
        return;
    }
}

// ============================================================
// ОБРАБОТЧИК ТЕКСТОВЫХ СООБЩЕНИЙ
// ============================================================

async function handleMessage(message, env) {
    const chatId = message.chat.id;
    const text   = (message.text || "").trim();

    if (!text) return; // Игнорируем пустые / медиа-сообщения

    // --- Маршрутизация по командам ---

    if (text.startsWith("/start")) {
        await handleStart(chatId, env);
        return;
    }

    if (text.startsWith("/api ")) {
        await handleSetApiKey(chatId, text.slice(5).trim(), env);
        return;
    }

    if (text.startsWith("/create_char ")) {
        await handleCreateChar(chatId, text.slice(13).trim(), env);
        return;
    }

    if (text.startsWith("/edit_prompt ")) {
        await handleEditPrompt(chatId, text.slice(13).trim(), env);
        return;
    }

    // --- Обычное текстовое сообщение → отправляем в Gemini ---
    await handleChat(chatId, text, env);
}

// ============================================================
// КОМАНДА /start — приветствие и главное меню
// ============================================================

async function handleStart(chatId, env) {
    const welcomeText =
        `Привет! Я бот с поддержкой персонажей на базе Gemini AI.\n\n` +
        `Перед началом работы введи свой API-ключ Gemini:\n` +
        `<code>/api ВАШ_КЛЮЧ</code>\n\n` +
        `После этого ты сможешь создавать персонажей и общаться с ними!`;

    await sendMessage(chatId, welcomeText, mainMenuKeyboard(), env);
}

// ============================================================
// КОМАНДА /api — сохранение API-ключа Gemini
// ============================================================

async function handleSetApiKey(chatId, apiKey, env) {
    if (!apiKey) {
        await sendMessage(chatId, "❌ Ключ не может быть пустым. Пример:\n<code>/api AIza...</code>", null, env);
        return;
    }

    // Upsert: обновляем ключ если пользователь уже есть, иначе создаём запись
    await env.DB.prepare(
        `INSERT INTO users (chat_id, api_key) VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET api_key = excluded.api_key`
    ).bind(chatId, apiKey).run();

    await sendMessage(chatId, "✅ API-ключ сохранён! Теперь ты можешь общаться с ботом.", mainMenuKeyboard(), env);
}

// ============================================================
// КОМАНДА /create_char — создание персонажа
// Формат: /create_char Имя | Системный промпт
// ============================================================

async function handleCreateChar(chatId, input, env) {
    // Проверяем наличие API-ключа
    const user = await getUser(chatId, env);
    if (!user?.api_key) {
        await sendMessage(chatId, "🔑 Сначала введи API-ключ:\n<code>/api ВАШ_КЛЮЧ</code>", null, env);
        return;
    }

    const parts = input.split("|");
    if (parts.length < 2) {
        await sendMessage(
            chatId,
            "❌ Неверный формат. Используй:\n<code>/create_char Имя | Системный промпт</code>",
            null, env
        );
        return;
    }

    const name         = parts[0].trim();
    const systemPrompt = parts.slice(1).join("|").trim(); // Всё после первого "|"

    if (!name || !systemPrompt) {
        await sendMessage(chatId, "❌ Имя и промпт не могут быть пустыми.", null, env);
        return;
    }

    // Сохраняем персонажа в БД
    const result = await env.DB.prepare(
        `INSERT INTO characters (name, system_prompt, creator_id) VALUES (?, ?, ?)`
    ).bind(name, systemPrompt, chatId).run();

    const newCharId = result.meta.last_row_id;

    // Сразу делаем нового персонажа активным
    await setActiveCharacter(chatId, newCharId, env);

    await sendMessage(
        chatId,
        `✅ Персонаж <b>${escapeHtml(name)}</b> создан и выбран как активный!\n\n` +
        `📝 Промпт: <i>${escapeHtml(systemPrompt)}</i>`,
        mainMenuKeyboard(), env
    );
}

// ============================================================
// КОМАНДА /edit_prompt — редактирование промпта активного персонажа
// ============================================================

async function handleEditPrompt(chatId, newPrompt, env) {
    if (!newPrompt) {
        await sendMessage(chatId, "❌ Введи новый промпт. Пример:\n<code>/edit_prompt Ты злой волшебник...</code>", null, env);
        return;
    }

    const user = await getUser(chatId, env);
    if (!user?.char_id) {
        await sendMessage(chatId, "❌ Сначала выбери активного персонажа через 💬 Чат с персонажами.", null, env);
        return;
    }

    // Обновляем промпт только для персонажей, созданных этим пользователем
    const result = await env.DB.prepare(
        `UPDATE characters SET system_prompt = ? WHERE id = ? AND creator_id = ?`
    ).bind(newPrompt, user.char_id, chatId).run();

    if (result.meta.changes === 0) {
        await sendMessage(chatId, "❌ Не удалось обновить промпт. Персонаж не найден или принадлежит другому пользователю.", null, env);
        return;
    }

    // Очищаем контекст диалога с этим персонажем (промпт изменился — старый контекст неактуален)
    await clearContext(chatId, user.char_id, env);

    await sendMessage(
        chatId,
        `✅ Промпт обновлён! Контекст диалога очищен.\n\n📝 Новый промпт:\n<i>${escapeHtml(newPrompt)}</i>`,
        null, env
    );
}

// ============================================================
// ОБРАБОТЧИК INLINE-КНОПОК (callback_query)
// ============================================================

async function handleCallbackQuery(callbackQuery, env) {
    const chatId = callbackQuery.message.chat.id;
    const data   = callbackQuery.data || "";

    // Отвечаем на callback, чтобы убрать "часики" у кнопки
    await answerCallbackQuery(callbackQuery.id, env);

    if (data === "gallery") {
        // Галерея: показать персонажей для управления
        await showCharacterList(chatId, "gallery", env);
        return;
    }

    if (data === "chat") {
        // Чат: показать персонажей для выбора активного
        await showCharacterList(chatId, "chat", env);
        return;
    }

    if (data === "create") {
        await sendMessage(
            chatId,
            "➕ Создай персонажа командой:\n<code>/create_char Имя | Системный промпт</code>\n\nПример:\n<code>/create_char Пиратский Капитан | Ты пират Джек Воробей, говоришь с юмором и любишь ром.</code>",
            null, env
        );
        return;
    }

    if (data === "main_menu") {
        await sendMessage(chatId, "🏠 Главное меню", mainMenuKeyboard(), env);
        return;
    }

    // Выбор персонажа для активации: формат "select_char:<id>"
    if (data.startsWith("select_char:")) {
        const charId = parseInt(data.split(":")[1]);
        await handleSelectCharacter(chatId, charId, env);
        return;
    }

    // Удаление персонажа: формат "delete_char:<id>"
    if (data.startsWith("delete_char:")) {
        const charId = parseInt(data.split(":")[1]);
        await handleDeleteCharacter(chatId, charId, env);
        return;
    }
}

// ============================================================
// ПОКАЗ СПИСКА ПЕРСОНАЖЕЙ
// mode: "gallery" — управление, "chat" — выбор активного
// ============================================================

async function showCharacterList(chatId, mode, env) {
    const chars = await env.DB.prepare(
        `SELECT id, name, system_prompt FROM characters WHERE creator_id = ? ORDER BY id DESC`
    ).bind(chatId).all();

    if (!chars.results || chars.results.length === 0) {
        await sendMessage(
            chatId,
            "📭 У тебя пока нет персонажей.\n\nСоздай первого командой:\n<code>/create_char Имя | Промпт</code>",
            backToMenuKeyboard(), env
        );
        return;
    }

    // Строим Inline-клавиатуру из персонажей
    const buttons = chars.results.map(char => {
        const label = mode === "gallery"
            ? `🗑 ${char.name}` // В галерее показываем кнопку удаления
            : `💬 ${char.name}`;
        const callbackData = mode === "gallery"
            ? `delete_char:${char.id}`
            : `select_char:${char.id}`;
        return [{ text: label, callback_data: callbackData }];
    });

    // Добавляем кнопку "Назад"
    buttons.push([{ text: "🔙 Главное меню", callback_data: "main_menu" }]);

    const headerText = mode === "gallery"
        ? "🖼 Галерея персонажей\n(нажми на персонажа чтобы удалить его):"
        : "💬 Выбери персонажа для общения:";

    await sendMessage(chatId, headerText, { inline_keyboard: buttons }, env);
}

// ============================================================
// ВЫБОР АКТИВНОГО ПЕРСОНАЖА
// ============================================================

async function handleSelectCharacter(chatId, charId, env) {
    // Проверяем, что персонаж существует и принадлежит этому пользователю
    const char = await env.DB.prepare(
        `SELECT id, name FROM characters WHERE id = ? AND creator_id = ?`
    ).bind(charId, chatId).first();

    if (!char) {
        await sendMessage(chatId, "❌ Персонаж не найден.", null, env);
        return;
    }

    await setActiveCharacter(chatId, charId, env);

    await sendMessage(
        chatId,
        `✅ Персонаж <b>${escapeHtml(char.name)}</b> выбран!\n\nТеперь просто пиши сообщения — я отвечу от его лица.`,
        mainMenuKeyboard(), env
    );
}

// ============================================================
// УДАЛЕНИЕ ПЕРСОНАЖА
// ============================================================

async function handleDeleteCharacter(chatId, charId, env) {
    const char = await env.DB.prepare(
        `SELECT id, name FROM characters WHERE id = ? AND creator_id = ?`
    ).bind(charId, chatId).first();

    if (!char) {
        await sendMessage(chatId, "❌ Персонаж не найден.", null, env);
        return;
    }

    // Удаляем персонажа и его историю сообщений
    await env.DB.prepare(`DELETE FROM characters WHERE id = ? AND creator_id = ?`).bind(charId, chatId).run();
    await env.DB.prepare(`DELETE FROM messages WHERE chat_id = ? AND character_id = ?`).bind(chatId, charId).run();

    // Если удалённый персонаж был активным — сбрасываем
    const user = await getUser(chatId, env);
    if (user?.char_id === charId) {
        await setActiveCharacter(chatId, null, env);
    }

    await sendMessage(chatId, `🗑 Персонаж <b>${escapeHtml(char.name)}</b> удалён.`, mainMenuKeyboard(), env);
}

// ============================================================
// ОСНОВНАЯ ЛОГИКА ЧАТА С GEMINI
// ============================================================

async function handleChat(chatId, userText, env) {
    // 1. Получаем пользователя и проверяем API-ключ
    const user = await getUser(chatId, env);

    if (!user?.api_key) {
        await sendMessage(
            chatId,
            "🔑 Пожалуйста, введи свой API-ключ Gemini с помощью команды:\n<code>/api ВАШ_КЛЮЧ</code>",
            null, env
        );
        return;
    }

    // 2. Определяем активного персонажа и системный промпт
    let characterPrompt = DEFAULT_SYSTEM_PROMPT;
    let characterId     = null;
    let characterName   = "Ассистент";

    if (user.char_id) {
        const char = await env.DB.prepare(
            `SELECT id, name, system_prompt FROM characters WHERE id = ?`
        ).bind(user.char_id).first();

        if (char) {
            characterPrompt = char.system_prompt;
            characterId     = char.id;
            characterName   = char.name;
        }
    }

    // Собираем финальный промпт: глобальный секрет + промпт персонажа
    const systemPrompt = buildSystemPrompt(characterPrompt, env);

    // 3. Сохраняем сообщение пользователя в историю
    await saveMessage(chatId, characterId, "user", userText, env);

    // 4. Проверяем количество сообщений и при необходимости сжимаем старые
    await maybeCompressContext(chatId, characterId, user.api_key, systemPrompt, env);

    // 5. Загружаем всю историю диалога (после возможного сжатия)
    const history = await env.DB.prepare(
        `SELECT role, text FROM messages
         WHERE chat_id = ? AND (character_id = ? OR (character_id IS NULL AND ? IS NULL))
         ORDER BY timestamp ASC`
    ).bind(chatId, characterId, characterId).all();

    // История отсортирована от старых к новым (ORDER BY timestamp ASC)
    const contents = (history.results || [])
        .map(row => ({
            role: row.role,
            parts: [{ text: row.text }],
        }));

    // 6. Отправляем запрос в Gemini REST API
    let botReply = "";
    try {
        botReply = await callGemini(user.api_key, systemPrompt, contents);
    } catch (e) {
        console.error("Ошибка Gemini API:", e);
        await sendMessage(chatId, `❌ Ошибка при запросе к Gemini:\n<code>${escapeHtml(String(e))}</code>`, null, env);
        return;
    }

    // 7. Сохраняем ответ модели в историю
    await saveMessage(chatId, characterId, "model", botReply, env);

    // 8. Отправляем ответ пользователю
    const prefix = characterId ? `<b>${escapeHtml(characterName)}:</b>\n` : "";
    await sendMessage(chatId, prefix + escapeHtml(botReply), mainMenuKeyboard(), env);
}

// ============================================================
// ВЫЗОВ GEMINI REST API
// ============================================================

/**
 * Отправляет запрос к Gemini generateContent и возвращает текст ответа.
 *
 * @param {string} apiKey       — API-ключ пользователя
 * @param {string} systemPrompt — системная инструкция для модели
 * @param {Array}  contents     — история сообщений в формате Gemini
 * @returns {string} текст ответа модели
 */
async function callGemini(apiKey, systemPrompt, contents) {
    const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    const body = {
        system_instruction: {
            parts: [{ text: systemPrompt }],
        },
        contents,
        generationConfig: {
            temperature: 0.9,
            // maxOutputTokens не задан — модель сама определяет длину ответа
        },
    };

    const response = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json();

    // Извлекаем текст из ответа Gemini
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
        throw new Error("Gemini вернул пустой ответ: " + JSON.stringify(data));
    }

    return text;
}

// ============================================================
// СБОРКА СИСТЕМНОГО ПРОМПТА
// ============================================================

/**
 * Собирает итоговый системный промпт из двух частей:
 *   1. GLOBAL_SYSTEM_PROMPT — секрет из переменных окружения Cloudflare.
 *      Задаётся в Dashboard → Workers → Settings → Variables (тип: Secret).
 *      Пользователи его не видят и не могут изменить.
 *   2. characterPrompt — промпт конкретного персонажа (или дефолтный).
 *
 * Глобальный промпт идёт ПЕРВЫМ, чтобы его правила имели приоритет.
 * Если GLOBAL_SYSTEM_PROMPT не задан — используется только промпт персонажа.
 */
function buildSystemPrompt(characterPrompt, env) {
    const global = (env.GLOBAL_SYSTEM_PROMPT || "").trim();
    if (!global) return characterPrompt;
    return `${global}\n\n---\n\n${characterPrompt}`;
}

// ============================================================
// СЖАТИЕ КОНТЕКСТА
// ============================================================

/**
 * Проверяет количество сообщений в диалоге.
 * Если их больше COMPRESS_THRESHOLD — сжимает первые COMPRESS_COUNT
 * сообщений в одно краткое резюме через Gemini и заменяет их в БД.
 *
 * Резюме вставляется как пара user/model, чтобы соблюсти требование
 * Gemini API чередовать роли: user задаёт контекст, model подтверждает.
 */
async function maybeCompressContext(chatId, characterId, apiKey, systemPrompt, env) {
    // Считаем текущее количество сообщений в этом диалоге
    const countRow = await env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM messages
         WHERE chat_id = ? AND (character_id = ? OR (character_id IS NULL AND ? IS NULL))`
    ).bind(chatId, characterId, characterId).first();

    const totalCount = countRow?.cnt ?? 0;

    // Сжатие не нужно
    if (totalCount <= COMPRESS_THRESHOLD) return;

    // Берём COMPRESS_COUNT самых старых сообщений (по id, чтобы точно получить нужные)
    const oldRows = await env.DB.prepare(
        `SELECT id, role, text FROM messages
         WHERE chat_id = ? AND (character_id = ? OR (character_id IS NULL AND ? IS NULL))
         ORDER BY timestamp ASC, id ASC
         LIMIT ?`
    ).bind(chatId, characterId, characterId, COMPRESS_COUNT).all();

    const oldMessages = oldRows.results || [];
    if (oldMessages.length === 0) return;

    // Формируем читаемый текст диалога для передачи в Gemini
    const dialogText = oldMessages
        .map(m => `${m.role === "user" ? "Пользователь" : "Ассистент"}: ${m.text}`)
        .join("\n");

    // Промпт для сжатия — просим выделить только суть
    const compressionPrompt =
        `Ниже приведён фрагмент диалога. Составь краткое резюме на том же языке, ` +
        `сохранив ключевые факты, имена, решения и важные детали. ` +
        `Не добавляй ничего от себя, только сжатое содержание.\n\n` +
        `ДИАЛОГ:\n${dialogText}`;

    let summary = "";
    try {
        summary = await callGemini(apiKey, systemPrompt, [
            { role: "user", parts: [{ text: compressionPrompt }] },
        ]);
    } catch (e) {
        // Если сжатие не удалось — продолжаем без него, не прерываем диалог
        console.error("Ошибка сжатия контекста:", e);
        return;
    }

    // Удаляем сжатые сообщения из БД по их id
    const ids = oldMessages.map(m => m.id).join(",");
    await env.DB.prepare(
        `DELETE FROM messages WHERE id IN (${ids})`
    ).run();

    // Вставляем резюме как пару user/model в самое начало оставшейся истории
    // Используем timestamp = 0, чтобы резюме гарантированно стояло первым
    const summaryUserText =
        `[СВОДКА ПРЕДЫДУЩЕГО ДИАЛОГА]\n${summary}`;
    const summaryModelText =
        `Понял, учту всё вышесказанное и продолжу диалог с этим контекстом.`;

    await env.DB.prepare(
        `INSERT INTO messages (chat_id, character_id, role, text, timestamp) VALUES (?, ?, 'user', ?, 0)`
    ).bind(chatId, characterId, summaryUserText).run();

    await env.DB.prepare(
        `INSERT INTO messages (chat_id, character_id, role, text, timestamp) VALUES (?, ?, 'model', ?, 1)`
    ).bind(chatId, characterId, summaryModelText).run();

    console.log(`Контекст сжат: ${oldMessages.length} сообщений → 1 резюме (chat=${chatId}, char=${characterId})`);
}



/** Получить запись пользователя из БД */
async function getUser(chatId, env) {
    return await env.DB.prepare(
        `SELECT chat_id, api_key, char_id FROM users WHERE chat_id = ?`
    ).bind(chatId).first();
}

/** Установить активного персонажа для пользователя */
async function setActiveCharacter(chatId, charId, env) {
    await env.DB.prepare(
        `INSERT INTO users (chat_id, char_id) VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET char_id = excluded.char_id`
    ).bind(chatId, charId).run();
}

/** Сохранить сообщение в историю диалога */
async function saveMessage(chatId, characterId, role, text, env) {
    const timestamp = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
        `INSERT INTO messages (chat_id, character_id, role, text, timestamp) VALUES (?, ?, ?, ?, ?)`
    ).bind(chatId, characterId, role, text, timestamp).run();
}

/** Очистить историю диалога с конкретным персонажем */
async function clearContext(chatId, characterId, env) {
    await env.DB.prepare(
        `DELETE FROM messages WHERE chat_id = ? AND character_id = ?`
    ).bind(chatId, characterId).run();
}

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ — TELEGRAM API
// ============================================================

/**
 * Отправить сообщение в Telegram.
 *
 * @param {number} chatId   — ID чата
 * @param {string} text     — текст (HTML-разметка)
 * @param {object|null} replyMarkup — Inline-клавиатура или null
 * @param {object} env      — окружение Worker
 */
async function sendMessage(chatId, text, replyMarkup, env) {
    const url  = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`;
    const body = {
        chat_id:    chatId,
        text:       text,
        parse_mode: "HTML",
    };

    if (replyMarkup) {
        body.reply_markup = replyMarkup;
    }

    const res = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
    });

    if (!res.ok) {
        const err = await res.text();
        console.error("Ошибка sendMessage:", err);
    }
}

/** Ответить на callback_query (убирает "часики" у кнопки) */
async function answerCallbackQuery(callbackQueryId, env) {
    await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/answerCallbackQuery`,
        {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ callback_query_id: callbackQueryId }),
        }
    );
}

// ============================================================
// КЛАВИАТУРЫ
// ============================================================

/** Главное меню — Inline-кнопки */
function mainMenuKeyboard() {
    return {
        inline_keyboard: [
            [
                { text: "➕ Создать персонажа", callback_data: "create" },
                { text: "🖼️ Галерея",           callback_data: "gallery" },
            ],
            [
                { text: "💬 Чат с персонажами", callback_data: "chat" },
            ],
        ],
    };
}

/** Кнопка возврата в главное меню */
function backToMenuKeyboard() {
    return {
        inline_keyboard: [
            [{ text: "🔙 Главное меню", callback_data: "main_menu" }],
        ],
    };
}

// ============================================================
// УТИЛИТЫ
// ============================================================

/** Экранирование HTML-спецсимволов для parse_mode: HTML */
function escapeHtml(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}
