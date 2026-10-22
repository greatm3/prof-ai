import TelegramBot from "node-telegram-bot-api";
import { mdgramRich } from "@borodin/mdgram";
import { TELEGRAM_BOT_TOKEN } from "./config.js";
import { randWord } from "./state.js";
import { nimStream } from "./nim.js";
import { alertAdmin } from "./alerts.js";

export const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

export let botUsername = "";
try {
    const me = await bot.getMe();
    botUsername = me.username;
} catch (err) {
    console.error("✗ Telegram auth failed:", err.message);
    process.exit(1);
}

export function splitLong(text, max = 3800) {
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

function toRichHtml(markdown) {
    try {
        return mdgramRich(markdown, { paragraphMode: "br" });
    } catch {
        return null;
    }
}

export async function sendRichOrFallback(chatId, text, options = {}) {
    const html = toRichHtml(text);
    if (html) {
        try {
            return await bot.sendRichMessage(chatId, { html }, options);
        } catch (err) {
            console.warn("sendRichMessage failed, falling back:", err.message);
        }
    }
    return bot.sendMessage(chatId, text, options);
}

export async function downloadPhoto(fileId) {
    const link = await bot.getFileLink(fileId);
    const res = await fetch(link);
    if (!res.ok) throw new Error(`photo download failed: ${res.status}`);
    const buf = await res.arrayBuffer();
    return Buffer.from(buf).toString("base64");
}

export async function streamToTelegram(chatId, replyToId, apiMessages) {
    let messageId;
    try {
        const initial = await bot.sendMessage(chatId, `_${randWord()}…_`, {
            parse_mode: "Markdown",
            reply_to_message_id: replyToId,
            allow_sending_without_reply: true,
        });
        messageId = initial.message_id;
    } catch (err) {
        clearInterval(thinkTimer);
        console.error("stream error:", err.message);
        await alertAdmin("stream", err);
        await bot
            .editMessageText(`⚠️ ${err.message.slice(0, 300)}`, {
                chat_id: chatId,
                message_id: messageId,
            })
            .catch(() => {});
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
        const display = content.slice(-3900) || "…";
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
            if (!err.message?.includes("message is not modified"))
                editFailures++;
        }
        editing = false;
    }

    const thinkTimer = setInterval(() => {
        if (firstContent) return;
        bot.editMessageText(`_${randWord()}…_`, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
        }).catch(() => {});
    }, 2200);

    try {
        const stream = await nimStream(apiMessages);

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
        if (!firstContent && reasoning) {
            content = reasoning;
            reasoning = "";
            firstContent = true;
        }
        if (!firstContent) content = "_Hmm, I got nothing. Try rephrasing?_";
        await flush(true);

        await bot.deleteMessage(chatId, messageId).catch(() => {});
        for (const part of splitLong(content)) {
            await sendRichOrFallback(chatId, part, {
                reply_to_message_id: replyToId,
                allow_sending_without_reply: true,
            }).catch(() => {});
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
