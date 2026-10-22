import {
    bot,
    botUsername,
    downloadPhoto,
    streamToTelegram,
    sendRichOrFallback,
} from "./telegram.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import {
    detectQuizIntent,
    detectPdfIntent,
    detectFlashcardIntent,
    PHOTO_REF,
} from "./intents.js";
import { getChat, activeQuizzes, activeDecks } from "./state.js";
import { triggerQuiz, handleQuizAnswer } from "./quiz.js";
import { triggerFlashcards, handleFlashcardAction } from "./flashcards.js";
import { upsertUser, logMessage } from "./db.js";
import { buildProgressReport } from "./analytics.js";
import { downloadVoice, transcribeVoice } from "./voice.js";
import {
    MAX_CONTEXT_MESSAGES,
    PHOTO_TTL_MS,
    VOICE_MAX_SECONDS,
} from "./config.js";
import { generateStudyPdf } from "./pdfgen.js";

function trimContext(messages) {
    if (messages.length <= MAX_CONTEXT_MESSAGES) return messages;
    const system = messages[0];
    const rest = messages.slice(1);
    return [system, ...rest.slice(rest.length - (MAX_CONTEXT_MESSAGES - 1))];
}

async function resolvePhoto(msg, chat) {
    if (msg.reply_to_message?.photo) {
        try {
            const photo =
                msg.reply_to_message.photo[
                    msg.reply_to_message.photo.length - 1
                ];
            return await downloadPhoto(photo.file_id);
        } catch (err) {
            console.error("resolvePhoto:", err.message);
        }
    }
    if (
        chat.lastPhoto &&
        Date.now() - chat.lastPhoto.timestamp < PHOTO_TTL_MS
    ) {
        return chat.lastPhoto.base64;
    }
    return null;
}

const WELCOME_PRIVATE = `👋 I'm *Prof* — your study partner.

Just *talk to me normally*. Try:

• _explain photosynthesis in simple terms_
• _quiz me on the French Revolution_
• _flashcards on cellular respiration_
• *send a photo* of homework, then say _"quiz me on this"_
• *send a voice note* — I'll transcribe and answer
• _"draw a free body diagram of a block on a ramp"_

If you get stuck:
• _how am I doing?_ — strengths & weaknesses
• \`/reset\` — start fresh`;

const WELCOME_GROUP = `👋 I'm *Prof* — your study partner.

Mention me (@${botUsername}) or reply to one of my messages, then just *talk normally*. Try:

• _@${botUsername} quiz me on algebra_
• _@${botUsername} explain the water cycle_
• *send a photo* of homework, then reply _"quiz me on this"_
• *send a voice note* — I'll transcribe and answer

*Tips:*
• Quizzes ask ONE question at a time.
• Ask _"how am I doing?"_ for progress.`;

export function registerHandlers() {
    // ─── Commands ───────────────────────────────────────
    bot.onText(/^\/start/, (msg) => {
        const isGroup = msg.chat.type !== "private";
        bot.sendMessage(
            msg.chat.id,
            isGroup ? WELCOME_GROUP : WELCOME_PRIVATE,
            {
                parse_mode: "Markdown",
                reply_to_message_id: msg.message_id,
                allow_sending_without_reply: true,
            },
        ).catch(() => {});
    });

    bot.onText(/^\/help/, (msg) => {
        bot.sendMessage(
            msg.chat.id,
            'Talk normally, send a photo, or send a voice note. Try "quiz me on biology" or "draw a free body diagram".',
            {
                reply_to_message_id: msg.message_id,
                allow_sending_without_reply: true,
            },
        ).catch(() => {});
    });

    bot.onText(/^\/reset/, (msg) => {
        const c = getChat(msg.chat.id);
        c.messages = [];
        c.lastReasoning = "";
        c.lastPhoto = null;
        activeQuizzes.delete(msg.chat.id);
        activeDecks.delete(msg.chat.id);
        bot.sendMessage(msg.chat.id, "Fresh slate. What are we working on?", {
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true,
        }).catch(() => {});
    });

    bot.onText(/^\/progress/, (msg) => {
        upsertUser(msg.from);
        sendRichOrFallback(msg.chat.id, buildProgressReport(msg.from.id), {
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
                    "No reasoning saved from the last response.",
                    {
                        reply_to_message_id: msg.message_id,
                        allow_sending_without_reply: true,
                    },
                )
                .catch(() => {});
        }
        sendRichOrFallback(
            msg.chat.id,
            `🧠 Last reasoning:\n\n${c.lastReasoning.slice(0, 3800)}`,
            {
                reply_to_message_id: msg.message_id,
                allow_sending_without_reply: true,
            },
        ).catch(() => {});
    });

    bot.onText(/^\/context/, (msg) => {
        const chat = getChat(msg.chat.id);
        const turns = chat.messages.length;
        const chars = chat.messages.reduce((n, m) => {
            if (typeof m.content === "string") return n + m.content.length;
            if (Array.isArray(m.content))
                return (
                    n + m.content.reduce((k, p) => k + (p.text?.length || 0), 0)
                );
            return n;
        }, 0);
        bot.sendMessage(
            msg.chat.id,
            `📊 Memory: ${turns} messages (~${chars} chars). /reset clears it.`,
            {
                reply_to_message_id: msg.message_id,
                allow_sending_without_reply: true,
            },
        ).catch(() => {});
    });

    bot.onText(/^\/quiz(?:\s+(.+))?/, (msg, match) => {
        upsertUser(msg.from);
        triggerQuiz(
            msg.chat.id,
            msg.message_id,
            (match[1] || "").trim(),
            msg.from.id,
        );
    });

    bot.onText(/^\/flashcards?(?:\s+(.+))?/, (msg, match) => {
        upsertUser(msg.from);
        triggerFlashcards(
            msg.chat.id,
            msg.message_id,
            (match[1] || "").trim(),
            msg.from.id,
        );
    });

    // ─── Callback queries ───────────────────────────────
    bot.on("callback_query", async (query) => {
        const data = query.data;
        if (!data) return;
        if (query.from) upsertUser(query.from);
        if (data.startsWith("flash:")) return handleFlashcardAction(query);
        if (data.startsWith("quiz:")) return handleQuizAnswer(query);
    });

    // ─── Main message handler ───────────────────────────
    bot.on("message", async (msg) => {
        if (msg.from?.is_bot) return;
        if (msg.text?.startsWith("/")) return;

        const chatId = msg.chat.id;
        const isGroup =
            msg.chat.type === "group" || msg.chat.type === "supergroup";
        const rawText = msg.text || msg.caption || "";
        const isPhoto = !!msg.photo;
        const isVoice = !!msg.voice;

        if (isGroup) {
            const mentioned = rawText.includes("@" + botUsername);
            const isReplyToBot =
                msg.reply_to_message?.from?.username === botUsername;
            if (!mentioned && !isReplyToBot) return;
        }

        if (!rawText && !isPhoto && !isVoice) return;

        upsertUser(msg.from);
        const userId = msg.from.id;
        const chat = getChat(chatId);
        let cleanText = rawText
            .replace(new RegExp(`@${botUsername}`, "g"), "")
            .trim();

        // ─── Voice note branch ────────────────────────────
        if (isVoice) {
            if (msg.voice.duration > VOICE_MAX_SECONDS) {
                return bot
                    .sendMessage(
                        chatId,
                        `That voice note is ${msg.voice.duration}s — please keep it under ${VOICE_MAX_SECONDS}s.`,
                        {
                            reply_to_message_id: msg.message_id,
                            allow_sending_without_reply: true,
                        },
                    )
                    .catch(() => {});
            }

            const status = await bot
                .sendMessage(chatId, "Listening…", {
                    reply_to_message_id: msg.message_id,
                    allow_sending_without_reply: true,
                })
                .catch(() => null);

            let transcript;
            try {
                const buffer = await downloadVoice(msg.voice.file_id);
                transcript = await transcribeVoice(buffer);
            } catch (err) {
                console.error("voice transcription failed:", err.message);
                if (status)
                    await bot
                        .deleteMessage(chatId, status.message_id)
                        .catch(() => {});
                return bot
                    .sendMessage(
                        chatId,
                        `Couldn't hear that clearly — try again or type it.`,
                        {
                            reply_to_message_id: msg.message_id,
                            allow_sending_without_reply: true,
                        },
                    )
                    .catch(() => {});
            }

            if (status)
                await bot
                    .deleteMessage(chatId, status.message_id)
                    .catch(() => {});

            // Show the transcript so the student knows what was heard
            await bot
                .sendMessage(chatId, `🎤 _"${transcript}"_`, {
                    parse_mode: "Markdown",
                    reply_to_message_id: msg.message_id,
                    allow_sending_without_reply: true,
                })
                .catch(() => {});

            logMessage({
                chatId,
                userId,
                role: "user",
                content: `[voice] ${transcript}`,
            });

            // Treat the transcript as if it were typed
            cleanText = transcript;
            // fall through to the text branch below
        }

        // ─── Photo branch ─────────────────────────────────
        if (isPhoto) {
            const photo = msg.photo[msg.photo.length - 1];
            let base64;
            try {
                bot.sendChatAction(chatId, "upload_photo").catch(() => {});
                base64 = await downloadPhoto(photo.file_id);
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

            chat.lastPhoto = { base64, timestamp: Date.now() };

            if (cleanText) {
                const flashTopic = detectFlashcardIntent(cleanText);
                if (flashTopic !== null) {
                    console.log(
                        `Chat ${chatId}: PHOTO + FLASHCARD → "${flashTopic || "(from image)"}"`,
                    );
                    return triggerFlashcards(
                        chatId,
                        msg.message_id,
                        flashTopic,
                        userId,
                        base64,
                    );
                }
                const quizTopic = detectQuizIntent(cleanText);
                if (quizTopic !== null) {
                    console.log(
                        `Chat ${chatId}: PHOTO + QUIZ → "${quizTopic || "(from image)"}"`,
                    );
                    return triggerQuiz(
                        chatId,
                        msg.message_id,
                        quizTopic,
                        userId,
                        base64,
                    );
                }
            }

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

            logMessage({
                chatId,
                userId,
                role: "user",
                content: cleanText || "[photo]",
                hasPhoto: true,
            });

            bot.sendChatAction(chatId, "typing").catch(() => {});
            const typing = setInterval(
                () => bot.sendChatAction(chatId, "typing").catch(() => {}),
                4500,
            );
            try {
                const result = await streamToTelegram(chatId, msg.message_id, [
                    { role: "system", content: SYSTEM_PROMPT },
                    ...trimContext(chat.messages),
                ]);
                clearInterval(typing);
                if (result.content) {
                    chat.messages.push({
                        role: "assistant",
                        content: result.content,
                    });
                    chat.lastReasoning = result.reasoning;
                    logMessage({
                        chatId,
                        userId,
                        role: "assistant",
                        content: result.content,
                    });
                } else chat.messages.pop();
            } catch (err) {
                clearInterval(typing);
                console.error("photo handler:", err.message);
            }
            return;
        }

        // ─── Text (or transcribed voice) branch ───────────
        if (!cleanText) return;

        // Reset
        if (
            /^(?:reset|start\s+over|clear|forget\s+(?:this|everything|that))$/i.test(
                cleanText,
            )
        ) {
            chat.messages = [];
            chat.lastReasoning = "";
            chat.lastPhoto = null;
            activeQuizzes.delete(chatId);
            activeDecks.delete(chatId);
            return bot
                .sendMessage(chatId, "Cleared. What are we working on?", {
                    reply_to_message_id: msg.message_id,
                    allow_sending_without_reply: true,
                })
                .catch(() => {});
        }

        // Progress
        if (
            /^(?:how\s+am\s+i\s+doing|my\s+progress|progress|my\s+stats|my\s+analytics|strengths?|weak(?:ness|nesses)?)\b/i.test(
                cleanText,
            )
        ) {
            return sendRichOrFallback(chatId, buildProgressReport(userId), {
                reply_to_message_id: msg.message_id,
                allow_sending_without_reply: true,
            }).catch(() => {});
        }

        const pdfIntent = detectPdfIntent(cleanText);
        if (pdfIntent) {
            const chatState = getChat(chatId);
            const lastAssistant = [...chatState.messages]
                .reverse()
                .find(
                    (m) =>
                        m.role === "assistant" && typeof m.content === "string",
                );

            if (!lastAssistant) {
                return bot
                    .sendMessage(
                        chatId,
                        "There’s nothing to turn into a PDF yet. Ask me to explain something first, then say “make that a PDF”.",
                        {
                            reply_to_message_id: msg.message_id,
                            allow_sending_without_reply: true,
                        },
                    )
                    .catch(() => {});
            }

            const status = await bot
                .sendMessage(chatId, "Building your study sheet…", {
                    reply_to_message_id: msg.message_id,
                    allow_sending_without_reply: true,
                })
                .catch(() => null);

            try {
                function derivePdfTitle(chatState, currentText) {
                    const lastUser = [...chatState.messages]
                        .reverse()
                        .find(
                            (m) =>
                                m.role === "user" &&
                                typeof m.content === "string" &&
                                m.content.trim() &&
                                m.content.trim() !== currentText.trim(),
                        );
                    const raw =
                        lastUser?.content?.trim() || "Prof · Study Sheet";
                    const title = raw.charAt(0).toUpperCase() + raw.slice(1);
                    return title.length > 80 ? title.slice(0, 77) + "…" : title;
                }

                const buffer = await generateStudyPdf({
                    title: derivePdfTitle(chatState, cleanText),
                    markdown: lastAssistant.content,
                });

                if (status)
                    await bot
                        .deleteMessage(chatId, status.message_id)
                        .catch(() => {});

                await bot
                    .sendDocument(
                        chatId,
                        buffer,
                        {
                            caption: "📄 Your study sheet (PDF)",
                            reply_to_message_id: msg.message_id,
                            allow_sending_without_reply: true,
                        },
                        {
                            filename: `prof-study-sheet-${Date.now()}.pdf`,
                            contentType: "application/pdf",
                        },
                    )
                    .catch(() => {});
            } catch (err) {
                if (status)
                    await bot
                        .deleteMessage(chatId, status.message_id)
                        .catch(() => {});
                console.error("pdf generation failed:", err.message);
                bot.sendMessage(
                    chatId,
                    "I couldn’t build the PDF — try again with a shorter explanation.",
                    {
                        reply_to_message_id: msg.message_id,
                        allow_sending_without_reply: true,
                    },
                ).catch(() => {});
            }
            return;
        }

        const replyToPhoto = !!msg.reply_to_message?.photo;
        const isReplyToBot =
            msg.reply_to_message?.from?.username === botUsername;

        const flashTopic = detectFlashcardIntent(cleanText);
        if (flashTopic !== null) {
            const isPhotoRef = PHOTO_REF.test((flashTopic || "").trim());
            if (isPhotoRef || replyToPhoto || isReplyToBot) {
                const base64 = await resolvePhoto(msg, chat);
                if (base64) {
                    console.log(`Chat ${chatId}: TEXT → PHOTO FLASHCARD`);
                    return triggerFlashcards(
                        chatId,
                        msg.message_id,
                        null,
                        userId,
                        base64,
                    );
                }
            }
            console.log(
                `Chat ${chatId}: FLASHCARD → "${flashTopic || "(general)"}"`,
            );
            return triggerFlashcards(
                chatId,
                msg.message_id,
                flashTopic,
                userId,
            );
        }

        const quizTopic = detectQuizIntent(cleanText);
        if (quizTopic !== null) {
            const isPhotoRef = PHOTO_REF.test((quizTopic || "").trim());
            if (isPhotoRef || replyToPhoto || isReplyToBot) {
                const base64 = await resolvePhoto(msg, chat);
                if (base64) {
                    console.log(`Chat ${chatId}: TEXT → PHOTO QUIZ`);
                    return triggerQuiz(
                        chatId,
                        msg.message_id,
                        null,
                        userId,
                        base64,
                    );
                }
            }
            console.log(`Chat ${chatId}: QUIZ → "${quizTopic || "(general)"}"`);
            return triggerQuiz(chatId, msg.message_id, quizTopic, userId);
        }

        // Normal chat
        console.log(`Chat ${chatId}: normal → "${cleanText.slice(0, 50)}"`);
        chat.messages.push({ role: "user", content: cleanText });
        logMessage({ chatId, userId, role: "user", content: cleanText });

        bot.sendChatAction(chatId, "typing").catch(() => {});
        const typing = setInterval(
            () => bot.sendChatAction(chatId, "typing").catch(() => {}),
            4500,
        );
        try {
            const result = await streamToTelegram(chatId, msg.message_id, [
                { role: "system", content: SYSTEM_PROMPT },
                ...trimContext(chat.messages),
            ]);
            clearInterval(typing);
            if (result.content) {
                chat.messages.push({
                    role: "assistant",
                    content: result.content,
                });
                chat.lastReasoning = result.reasoning;
                logMessage({
                    chatId,
                    userId,
                    role: "assistant",
                    content: result.content,
                });
            } else chat.messages.pop();
        } catch (err) {
            clearInterval(typing);
            console.error("message handler:", err.message);
        }
    });

    // ─── Errors ─────────────────────────────────────────
    bot.on("polling_error", (err) =>
        console.error("polling_error:", err.code || err.message),
    );
    process.on("SIGINT", () => {
        console.log("\nShutting down Prof…");
        bot.stopPolling().finally(() => process.exit(0));
    });
    process.on("unhandledRejection", (err) =>
        console.error("unhandledRejection:", err),
    );
}
