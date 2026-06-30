/**
 * Telegram-бот на Cloudflare Workers + D1 + OpenRouter API
 * Модель: google/gemini-2.5-flash (или любая другая через OpenRouter)
 * СТАБИЛЬНАЯ ВЕРСИЯ: Устранены падения при блокировках безопасности,
 * решена проблема с чередованием ролей, оптимизирована работа с SQLite.
 * ИСПРАВЛЕНО: ReferenceError maxTokens, улучшена регулировка длины ответов.
 * ДОБАВЛЕНО: Динамическая работа с сюжетами, команды /clear, /plot, /plots
 * ИЗМЕНЕНО: Использование OpenRouter API вместо Google Gemini
 */

// ============================================================
// КОНСТАНТЫ
// ============================================================

// OpenRouter configuration
const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "thedrummer/cydonia-24b-v4.1"; // Можно заменить на любую модель OpenRouter

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";
const COMPRESS_THRESHOLD = 50; // Увеличено с 25 для лучшего запоминания
const COMPRESS_COUNT = 20;

// Лимиты токенов под каждую настройку длины ответа.
const LENGTH_TOKEN_MAP = {
    "Очень короткие": 10000,
    "Короткие": 10000,
    "Средние": 10000,
    "Длинные": 10000,
};

const LENGTH_FAKE_LIMIT_MAP = {
    "Очень короткие": 60,
    "Короткие": 180,
    "Средние": 500,
    "Длинные": 1200,
};

const DEFAULT_MAX_TOKENS = LENGTH_TOKEN_MAP["Средние"];

// Текстовые правила длины
const LENGTH_RULE_MAP = {
    "Очень короткие": () =>
        `СТРОГОЕ ПРАВИЛО ДЛИНЫ: Отвечай максимально кратко — как живой человек в мессенджере. ` +
        `1-3 коротких фразы, ориентируйся примерно на ${LENGTH_FAKE_LIMIT_MAP["Очень короткие"]} токенов. ` +
        `Можно отвечать одним-двумя предложениями, без длинных описаний и внутренних монологов.`,
    "Короткие": () =>
        `ПРАВИЛО ДЛИНЫ: Отвечай кратко — 2-4 предложения, ориентируйся примерно на ${LENGTH_FAKE_LIMIT_MAP["Короткие"]} токенов. ` +
        `Не добавляй лишних деталей, если пользователь не просит.`,
    "Средние": () =>
        `ПРАВИЛО ДЛИНЫ: Отвечай средней длины — 4-7 предложений, примерно до ${LENGTH_FAKE_LIMIT_MAP["Средние"]} токенов. ` +
        `Балансируй между краткостью и деталями.`,
    "Длинные": () =>
        `ПРАВИЛО ДЛИНЫ: Отвечай развёрнуто и детально. ` +
        `Используй описания, эмоции, детали окружения, внутренние мысли. ` +
        `Ориентируйся примерно на ${LENGTH_FAKE_LIMIT_MAP["Длинные"]} токенов.`,
};

// ============================================================
// ТОЧКА ВХОДА CLOUDFLARE WORKER
// ============================================================

export default {
    async fetch(request, env, ctx) {
        if (request.method !== "POST") {
            return new Response("OK", { status: 200 });
        }

        try {
            const update = await request.json();
            ctx.waitUntil(handleUpdate(update, env));
        } catch (e) {
            console.error("Ошибка инициализации:", e);
        }

        return new Response("OK", { status: 200 });
    },
};

// ============================================================
// ГЛАВНЫЙ ДИСПЕТЧЕР ОБНОВЛЕНИЙ (С ПЕРЕХВАТОМ ОШИБОК)
// ============================================================

async function handleUpdate(update, env) {
    try {
        if (update.callback_query) {
            await handleCallbackQuery(update.callback_query, env);
            return;
        }

        if (update.message) {
            await handleMessage(update.message, env);
            return;
        }
    } catch (e) {
        console.error("Глобальная ошибка обработки:", e);
        let chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id || update.callback_query?.from?.id;
        if (chatId) {
            try {
                await sendMessage(chatId, `❌ Произошла внутренняя ошибка:\n<code>${escapeHtml(String(e))}</code>`, null, env);
            } catch (err) {
                console.error("Не удалось отправить сообщение об ошибке пользователю:", err);
            }
        }
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

    if (text.startsWith("/help")) {
        await handleHelp(chatId, env);
        return;
    }

    if (text.startsWith("/myid")) {
        await sendMessage(chatId, `Твой Telegram ID: <code>${chatId}</code>`, null, env);
        return;
    }

    if (text.startsWith("/api ")) {
        let apiKey = text.slice(5).trim();
        apiKey = apiKey.replace(/\s+/g, "");
        await handleSetApiKey(chatId, apiKey, env);
        return;
    }

    // --- Команда для выбора модели OpenRouter ---
    if (text.startsWith("/model ")) {
        const model = text.slice(7).trim();
        if (!model) {
            await sendMessage(chatId, "❌ Укажи модель. Пример: /model anthropic/claude-3.5-sonnet", null, env);
            return;
        }
        await updateUserField(chatId, "model", model, env);
        await sendMessage(chatId, `✅ Модель изменена на: <code>${escapeHtml(model)}</code>`, mainMenuKeyboard(), env);
        return;
    }

    // --- НОВЫЕ КОМАНДЫ ДЛЯ РАБОТЫ С СЮЖЕТАМИ ---
    if (text.startsWith("/clear") || text.startsWith("/reset")) {
        const user = await getUser(chatId, env);
        if (!user?.char_id) {
            await sendMessage(chatId, "❌ Сначала выбери персонажа.", null, env);
            return;
        }
        await clearContext(chatId, user.char_id, env);
        await sendMessage(chatId, "✅ История диалога очищена. Можно начинать сначала!", mainMenuKeyboard(), env);
        return;
    }

    if (text.startsWith("/plot ")) {
        const plotName = text.slice(6).trim();
        if (!plotName) {
            await sendMessage(chatId, "❌ Укажи название сюжета. Пример: /plot Мой новый сюжет", null, env);
            return;
        }
        
        const user = await getUser(chatId, env);
        if (!user?.char_id) {
            await sendMessage(chatId, "❌ Сначала выбери персонажа.", null, env);
            return;
        }
        
        // Ищем сюжет по названию
        const plot = await env.DB.prepare(
            `SELECT id FROM plots WHERE name LIKE ? AND character_id = ? AND creator_id = ?`
        ).bind(`%${plotName}%`, user.char_id, chatId).first();
        
        if (!plot) {
            await sendMessage(chatId, `❌ Сюжет "${plotName}" не найден. Используй /plots чтобы увидеть список.`, null, env);
            return;
        }
        
        await env.DB.prepare(`UPDATE users SET plot_id = ? WHERE chat_id = ?`).bind(plot.id, chatId).run();
        
        // Очищаем контекст при смене сюжета для чистоты
        await clearContext(chatId, user.char_id, env);
        
        await sendMessage(chatId, `✅ Сюжет "${plotName}" выбран! История диалога очищена для нового сюжета.`, mainMenuKeyboard(), env);
        return;
    }

    if (text.startsWith("/plots")) {
        const user = await getUser(chatId, env);
        if (!user?.char_id) {
            await sendMessage(chatId, "❌ Сначала выбери персонажа.", null, env);
            return;
        }
        await showPlotMenu(chatId, env, "select");
        return;
    }

    // --- Кнопки выхода ---
    if (text.startsWith("/cancel") || text.includes("Главное меню")) {
        await clearState(chatId, env);
        await sendMessage(chatId, "🏠 Главное меню", mainMenuKeyboard(), env);
        return;
    }

    if (text.includes("Назад")) {
        await clearState(chatId, env);
        await showSettings(chatId, env);
        return;
    }

    // --- Проверяем активное состояние ---
    const state = await getState(chatId, env);
    if (state) {
        await handleState(chatId, text, state, env);
        return;
    }

    // --- Навигация по Reply-кнопкам ---
    if (text.includes("Создать персонажа")) {
        await sendMessage(chatId, "➕ <b>Создание персонажа</b>\n\nКак хочешь создать?", createMenuKeyboard(), env);
        return;
    }

    if (text.includes("Вручную")) return await startCreateWizard(chatId, env);
    if (text.includes("Сгенерировать AI")) return await startGenWizard(chatId, env);

    if (text.includes("Галерея")) return await showCharacterList(chatId, "gallery", env);
    if (text.includes("Чат с персонажами")) return await showCharacterList(chatId, "chat", env);
    if (text.includes("Сюжеты")) return await showPlotMenu(chatId, env, "select");

    if (text.includes("Настройки")) return await showSettings(chatId, env);
    if (text.includes("Мой статус")) return await showMyStatus(chatId, env);

    if (text.includes("Сбросить диалог")) {
        const user = await getUser(chatId, env);
        if (!user?.char_id) {
            await sendMessage(chatId, "❌ У тебя не выбран персонаж для сброса диалога.", null, env);
            return;
        }
        await clearContext(chatId, user.char_id, env);
        await sendMessage(chatId, "✅ Диалог с текущим персонажем очищен! Можно начать с чистого листа.", mainMenuKeyboard(), env);
        return;
    }

    if (text.includes("Изменить имя")) {
        await setState(chatId, "set_user_name", {}, env);
        await sendMessage(chatId, "✏️ Введи имя, которое бот будет использовать для тебя (или /cancel):", hideKeyboard(), env);
        return;
    }

    if (text.includes("Изменить описание")) {
        await setState(chatId, "set_user_desc", {}, env);
        await sendMessage(chatId, "📝 Опиши себя (характер, внешность, как бот должен к тебе относиться). Или /cancel:", hideKeyboard(), env);
        return;
    }

    if (text.includes("Язык ответов")) {
        await sendMessage(chatId, "Выбери язык ответов:", languageMenuKeyboard(), env);
        return;
    }

    if (text.includes("Длина ответов")) {
        await sendMessage(chatId, "Выбери длину ответов:", lengthMenuKeyboard(), env);
        return;
    }

    if (text.includes("Русский") || text.includes("English") || text.includes("Español")) {
        const parts = text.split(" ");
        const lang = parts.length > 1 ? parts[1] : parts[0];
        await updateUserField(chatId, "language", lang, env);
        await showSettings(chatId, env);
        return;
    }

    if (text.includes("Очень короткие") || text.includes("Короткие") || text.includes("Средние") || text.includes("Длинные")) {
        let lengthVal = text.replace(/⚡️|📏/g, "").trim();
        await updateUserField(chatId, "answer_length", lengthVal, env);
        await showSettings(chatId, env);
        return;
    }

    // --- Обычное текстовое сообщение → отправляем в ИИ ---
    await handleChat(chatId, text, env);
}

// ============================================================
// КОМАНДЫ /start И /help
// ============================================================

async function handleStart(chatId, env) {
    const user = await getUser(chatId, env);
    let welcomeText = `👋 Привет! Я RP-бот с поддержкой персонажей на базе ИИ через OpenRouter API.\n\n`;

    if (!user?.api_key) {
        welcomeText += `🔑 Перед началом работы введи свой API-ключ OpenRouter:\n<code>/api ВАШ_КЛЮЧ</code>\n\n`;
    } else {
        welcomeText += `Ты можешь создавать персонажей, сюжеты и общаться с ними.\n\n`;
    }
    welcomeText += `Введи /help, чтобы узнать подробности.`;

    await sendMessage(chatId, welcomeText, mainMenuKeyboard(), env);
}

async function handleHelp(chatId, env) {
    const helpText = `🤖 <b>Помощь по боту</b>\n\n` +
        `Этот бот позволяет создавать уникальных AI-персонажей и сюжеты для них.\n\n` +
        `<b>Основные разделы:</b>\n` +
        `➕ <b>Создать персонажа</b> — создание вручную или через AI.\n` +
        `🖼️ <b>Галерея</b> — просмотр и удаление персонажей.\n` +
        `💬 <b>Чат с персонажами</b> — выбор персонажа для диалога.\n` +
        `🎭 <b>Сюжеты</b> — создание и выбор сюжетов для активного персонажа.\n` +
        `🔄 <b>Сбросить диалог</b> — очистка истории чата с текущим персонажем.\n` +
        `📋 <b>Мой статус</b> — просмотр текущих настроек и выбранного персонажа.\n` +
        `⚙️ <b>Настройки</b> — профиль, язык и длина ответов.\n\n` +
        `<b>Команды:</b>\n` +
        `/start — перезапустить бота\n` +
        `/help — показать это сообщение\n` +
        `/cancel — отменить текущее действие\n` +
        `/myid — узнать свой Telegram ID\n` +
        `/api [ключ] — установить API-ключ OpenRouter\n` +
        `/model [название] — выбрать ИИ-модель\n` +
        `/clear — очистить историю диалога\n` +
        `/plot [название] — выбрать сюжет по названию\n` +
        `/plots — показать список сюжетов`;

    await sendMessage(chatId, helpText, mainMenuKeyboard(), env);
}

// ============================================================
// СОХРАНЕНИЕ API-КЛЮЧА
// ============================================================

async function handleSetApiKey(chatId, apiKey, env) {
    if (!apiKey) {
        await sendMessage(chatId, "❌ Ключ не может быть пустым. Пример:\n<code>/api sk-or-...</code>", null, env);
        return;
    }

    await env.DB.prepare(
        `INSERT INTO users (chat_id, api_key) VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET api_key = excluded.api_key`
    ).bind(chatId, apiKey).run();

    await sendMessage(chatId, "✅ API-ключ сохранён!", mainMenuKeyboard(), env);
}

// ============================================================
// МОЙ СТАТУС
// ============================================================

async function showMyStatus(chatId, env) {
    const user = await getUser(chatId, env);
    let statusText = "📋 <b>Твой текущий статус:</b>\n\n";

    if (user?.char_id) {
        const char = await env.DB.prepare(`SELECT name FROM characters WHERE id = ?`).bind(user.char_id).first();
        statusText += `🎭 <b>Персонаж:</b> ${char ? escapeHtml(char.name) : "Не найден"}\n`;
    } else {
        statusText += `🎭 <b>Персонаж:</b> Не выбран\n`;
    }

    if (user?.plot_id) {
        const plot = await env.DB.prepare(`SELECT name FROM plots WHERE id = ?`).bind(user.plot_id).first();
        statusText += `📖 <b>Сюжет:</b> ${plot ? escapeHtml(plot.name) : "Не найден"}\n`;
    } else {
        statusText += `📖 <b>Сюжет:</b> Не выбран\n`;
    }

    statusText += `🤖 <b>Модель:</b> <code>${escapeHtml(user?.model || DEFAULT_MODEL)}</code>\n`;

    statusText += `\n<b>Настройки:</b>\n` +
                  `👤 Имя: ${user?.user_name ? escapeHtml(user.user_name) : "Не задано"}\n` +
                  `🌍 Язык: ${user?.language || "Русский"}\n` +
                  `📏 Длина: ${user?.answer_length || "Средние"}\n`;

    await sendMessage(chatId, statusText, mainMenuKeyboard(), env);
}

// ============================================================
// ПОШАГОВЫЕ ДЕЙСТВИЯ
// ============================================================

function buildCharacterPrompt(name, description) {
    return `Ты — ${name}.\n\n${description}\n\nОставайся в образе персонажа всегда. Отвечай от первом лице, соответствуй описанию выше.`;
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
        await sendChatAction(chatId, "typing", env);

        const genSystemPrompt = (env.GEN_SYSTEM_PROMPT || "").trim() ||
            "Ты — генератор персонажей для ролевых игр. Создавай детальные описания на языке запроса.";

        const genContents = [{ role: "user", parts: [{ text: `Создай описание персонажа по имени «${name}». Идея: ${idea}` }] }];

        let description = "";
        try {
            description = await callGemini(user.api_key, genSystemPrompt, genContents, 800, DEFAULT_MODEL);
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

    if (step === "create_plot_name") {
        await setState(chatId, "create_plot_desc", { name: text }, env);
        await sendMessage(chatId, `✏️ Сюжет: <b>${escapeHtml(text)}</b>\n\nШаг 2/2: Введи <b>описание</b> сюжета.\nОпиши сеттинг, место действия, предысторию или текущую ситуацию.\n\n/cancel — отменить`, null, env);
        return;
    }

    if (step === "create_plot_desc") {
        const name = data.name;
        const description = text;
        const user = await getUser(chatId, env);

        const result = await env.DB.prepare(
            `INSERT INTO plots (creator_id, character_id, name, description) VALUES (?, ?, ?, ?)`
        ).bind(chatId, user.char_id, name, description).run();

        await env.DB.prepare(`UPDATE users SET plot_id = ? WHERE chat_id = ?`).bind(result.meta.last_row_id, chatId).run();
        await clearState(chatId, env);

        await sendMessage(chatId, `✅ Сюжет <b>${escapeHtml(name)}</b> создан и выбран!`, mainMenuKeyboard(), env);
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
// УПРАВЛЕНИЕ СЮЖЕТАМИ
// ============================================================

async function showPlotMenu(chatId, env, mode = "select") {
    const user = await getUser(chatId, env);
    if (!user?.char_id) {
        await sendMessage(chatId, "❌ Сначала выбери персонажа в разделе '💬 Чат с персонажами'.", null, env);
        return;
    }

    const plots = await env.DB.prepare(
        `SELECT id, name FROM plots WHERE character_id = ? AND creator_id = ? ORDER BY id DESC`
    ).bind(user.char_id, chatId).all();

    const buttons = [];
    if (plots.results && plots.results.length > 0) {
        plots.results.forEach(p => {
            const label = mode === "delete" ? `🗑 ${p.name}` : `🎭 ${p.name}`;
            const cbData = mode === "delete" ? `delete_plot:${p.id}` : `select_plot:${p.id}`;
            buttons.push([{ text: label, callback_data: cbData }]);
        });
    } else {
        buttons.push([{ text: "Пусто", callback_data: "ignore" }]);
    }

    if (mode === "select") {
        buttons.push([{ text: "➕ Создать сюжет", callback_data: "create_plot" }]);
        if (plots.results && plots.results.length > 0) {
            buttons.push([{ text: "🗑 Режим удаления", callback_data: "manage_plots" }]);
        }
    } else {
        buttons.push([{ text: "🔙 К выбору сюжета", callback_data: "select_plot_menu" }]);
    }
    buttons.push([{ text: "🔙 Закрыть", callback_data: "close_list" }]);

    const header = mode === "delete" ? "🗑 <b>Режим удаления сюжетов</b>\nНажми на сюжет, чтобы удалить его:" : "🎭 <b>Сюжеты персонажа</b>\nВыбери активный сюжет:";
    await sendMessage(chatId, header, { inline_keyboard: buttons }, env);
}

// ============================================================
// ОБРАБОТЧИК INLINE-КНОПОК
// ============================================================

async function handleCallbackQuery(callbackQuery, env) {
    const chatId = callbackQuery.message?.chat?.id || callbackQuery.from.id;
    const data   = callbackQuery.data || "";

    await answerCallbackQuery(callbackQuery.id, env);

    if (data === "ignore" || data === "close_list") return;

    if (data.startsWith("select_char:")) {
        await handleSelectCharacter(chatId, parseInt(data.split(":")[1]), env);
        return;
    }

    if (data.startsWith("delete_char:")) {
        await handleDeleteCharacter(chatId, parseInt(data.split(":")[1]), env);
        return;
    }

    if (data === "select_plot_menu") {
        await showPlotMenu(chatId, env, "select");
        return;
    }
    if (data === "manage_plots") {
        await showPlotMenu(chatId, env, "delete");
        return;
    }
    if (data === "create_plot") {
        const user = await getUser(chatId, env);
        if (!user?.char_id) return await sendMessage(chatId, "❌ Сначала выбери персонажа.", null, env);
        await setState(chatId, "create_plot_name", {}, env);
        await sendMessage(chatId, "➕ <b>Создание сюжета</b>\n\nШаг 1/2: Введи <b>название</b> сюжета\n\n/cancel — отменить", hideKeyboard(), env);
        return;
    }
    if (data.startsWith("select_plot:")) {
        const plotId = parseInt(data.split(":")[1]);
        const user = await getUser(chatId, env);
        await env.DB.prepare(`UPDATE users SET plot_id = ? WHERE chat_id = ?`).bind(plotId, chatId).run();
        
        // Очищаем контекст при выборе сюжета через кнопку
        if (user?.char_id) {
            await clearContext(chatId, user.char_id, env);
        }
        
        await sendMessage(chatId, "✅ Сюжет выбран! История диалога очищена для нового сюжета.", null, env);
        return;
    }
    if (data.startsWith("delete_plot:")) {
        const plotId = parseInt(data.split(":")[1]);
        await env.DB.prepare(`DELETE FROM plots WHERE id = ? AND creator_id = ?`).bind(plotId, chatId).run();
        const user = await getUser(chatId, env);
        if (user?.plot_id === plotId) {
            await env.DB.prepare(`UPDATE users SET plot_id = NULL WHERE chat_id = ?`).bind(chatId).run();
        }
        await showPlotMenu(chatId, env, "delete");
        return;
    }
}

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ ПОДГОТОВКИ ДИАЛОГА
// ============================================================

function prepareContents(historyResults) {
    if (!historyResults || historyResults.length === 0) return [];
    
    const contents = [];
    for (const row of historyResults) {
        const role = row.role === "model" ? "model" : "user";
        const text = row.text || "";
        
        if (contents.length > 0 && contents[contents.length - 1].role === role) {
            contents[contents.length - 1].parts[0].text += "\n" + text;
        } else {
            contents.push({ role, parts: [{ text }] });
        }
    }
    
    while (contents.length > 0 && contents[0].role !== "user") {
        contents.shift();
    }
    
    return contents;
}

// ============================================================
// ОСНОВНАЯ ЛОГИКА ЧАТА С OPENROUTER
// ============================================================

async function handleChat(chatId, userText, env) {
    const user = await getUser(chatId, env);

    if (!user?.api_key) {
        await sendMessage(chatId, "🔑 Пожалуйста, введи свой API-ключ OpenRouter:\n<code>/api ВАШ_КЛЮЧ</code>", null, env);
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

    // --- ОБНОВЛЕННАЯ ЛОГИКА ДОБАВЛЕНИЯ СЮЖЕТА ---
    if (user.plot_id) {
        const plot = await env.DB.prepare(`SELECT name, description FROM plots WHERE id = ? AND creator_id = ?`).bind(user.plot_id, chatId).first();
        if (plot) {
            // Более гибкая интеграция сюжета как исходной точки
            characterPrompt += `\n\n[ИСХОДНЫЙ СЮЖЕТ: "${plot.name}". Описание: "${plot.description}". ` +
                               `Используй это как основу мира и предысторию. ` +
                               `Развивай сюжет динамически, основываясь на действиях пользователя и истории диалога. ` +
                               `Не повторяй описание сюжета в каждом ответе - просто отыгрывай его.]`;
        }
    }

    const systemPrompt = buildSystemPrompt(characterPrompt, user, env);

    // Жёсткий лимит токенов под выбранную пользователем длину ответа.
    const maxTokens = LENGTH_TOKEN_MAP[user.answer_length] || DEFAULT_MAX_TOKENS;

    await saveMessage(chatId, characterId, "user", userText, env);
    await maybeCompressContext(chatId, characterId, user.api_key, systemPrompt, env);

    const history = await env.DB.prepare(
        `SELECT role, text FROM messages
         WHERE chat_id = ? AND character_id IS ?
         ORDER BY timestamp ASC`
    ).bind(chatId, characterId).all();

    const currentContents = prepareContents(history.results || []);

    let botReply = "";

    await sendChatAction(chatId, "typing", env);

    const modelToUse = user?.model || DEFAULT_MODEL;

    for (let attempt = 1; attempt <= 4; attempt++) {
        try {
            botReply = await callGemini(user.api_key, systemPrompt, currentContents, maxTokens, modelToUse);
        } catch (e) {
            await sendMessage(chatId, `❌ Ошибка при запросе к OpenRouter:\n<code>${escapeHtml(String(e))}</code>`, null, env);
            return;
        }

        if (botReply) break;

        console.log(`Попытка ${attempt}: пустой ответ от ИИ. Пробуем снова...`);
        
        if (attempt < 4) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    if (!botReply) {
        await sendMessage(chatId, "❌ ИИ вернул пустой ответ после 4 попыток. Попробуй переформулировать запрос.", null, env);
        return;
    }

    await saveMessage(chatId, characterId, "model", botReply, env);

    const prefix = characterId ? `<b>${escapeHtml(characterName)}:</b>\n` : "";
    await sendMessage(chatId, prefix + escapeHtml(botReply), mainMenuKeyboard(), env);
}

// ============================================================
// ВЫЗОВ OPENROUTER API
// ============================================================

async function callGemini(apiKey, systemPrompt, contents, maxOutputTokens, modelName = DEFAULT_MODEL) {
    const url = OPENROUTER_API_BASE;

    // Преобразуем структуру диалога в стандартный формат Chat Completions
    const messages = [];
    
    if (systemPrompt && systemPrompt.trim() !== "") {
        messages.push({ role: "system", content: systemPrompt });
    }

    if (contents && contents.length > 0) {
        for (const item of contents) {
            const role = item.role === "model" ? "assistant" : "user";
            const content = item.parts?.[0]?.text || "";
            messages.push({ role, content });
        }
    }

    const body = {
        model: modelName,
        messages: messages,
        temperature: 0.9,
        max_tokens: maxOutputTokens || DEFAULT_MAX_TOKENS,
    };

    const response = await fetch(url, {
        method:  "POST",
        headers: { 
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
        },
        body:    JSON.stringify(body),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json();

    if (data?.error) {
        throw new Error(`OpenRouter Error: ${data.error.message || JSON.stringify(data.error)}`);
    }

    const text = data?.choices?.[0]?.message?.content;

    if (!text) return null;

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
        const userLanguage = user.language || "Русский";
        const langCode = langMap[userLanguage] || "ru";
        userSettings += `Отвечай на языке: ${userLanguage} (${langCode}).\n`;

        const maxTokens = LENGTH_TOKEN_MAP[user.answer_length] || DEFAULT_MAX_TOKENS;

        const lengthKey = user.answer_length || "Средние";
        const ruleFn = LENGTH_RULE_MAP[lengthKey] || LENGTH_RULE_MAP["Средние"];
        const lengthRule = ruleFn(maxTokens);

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
         WHERE chat_id = ? AND character_id IS ?`
    ).bind(chatId, characterId).first();

    const totalCount = countRow?.cnt ?? 0;
    if (totalCount <= COMPRESS_THRESHOLD) return;

    const oldRows = await env.DB.prepare(
        `SELECT id, role, text FROM messages
         WHERE chat_id = ? AND character_id IS ?
         ORDER BY timestamp ASC, id ASC LIMIT ?`
    ).bind(chatId, characterId, COMPRESS_COUNT).all();

    const oldMessages = oldRows.results || [];
    if (oldMessages.length === 0) return;

    const dialogText = oldMessages.map(m => `${m.role === "user" ? "Пользователь" : "Ассистент"}: ${m.text}`).join("\n");
    const compressionPrompt = `Составь краткое резюме диалога.\n\nДИАЛОГ:\n${dialogText}`;

    let summary = "";
    try {
        summary = await callGemini(apiKey, systemPrompt, [{ role: "user", parts: [{ text: compressionPrompt }] }], 500, DEFAULT_MODEL);
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
        `SELECT chat_id, api_key, char_id, language, user_name, user_description, answer_length, plot_id, model FROM users WHERE chat_id = ?`
    ).bind(chatId).first();
}

async function setActiveCharacter(chatId, charId, env) {
    await env.DB.prepare(
        `INSERT INTO users (chat_id, char_id, plot_id) VALUES (?, ?, NULL)
         ON CONFLICT(chat_id) DO UPDATE SET char_id = excluded.char_id, plot_id = NULL`
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

async function clearContext(chatId, characterId, env) {
    if (characterId) {
        await env.DB.prepare(`DELETE FROM messages WHERE chat_id = ? AND character_id = ?`).bind(chatId, characterId).run();
    } else {
        // Если персонаж не выбран, очищаем все сообщения
        await env.DB.prepare(`DELETE FROM messages WHERE chat_id = ?`).bind(chatId).run();
    }
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
    await sendMessage(chatId, `✅ Персонаж <b>${escapeHtml(char.name)}</b> выбран!\nНе забудь выбрать сюжет в меню "🎭 Сюжеты", если нужно.`, null, env);
}

async function handleDeleteCharacter(chatId, charId, env) {
    const char = await env.DB.prepare(`SELECT name FROM characters WHERE id = ? AND creator_id = ?`).bind(charId, chatId).first();
    if (!char) return await sendMessage(chatId, "❌ Персонаж не найден.", null, env);

    await env.DB.prepare(`DELETE FROM characters WHERE id = ? AND creator_id = ?`).bind(charId, chatId).run();
    await env.DB.prepare(`DELETE FROM messages WHERE chat_id = ? AND character_id = ?`).bind(chatId, charId).run();
    await env.DB.prepare(`DELETE FROM plots WHERE character_id = ? AND creator_id = ?`).bind(charId, chatId).run();

    const user = await getUser(chatId, env);
    if (user?.char_id === charId) await setActiveCharacter(chatId, null, env);

    await sendMessage(chatId, `🗑 Персонаж <b>${escapeHtml(char.name)}</b> удалён.`, null, env);
}

// ============================================================
// TELEGRAM API HELPERS
// ============================================================

async function sendMessage(chatId, text, replyMarkup, env) {
    const maxLen = 4000; 
    let messagesToSend = [];

    if (text.length > maxLen) {
        let str = text;
        while (str.length > maxLen) {
            let splitIndex = str.lastIndexOf("\n", maxLen);
            if (splitIndex <= 0 || splitIndex > maxLen) {
                splitIndex = str.lastIndexOf(" ", maxLen);
            }
            if (splitIndex <= 0 || splitIndex > maxLen) {
                splitIndex = maxLen;
            }
            messagesToSend.push(str.slice(0, splitIndex));
            str = str.slice(splitIndex).trim();
        }
        if (str.length > 0) messagesToSend.push(str);
    } else {
        messagesToSend.push(text);
    }

    for (let i = 0; i < messagesToSend.length; i++) {
        const isLast = i === messagesToSend.length - 1;
        const url  = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`;
        const body = {
            chat_id: chatId,
            text: messagesToSend[i],
            parse_mode: "HTML"
        };
        if (isLast && replyMarkup) body.reply_markup = replyMarkup;

        const res = await fetch(url, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(body),
        });

        if (!res.ok) console.error("Ошибка sendMessage:", await res.text());
    }
}

async function sendChatAction(chatId, action, env) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, action: action })
    });
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
            [{ text: "💬 Чат с персонажами" }, { text: "🎭 Сюжеты" }],
            [{ text: "🔄 Сбросить диалог" }, { text: "📋 Мой статус" }],
            [{ text: "⚙️ Настройки" }]
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
            [{ text: "⚡️ Очень короткие" }, { text: "Короткие" }],
            [{ text: "Средние" }, { text: "Длинные" }],
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
