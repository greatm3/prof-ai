import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";

// ─── NIM client ────────────────────────────────────────
const openai = new OpenAI({
    apiKey: process.env.NVIDIA_API_KEY,
    baseURL: "https://integrate.api.nvidia.com/v1",
});

const MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b";

// ─── Telegram client ──────────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

let botUsername = "";
try {
    const me = await bot.getMe();
    botUsername = me.username;
    console.log(`✓ Prof running as @${botUsername}`);
} catch (err) {
    console.error("✗ Telegram auth failed:", err.message);
    process.exit(1);
}

// ─── Personality ──────────────────────────────────────
const SYSTEM_PROMPT = `You are Prof — a sharp, friendly study partner that lives in a student's Telegram chat (often a class group).

Rules:
- Be concise. Every message should be readable on a phone in under 10 seconds.
- No giant tables. Plain paragraphs and short bullets.
- When analyzing an image: start with a one-line summary, then details. Never guess — if unsure, say so.
- When asked to quiz: format questions as "1.", "2.", … and put all answers at the very end after "Answers:" so the student can scroll past them.
- When explaining: teach, don't lecture. Assume they want to understand, not copy.
- Be warm but not cringe. At most one emoji per message.
- Never refer to yourself as "an AI model". You are Prof.`;

const THINKING_WORDS = [
    "musing",
    "cultivating",
    "gallivanting",
    "pondering",
    "conjuring",
    "weaving",
    "rummaging",
    "spelunking",
    "tinkering",
    "meandering",
    "deciphering",
    "foraging",
    "contemplating",
    "summoning",
    "distilling",
    "marinating",
    "percolating",
    "wandering",
    "whittling",
    "unraveling",
    "stewing",
    "sifting",
    "assembling",
    "reaching",
    "coaxing",
    "charting",
    "humming",
    "unfurling",
    "tracing",
    "threading",
    "sketching",
    "brewing",
    "gathering",
    "aligning",
    "sensing",
    "soliloquizing",
    "daydreaming",
    "noodling",
    "mulling",
    "simmering",
];

// ─── Per-chat memory ──────────────────────────────────
const chats = new Map();
function getChat(id) {
    if (!chats.has(id)) chats.set(id, { messages: [], lastReasoning: "" });
    return chats.get(id);
}

const randWord = () =>
    THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];

// ─── Text helpers ─────────────────────────────────────
function splitLong(text, max = 3800) {
    const parts = [];
    let rem = text;
    while (rem.length > max) {
        let cut = rem.lastIndexOf("\n\n", max);
        if (cut === -1) cut = rem.lastIndexOf("\n", max);
        if (cut === -1) cut = rem.lastIndexOf(" ", max);
        if (cut === -1) cut = max;
        parts.push(rem.slice(0, cut));
        rem = rem.slice(cut).replace(/^\n+/, "");
    }
    if (rem) parts.push(rem);
    return parts;
}

function escapeMarkdown(s) {
    return s.replace(/[_*`[\]()]/g, (c) => "\\" + c);
}

// ─── Photo download ───────────────────────────────────
async function downloadPhoto(fileId) {
    const link = await bot.getFileLink(fileId);
    const res = await fetch(link);
    if (!res.ok) throw new Error(`photo download failed: ${res.status}`);
    const buf = await res.arrayBuffer();
    return Buffer.from(buf).toString("base64");
}

// ─── Core: stream NIM → live-editing Telegram message ─
async function streamToTelegram(chatId, replyToId, apiMessages) {
    // 1. Send the initial "thinking…" placeholder
    let messageId;
    try {
        const initial = await bot.sendMessage(chatId, `_${randWord()}…_`, {
            parse_mode: "Markdown",
            reply_to_message_id: replyToId,
            allow_sending_without_reply: true,
        });
        messageId = initial.message_id;
    } catch (err) {
        console.error("sendMessage failed:", err.message);
        return { content: "", reasoning: "" };
    }

    let content = "";
    let reasoning = "";
    let firstContent = false;
    let lastEditAt = 0;
    let lastEdited = "";
    let editing = false;
    let editFailures = 0;

    async function flush(force = false) {
        if (editing || !firstContent || editFailures > 3) return;
        const now = Date.now();
        if (!force && now - lastEditAt < 900) return;

        const display = content.slice(-3900) || "…"; // show tail for very long answers
        if (display === lastEdited && !force) return;

        editing = true;
        try {
            await bot.editMessageText(display, {
                chat_id: chatId,
                message_id: messageId,
            });
            lastEdited = display;
            lastEditAt = Date.now();
        } catch (err) {
            if (
                err.message &&
                err.message.includes("message is not modified")
            ) {
                // ignore — same content
            } else {
                editFailures++;
            }
        }
        editing = false;
    }

    // rotate thinking word while waiting for first content
    const thinkTimer = setInterval(() => {
        if (firstContent) return;
        bot.editMessageText(`_${randWord()}…_`, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
        }).catch(() => {});
    }, 2200);

    try {
        const stream = await openai.chat.completions.create({
            model: MODEL,
            messages: apiMessages,
            temperature: 1,
            top_p: 0.95,
            max_tokens: 8192,
            stream: true,
            chat_template_kwargs: {
                enable_thinking: true,
                force_nonempty_content: true,
            },
        });

        for await (const chunk of stream) {
            const d = chunk.choices?.[0]?.delta;
            if (!d) continue;

            if (d.reasoning_content) reasoning += d.reasoning_content;

            if (d.content) {
                if (!firstContent) {
                    firstContent = true;
                    clearInterval(thinkTimer);
                }
                content += d.content;
                await flush();
            }
        }

        clearInterval(thinkTimer);

        // fallback: reasoning-only answer (rare with force_nonempty_content)
        if (!firstContent && reasoning) {
            content = reasoning;
            reasoning = "";
            firstContent = true;
        }
        if (!firstContent) content = "_Hmm, I got nothing. Try rephrasing?_";
        await flush(true);

        // 2. Final polish: re-send with Markdown formatting if possible
        if (content.length < 3900) {
            try {
                await bot.sendMessage(chatId, content, {
                    parse_mode: "Markdown",
                    reply_to_message_id: replyToId,
                    allow_sending_without_reply: true,
                });
                await bot.deleteMessage(chatId, messageId).catch(() => {});
                return { content, reasoning };
            } catch {
                // markdown parse failed — leave the plain version
            }
        }

        // 3. Too long → split into multiple messages
        if (content.length >= 3900) {
            await bot.deleteMessage(chatId, messageId).catch(() => {});
            for (const part of splitLong(content)) {
                await bot
                    .sendMessage(chatId, part, {
                        reply_to_message_id: replyToId,
                        allow_sending_without_reply: true,
                    })
                    .catch(() => {});
            }
        }

        return { content, reasoning };
    } catch (err) {
        clearInterval(thinkTimer);
        console.error("stream error:", err.message);
        await bot
            .editMessageText(`⚠️ ${err.message.slice(0, 300)}`, {
                chat_id: chatId,
                message_id: messageId,
            })
            .catch(() => {});
        return { content: "", reasoning: "" };
    }
}

// ─── Welcome text ─────────────────────────────────────
const WELCOME_PRIVATE = `👋 Hey, I'm *Prof* — your study partner.

📚 *Ask me anything* — I explain it clearly, not textbook-y.
📸 *Send a photo* — homework, notes, whiteboards, charts. I read them.
🧪 \`/quiz <topic>\` — I'll test you. Great with friends.
🧠 \`/why\` — see how I actually thought it through.
🔄 \`/reset\` — start fresh.

⚡ Free. Fast. No signup.
Built for our class 🎓 — powered by NVIDIA NIM 🚀`;

const WELCOME_GROUP = `👋 Hey! I'm *Prof* — your study partner.

📚 Mention me (@${botUsername}) or reply to me to chat.
📸 Or just *send a photo* of your notes, homework, or a whiteboard — I'll explain it.
🧪 \`/quiz <topic>\` — 5-question test, great for group review.
🧠 \`/why\` — see my reasoning for the last answer.

_I log messages so the admin can improve me._`;

// ─── Commands ─────────────────────────────────────────
bot.onText(/^\/start/, (msg) => {
    const isGroup = msg.chat.type !== "private";
    bot.sendMessage(msg.chat.id, isGroup ? WELCOME_GROUP : WELCOME_PRIVATE, {
        parse_mode: "Markdown",
        reply_to_message_id: msg.message_id,
        allow_sending_without_reply: true,
    }).catch(() => {});
});

bot.onText(/^\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, "Type /start to see what I can do.", {
        reply_to_message_id: msg.message_id,
        allow_sending_without_reply: true,
    }).catch(() => {});
});

bot.onText(/^\/reset/, (msg) => {
    const c = getChat(msg.chat.id);
    c.messages = [];
    c.lastReasoning = "";
    bot.sendMessage(msg.chat.id, "Fresh slate. What are we working on?", {
        reply_to_message_id: msg.message_id,
        allow_sending_without_reply: true,
    }).catch(() => {});
});

bot.onText(/^\/why/, (msg) => {
    const c = getChat(msg.chat.id);
    if (!c.lastReasoning) {
        return bot
            .sendMessage(
                msg.chat.id,
                "I don't have reasoning saved from my last response.",
                {
                    reply_to_message_id: msg.message_id,
                    allow_sending_without_reply: true,
                },
            )
            .catch(() => {});
    }
    const text = `🧠 Last reasoning:\n\n${c.lastReasoning.slice(0, 3800)}`;
    bot.sendMessage(msg.chat.id, text, {
        reply_to_message_id: msg.message_id,
        allow_sending_without_reply: true,
    }).catch(() => {});
});

bot.onText(/^\/quiz(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const topic =
        (match[1] || "").trim() || "any topic you think is interesting";

    const chat = getChat(chatId);
    const prompt = `Generate a 5-question quiz on: ${topic}

Format:
1. Question?
2. Question?
3. Question?
4. Question?
5. Question?

Answers:
1. Answer
2. Answer
3. Answer
4. Answer
5. Answer`;

    chat.messages.push({ role: "user", content: prompt });

    bot.sendChatAction(chatId, "typing").catch(() => {});
    const typing = setInterval(
        () => bot.sendChatAction(chatId, "typing").catch(() => {}),
        4500,
    );

    const result = await streamToTelegram(chatId, msg.message_id, [
        { role: "system", content: SYSTEM_PROMPT },
        ...chat.messages,
    ]);

    clearInterval(typing);
    if (result.content) {
        chat.messages.push({ role: "assistant", content: result.content });
        chat.lastReasoning = result.reasoning;
    } else {
        chat.messages.pop(); // drop the failed prompt
    }
});

// ─── Main message handler (text + photos) ─────────────
bot.on("message", async (msg) => {
    if (msg.from?.is_bot) return;
    if (msg.text?.startsWith("/")) return; // commands handled above

    const chatId = msg.chat.id;
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    const rawText = msg.text || msg.caption || "";
    const isPhoto = !!msg.photo;

    if (isGroup) {
        const mentioned = rawText.includes("@" + botUsername);
        const isReplyToBot =
            msg.reply_to_message?.from?.username === botUsername;
        if (!mentioned && !isReplyToBot) return;
    }

    if (!rawText && !isPhoto) return;

    const cleanText = rawText
        .replace(new RegExp(`@${botUsername}`, "g"), "")
        .trim();
    const chat = getChat(chatId);

    // Build user turn
    if (isPhoto) {
        const photo = msg.photo[msg.photo.length - 1];
        try {
            bot.sendChatAction(chatId, "upload_photo").catch(() => {});
            const base64 = await downloadPhoto(photo.file_id);
            chat.messages.push({
                role: "user",
                content: [
                    {
                        type: "text",
                        text:
                            cleanText ||
                            "What is in this image? Summarize it and point out anything important.",
                    },
                    {
                        type: "image_url",
                        image_url: { url: `data:image/jpeg;base64,${base64}` },
                    },
                ],
            });
        } catch (err) {
            console.error("photo download error:", err.message);
            return bot
                .sendMessage(
                    chatId,
                    `Couldn't download that photo: ${err.message}`,
                    {
                        reply_to_message_id: msg.message_id,
                        allow_sending_without_reply: true,
                    },
                )
                .catch(() => {});
        }
    } else {
        chat.messages.push({ role: "user", content: cleanText });
    }

    // Keep typing indicator alive while streaming
    bot.sendChatAction(chatId, "typing").catch(() => {});
    const typing = setInterval(
        () => bot.sendChatAction(chatId, "typing").catch(() => {}),
        4500,
    );

    try {
        const result = await streamToTelegram(chatId, msg.message_id, [
            { role: "system", content: SYSTEM_PROMPT },
            ...chat.messages,
        ]);
        clearInterval(typing);
        if (result.content) {
            chat.messages.push({ role: "assistant", content: result.content });
            chat.lastReasoning = result.reasoning;
        } else {
            chat.messages.pop(); // drop the failed user turn
        }
    } catch (err) {
        clearInterval(typing);
        console.error("message handler error:", err.message);
    }
});

// ─── Global error handling ────────────────────────────
bot.on("polling_error", (err) => {
    console.error("polling_error:", err.code || err.message);
});

process.on("SIGINT", () => {
    console.log("\nShutting down Prof…");
    bot.stopPolling().finally(() => process.exit(0));
});

process.on("unhandledRejection", (err) => {
    console.error("unhandledRejection:", err);
});
