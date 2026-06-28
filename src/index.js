/**
 * Telegram-бот на Cloudflare Workers + D1 + Gemini API
 * UI изменен на Reply-клавиатуры (кнопки под полем ввода).
 * Добавлена команда /help и улучшена навигация.
 */

// ============================================================
// КОНСТАНТЫ
// ============================================================

const GEMINI_MODEL = "gemini-2.0-flash-lite";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";
const COMPRESS_THRESHOLD = 25;
const COMPRESS_COUNT = 20;

// ============================================================
// ТОЧКА ВХОДА CLOUDFLARE WORKER
// ============================================================

export default {
    async fetch(request, env) {
        if (request.method !== "POST") {
            return new Response("OK", { status: 200 });
        }

        try {
            const update = await request.json();
            await handleUpdate(update, env);
        } catch (e) {
            console.error("Ошибка обработки обновления:", e);
        }

        return new Response("OK", { status: 200 });
    },
};

// ============================================================
// ГЛАВНЫЙ ДИСПЕТЧЕР ОБНОВЛЕНИЙ
// ============================================================

async function handleUpdate(update, env) {
    if (update.callback_query) {
        await handleCallbackQuery(update.callback_query, env);
        return;
    }

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

    if (!text) return;

    // --- Команды ---
    if (text.startsWith("/start")) {
        await clearState(chatId, env);
        await handleStart(chatId, env);
        return;
    }

    if (text === "/help" || text.startsWith("/help")) {
        await handleHelp(chatId, env);
        return;
    }

    if (text === "/cancel") {
        await clearState(chatId, env);
        await sendMessage(chatId, "❌ Отменено.", mainMenuKeyboard(), env);
        return;
    }

    if (text.startsWith("/api ")) {
        await handleSetApiKey(chatId, text.slice(5).trim(), env);
        return;
    }

    // --- Проверяем активное состояние ---
    const state = await getState(chatId, env);
    if (state) {
        await handleState(chatId, text, state, env);
        return;
    }

    // --- Навигация по Reply-кнопкам ---
    if (text === "➕ Создать персонажа") {
        await sendMessage(chatId, "➕ <b>Создание персонажа</b>\n\nКак хочешь создать?", createMenuKeyboard(), env);
        return;
    }

    if (text === "✏️ Вручную") return await startCreateWizard(chatId, env);
    if (text === "🤖 Сгенерировать AI") return await startGenWizard(chatId, env);

    if (text === "🖼️ Галерея") return await showCharacterList(chatId, "gallery", env);
    if (text === "💬 Чат с персонажами") return await showCharacterList(chatId, "chat", env);
    
    if (text === "⚙️ Настройки") return await showSettings(chatId, env);

    if (text === "✏️ Изменить имя") {
        await setState(chatId, "set_user_name", {}, env);
        await sendMessage(chatId, "✏️ Введи имя, которое бот будет использовать для тебя (или /cancel):", hideKeyboard(), env);
        return;
    }

    if (text === "📝 Изменить описание") {
        await setState(chatId, "set_user_desc", {}, env);
        await sendMessage(chatId, "📝 Опиши себя (характер, внешность, как бот должен к тебе относиться). Или /cancel:", hideKeyboard(), env);
        return;
    }

    if (text === "🌐 Язык ответов") {
        await sendMessage(chatId, "Выбери язык ответов:", languageMenuKeyboard(), env);
        return;
    }

    if (text === "📏 Длина ответов") {
        await sendMessage(chatId, "Выбери длину ответов:", lengthMenuKeyboard(), env);
        return;
    }

    if (text === "🇷🇺 Русский" || text === "🇬🇧 English" || text === "🇪🇸 Español") {
        const lang = text.split(" ")[1];
        await updateUserField(chatId, "language", lang, env);
        await showSettings(chatId, env);
        return;
    }

    if (text === "Короткие" || text === "Средние" || text === "Длинные") {
        await updateUserField(chatId, "answer_length", text, env);
        await showSettings(chatId, env);
        return;
    }

    if (text === "🔙 Главное меню" || text === "🔙 Назад") {
        await clearState(chatId, env);
        await sendMessage(chatId, "🏠 Главное меню", mainMenuKeyboard(), env);
        return;
    }

    // --- Обычное текстовое сообщение → отправляем в Gemini ---
    await handleChat(chatId, text, env);
}

// ============================================================
// КОМАНДЫ /start И /help
// ============================================================

async function handleStart(chatId, env) {
    const user = await getUser(chatId, env);
    let welcomeText = `👋 Привет! Я RP-бот с поддержкой персонажей на базе Gemini AI.\n\n`;
    
    if (!user?.api_key) {
        welcomeText += `🔑 Перед началом работы введи свой API-ключ Gemini:\n<code>/api ВАШ_КЛЮЧ</code>\n\n`;
    } else {
        welcomeText += `Ты можешь создавать персонажей, общаться с ними и настраивать свой профиль в <b>⚙️ Настройках</b>.\n\n`;
    }
    welcomeText += `Введи /help, чтобы узнать подробности.`;

    await sendMessage(chatId, welcomeText, mainMenuKeyboard(), env);
}

async function handleHelp(chatId, env) {
    const helpText = `🤖 <b>Помощь по боту</b>\n\n` +
        `Этот бот позволяет создавать уникальных AI-персонажей и общаться с ними с помощью Gemini API.\n\n` +
        `<b>Основные разделы (кнопки внизу):</b>\n` +
        `➕ <b>Создать персонажа</b> — создание вручную или генерация через AI.\n` +
        `🖼️ <b>Галерея</b> — просмотр и удаление ваших персонажей.\n` +
        `💬 <b>Чат с персонажами</b> — выбор персонажа для диалога.\n` +
        `⚙️ <b>Настройки</b> — настройка имени, описания, языка и длины ответов.\n\n` +
        `<b>Команды:</b>\n` +
        `/start — перезапустить бота и показать главное меню\n` +
        `/help — показать это сообщение\n` +
        `/cancel — отменить текущее действие (если бот ждет ввод текста)\n` +
        `/api [ключ] — установить API-ключ Gemini`;
    
    await sendMessage(chatId, helpText, mainMenuKeyboard(), env);
}

// ============================================================
// СОХРАНЕНИЕ API-КЛЮЧА
// ============================================================

async function handleSetApiKey(chatId, apiKey, env) {
    if (!apiKey) {
        await sendMessage(chatId, "❌ Ключ не может быть пустым. Пример:\n<code>/api AIza...</code>", null, env);
        return;
    }

    await env.DB.prepare(
        `INSERT INTO users (chat_id, api_key) VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET api_key = excluded.api_key`
    ).bind(chatId, apiKey).run();

    await sendMessage(chatId, "✅ API-ключ сохранён! Теперь ты можешь общаться с ботом.", mainMenuKeyboard(), env);
}

// ============================================================
// ПОШАГОВЫЕ ДЕЙСТВИЯ
// ============================================================

function buildCharacterPrompt(name, description) {
    return `Ты — ${name}.\n\n${description}\n\nОставайся в образе персонажа всегда. Отвечай от первого лица, соответствуй описанию выше.`;
}

async function startCreateWizard(chatId, env) {
    const user = await getUser(chatId, env);
    if (!user?.api_key) {
        await sendMessage(chatId, "🔑 Сначала введи API-ключ:\n<code>/api ВАШ_КЛЮЧ</code>", mainMenuKeyboard(), env);
        return;
    }
    await setState(chatId, "create_name", {}, env);
    await sendMessage(chatId, "➕ <b>Создание персонажа</b>\n\nШаг 1/2: Введи <b>имя</b> персонажа\n\n/cancel — отменить", hideKeyboard(), env);
}

async function startGenWizard(chatId, env) {
    const user = await getUser(chatId, env);
    if (!user?.api_key) {
        await sendMessage(chatId, "🔑 Сначала введи API-ключ:\n<code>/api ВАШ_КЛЮЧ</code>", mainMenuKeyboard(), env);
        return;
    }
    await setState(chatId, "gen_name", {}, env);
    await sendMessage(chatId, "🤖 <b>Генерация персонажа</b>\n\nШаг 1/2: Введи <b>имя</b> персонажа\n\n/cancel — отменить", hideKeyboard(), env);
}

async function handleState(chatId, text, state, env) {
    const { step, data } = state;

    if (step === "create_name") {
        await setState(chatId, "create_desc", { name: text }, env);
        await sendMessage(chatId, `✏️ Имя: <b>${escapeHtml(text)}</b>\n\nШаг 2/2: Введи <b>описание</b> персонажа.\n\n/cancel — отменить`, null, env);
        return;
    }

    if (step === "create_desc") {
        const name = data.name;
        const description = text;
        const prompt = buildCharacterPrompt(name, description);

        const result = await env.DB.prepare(
            `INSERT INTO characters (name, system_prompt, creator_id) VALUES (?, ?, ?)`
        ).bind(name, prompt, chatId).run();

        await setActiveCharacter(chatId, result.meta.last_row_id, env);
        await clearState(chatId, env);

        await sendMessage(chatId, `✅ Персонаж <b>${escapeHtml(name)}</b> создан и выбран!`, mainMenuKeyboard(), env);
        return;
    }

    if (step === "gen_name") {
        await setState(chatId, "gen_idea", { name: text }, env);
        await sendMessage(chatId, `✏️ Имя: <b>${escapeHtml(text)}</b>\n\nШаг 2/2: Опиши идею персонажа вкратце.\n\n/cancel — отменить`, null, env);
        return;
    }

    if (step === "gen_idea") {
        const name = data.name;
        const idea = text;
        const user = await getUser(chatId, env);

        await sendMessage(chatId, "⏳ Генерирую персонажа...", null, env);

        const genSystemPrompt = (env.GEN_SYSTEM_PROMPT || "").trim() ||
            "Ты — генератор персонажей для ролевых игр. Создавай детальные описания на языке запроса.";

        const genContents = [{ role: "user", parts: [{ text: `Создай описание персонажа по имени «${name}». Идея: ${idea}` }] }];

        let description = "";
        try {
            description = await callGemini(user.api_key, genSystemPrompt, genContents);
        } catch (e) {
            await clearState(chatId, env);
            await sendMessage(chatId, `❌ Ошибка генерации:\n<code>${escapeHtml(String(e))}</code>`, mainMenuKeyboard(), env);
            return;
        }

        const prompt = buildCharacterPrompt(name, description);
        const result = await env.DB.prepare(
            `INSERT INTO characters (name, system_prompt, creator_id) VALUES (?, ?, ?)`
        ).bind(name, prompt, chatId).run();

        await setActiveCharacter(chatId, result.meta.last_row_id, env);
        await clearState(chatId, env);

        await sendMessage(chatId, `✅ Персонаж <b>${escapeHtml(name)}</b> сгенерирован и выбран!\n\n📝 <i>${escapeHtml(description)}</i>`, mainMenuKeyboard(), env);
        return;
    }

    if (step === "set_user_name") {
        await updateUserField(chatId, "user_name", text, env);
        await clearState(chatId, env);
        await sendMessage(chatId, `✅ Твое имя сохранено: <b>${escapeHtml(text)}</b>`, settingsMenuKeyboard(), env);
        return;
    }

    if (step === "set_user_desc") {
        await updateUserField(chatId, "user_description", text, env);
        await clearState(chatId, env);
        await sendMessage(chatId, `✅ Твое описание сохранено!`, settingsMenuKeyboard(), env);
        return;
    }
}

// ============================================================
// НАСТРОЙКИ ПОЛЬЗОВАТЕЛЯ
// ============================================================

async function showSettings(chatId, env) {
    const user = await getUser(chatId, env);
    
    const name = user?.user_name || "Не задано";
    const desc = user?.user_description || "Не задано";
    const lang = user?.language || "Русский";
    const length = user?.answer_length || "Средние";

    const text = `⚙️ <b>Твои настройки</b>\n\n` +
                 `👤 <b>Имя:</b> ${escapeHtml(name)}\n` +
                 `📝 <b>Описание:</b> ${escapeHtml(desc.slice(0, 50))}${desc.length > 50 ? "..." : ""}\n` +
                 `🌍 <b>Язык ответов:</b> ${lang}\n` +
                 `📏 <b>Длина ответов:</b> ${length}\n\n` +
                 `<i>Эти параметры применяются ко всем персонажам!</i>`;

    await sendMessage(chatId, text, settingsMenuKeyboard(), env);
}

// ============================================================
// ОБРАБОТЧИК INLINE-КНОПОК
// ============================================================

async function handleCallbackQuery(callbackQuery, env) {
    const chatId = callbackQuery.message.chat.id;
    const data   = callbackQuery.data || "";

    await answerCallbackQuery(callbackQuery.id, env);

    if (data.startsWith("select_char:")) {
        await handleSelectCharacter(chatId, parseInt(data.split(":")[1]), env);
        return;
    }

    if (data.startsWith("delete_char:")) {
        await handleDeleteCharacter(chatId, parseInt(data.split(":")[1]), env);
        return;
    }
}

// ============================================================
// ОСНОВНАЯ ЛОГИКА ЧАТА С GEMINI
// ============================================================

async function handleChat(chatId, userText, env) {
    const user = await getUser(chatId, env);

    if (!user?.api_key) {
        await sendMessage(chatId, "🔑 Пожалуйста, введи свой API-ключ Gemini:\n<code>/api ВАШ_КЛЮЧ</code>", null, env);
        return;
    }

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

    const systemPrompt = buildSystemPrompt(characterPrompt, user, env);

    await saveMessage(chatId, characterId, "user", userText, env);
    await maybeCompressContext(chatId, characterId, user.api_key, systemPrompt, env);

    const history = await env.DB.prepare(
        `SELECT role, text FROM messages
         WHERE chat_id = ? AND (character_id = ? OR (character_id IS NULL AND ? IS NULL))
         ORDER BY timestamp ASC`
    ).bind(chatId, characterId, characterId).all();

    const contents = (history.results || [])
        .map(row => ({ role: row.role, parts: [{ text: row.text }] }));

    let botReply = "";
    try {
        botReply = await callGemini(user.api_key, systemPrompt, contents);
    } catch (e) {
        await sendMessage(chatId, `❌ Ошибка при запросе к Gemini:\n<code>${escapeHtml(String(e))}</code>`, null, env);
        return;
    }

    await saveMessage(chatId, characterId, "model", botReply, env);

    const prefix = characterId ? `<b>${escapeHtml(characterName)}:</b>\n` : "";
    await sendMessage(chatId, prefix + escapeHtml(botReply), mainMenuKeyboard(), env);
}

// ============================================================
// ВЫЗОВ GEMINI REST API
// ============================================================

async function callGemini(apiKey, systemPrompt, contents) {
    const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    const body = {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { temperature: 0.9 },
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
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini вернул пустой ответ: " + JSON.stringify(data));

    return text;
}

// ============================================================
// СБОРКА СИСТЕМНОГО ПРОМПТА
// ============================================================

function buildSystemPrompt(characterPrompt, user, env) {
    const global = (env.GLOBAL_SYSTEM_PROMPT || "").trim();
    
    let userSettings = "";
    if (user) {
        userSettings += "\n\n--- НАСТРОЙКИ ПОЛЬЗОВАТЕЛЯ ---\n";
        if (user.user_name) userSettings += `Обращайся к пользователю по имени: ${user.user_name}.\n`;
        if (user.user_description) userSettings += `Информация о пользователе: ${user.user_description}\n`;
        
        const langMap = { "Русский": "ru", "English": "en", "Español": "es" };
        const langCode = langMap[user.language] || "ru";
        userSettings += `Отвечай на языке: ${user.language} (${langCode}).\n`;
        
        let lengthRule = "";
        if (user.answer_length === "Короткие") lengthRule = "Твои ответы должны быть очень краткими (1-2 предложения).";
        else if (user.answer_length === "Длинные") lengthRule = "Твои ответы должны быть развернутыми и детальными.";
        else lengthRule = "Твои ответы должны быть средней длины (3-5 предложений).";
        userSettings += lengthRule + "\n";
    }

    let finalPrompt = characterPrompt + userSettings;
    if (global) finalPrompt = `${global}\n\n---\n\n${finalPrompt}`;
    
    return finalPrompt;
}

// ============================================================
// СЖАТИЕ КОНТЕКСТА
// ============================================================

async function maybeCompressContext(chatId, characterId, apiKey, systemPrompt, env) {
    const countRow = await env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM messages
         WHERE chat_id = ? AND (character_id = ? OR (character_id IS NULL AND ? IS NULL))`
    ).bind(chatId, characterId, characterId).first();

    const totalCount = countRow?.cnt ?? 0;
    if (totalCount <= COMPRESS_THRESHOLD) return;

    const oldRows = await env.DB.prepare(
        `SELECT id, role, text FROM messages
         WHERE chat_id = ? AND (character_id = ? OR (character_id IS NULL AND ? IS NULL))
         ORDER BY timestamp ASC, id ASC LIMIT ?`
    ).bind(chatId, characterId, characterId, COMPRESS_COUNT).all();

    const oldMessages = oldRows.results || [];
    if (oldMessages.length === 0) return;

    const dialogText = oldMessages.map(m => `${m.role === "user" ? "Пользователь" : "Ассистент"}: ${m.text}`).join("\n");
    const compressionPrompt = `Составь краткое резюме диалога.\n\nДИАЛОГ:\n${dialogText}`;

    let summary = "";
    try {
        summary = await callGemini(apiKey, systemPrompt, [{ role: "user", parts: [{ text: compressionPrompt }] }]);
    } catch (e) {
        return;
    }

    const ids = oldMessages.map(m => m.id).join(",");
    await env.DB.prepare(`DELETE FROM messages WHERE id IN (${ids})`).run();

    await env.DB.prepare(`INSERT INTO messages (chat_id, character_id, role, text, timestamp) VALUES (?, ?, 'user', ?, 0)`)
        .bind(chatId, characterId, `[СВОДКА ПРЕДЫДУЩЕГО ДИАЛОГА]\n${summary}`).run();
    await env.DB.prepare(`INSERT INTO messages (chat_id, character_id, role, text, timestamp) VALUES (?, ?, 'model', ?, 1)`)
        .bind(chatId, characterId, `Понял, учту контекст.`).run();
}

// ============================================================
// УПРАВЛЕНИЕ БД И СОСТОЯНИЯМИ
// ============================================================

async function getState(chatId, env) {
    const row = await env.DB.prepare(`SELECT step, data FROM states WHERE chat_id = ?`).bind(chatId).first();
    if (!row) return null;
    return { step: row.step, data: row.data ? JSON.parse(row.data) : {} };
}

async function setState(chatId, step, data, env) {
    await env.DB.prepare(
        `INSERT INTO states (chat_id, step, data) VALUES (?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET step = excluded.step, data = excluded.data`
    ).bind(chatId, step, JSON.stringify(data)).run();
}

async function clearState(chatId, env) {
    await env.DB.prepare(`DELETE FROM states WHERE chat_id = ?`).bind(chatId).run();
}

async function getUser(chatId, env) {
    return await env.DB.prepare(
        `SELECT chat_id, api_key, char_id, language, user_name, user_description, answer_length FROM users WHERE chat_id = ?`
    ).bind(chatId).first();
}

async function setActiveCharacter(chatId, charId, env) {
    await env.DB.prepare(
        `INSERT INTO users (chat_id, char_id) VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET char_id = excluded.char_id`
    ).bind(chatId, charId).run();
}

async function updateUserField(chatId, field, value, env) {
    await env.DB.prepare(
        `INSERT INTO users (chat_id, ${field}) VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET ${field} = excluded.${field}`
    ).bind(chatId, value).run();
}

async function saveMessage(chatId, characterId, role, text, env) {
    const timestamp = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
        `INSERT INTO messages (chat_id, character_id, role, text, timestamp) VALUES (?, ?, ?, ?, ?)`
    ).bind(chatId, characterId, role, text, timestamp).run();
}

// ============================================================
// УПРАВЛЕНИЕ ПЕРСОНАЖАМИ
// ============================================================

async function showCharacterList(chatId, mode, env) {
    const chars = await env.DB.prepare(
        `SELECT id, name FROM characters WHERE creator_id = ? ORDER BY id DESC`
    ).bind(chatId).all();

    if (!chars.results || chars.results.length === 0) {
        await sendMessage(chatId, "📭 У тебя пока нет персонажей.\nНажми ➕ Создать персонажа.", null, env);
        return;
    }

    const buttons = chars.results.map(char => {
        const label = mode === "gallery" ? `🗑 ${char.name}` : `💬 ${char.name}`;
        const callbackData = mode === "gallery" ? `delete_char:${char.id}` : `select_char:${char.id}`;
        return [{ text: label, callback_data: callbackData }];
    });

    buttons.push([{ text: "🔙 Закрыть список", callback_data: "close_list" }]);

    const headerText = mode === "gallery" ? "🖼 Галерея персонажей\n(нажми чтобы удалить):" : "💬 Выбери персонажа для общения:";
    await sendMessage(chatId, headerText, { inline_keyboard: buttons }, env);
}

async function handleSelectCharacter(chatId, charId, env) {
    const char = await env.DB.prepare(`SELECT name FROM characters WHERE id = ? AND creator_id = ?`).bind(charId, chatId).first();
    if (!char) return await sendMessage(chatId, "❌ Персонаж не найден.", null, env);

    await setActiveCharacter(chatId, charId, env);
    await sendMessage(chatId, `✅ Персонаж <b>${escapeHtml(char.name)}</b> выбран! Пиши сообщения, и я отвечу от его лица.`, null, env);
}

async function handleDeleteCharacter(chatId, charId, env) {
    const char = await env.DB.prepare(`SELECT name FROM characters WHERE id = ? AND creator_id = ?`).bind(charId, chatId).first();
    if (!char) return await sendMessage(chatId, "❌ Персонаж не найден.", null, env);

    await env.DB.prepare(`DELETE FROM characters WHERE id = ? AND creator_id = ?`).bind(charId, chatId).run();
    await env.DB.prepare(`DELETE FROM messages WHERE chat_id = ? AND character_id = ?`).bind(chatId, charId).run();

    const user = await getUser(chatId, env);
    if (user?.char_id === charId) await setActiveCharacter(chatId, null, env);

    await sendMessage(chatId, `🗑 Персонаж <b>${escapeHtml(char.name)}</b> удалён.`, null, env);
}

// ============================================================
// TELEGRAM API HELPERS
// ============================================================

async function sendMessage(chatId, text, replyMarkup, env) {
    const url  = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`;
    const body = { chat_id: chatId, text: text, parse_mode: "HTML" };
    if (replyMarkup) body.reply_markup = replyMarkup;

    const res = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
    });

    if (!res.ok) console.error("Ошибка sendMessage:", await res.text());
}

async function answerCallbackQuery(callbackQueryId, env) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
}

// ============================================================
// КЛАВИАТУРЫ
// ============================================================

function mainMenuKeyboard() {
    return {
        keyboard: [
            [{ text: "➕ Создать персонажа" }, { text: "🖼️ Галерея" }],
            [{ text: "💬 Чат с персонажами" }, { text: "⚙️ Настройки" }]
        ],
        resize_keyboard: true
    };
}

function createMenuKeyboard() {
    return {
        keyboard: [
            [{ text: "✏️ Вручную" }, { text: "🤖 Сгенерировать AI" }],
            [{ text: "🔙 Главное меню" }]
        ],
        resize_keyboard: true
    };
}

function settingsMenuKeyboard() {
    return {
        keyboard: [
            [{ text: "✏️ Изменить имя" }, { text: "📝 Изменить описание" }],
            [{ text: "🌐 Язык ответов" }, { text: "📏 Длина ответов" }],
            [{ text: "🔙 Главное меню" }]
        ],
        resize_keyboard: true
    };
}

function languageMenuKeyboard() {
    return {
        keyboard: [
            [{ text: "🇷🇺 Русский" }, { text: "🇬🇧 English" }, { text: "🇪🇸 Español" }],
            [{ text: "🔙 Назад" }]
        ],
        resize_keyboard: true
    };
}

function lengthMenuKeyboard() {
    return {
        keyboard: [
            [{ text: "Короткие" }, { text: "Средние" }, { text: "Длинные" }],
            [{ text: "🔙 Назад" }]
        ],
        resize_keyboard: true
    };
}

function hideKeyboard() {
    return { remove_keyboard: true };
}

// ============================================================
// УТИЛИТЫ
// ============================================================

function escapeHtml(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
