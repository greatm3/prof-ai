import { bot, sendRichOrFallback } from "./telegram.js";
import { generateSilent } from "./nim.js";
import { SYSTEM_PROMPT, flashcardPrompt } from "./prompts.js";
import { parseFlashcards } from "./parsers.js";
import { getChat, activeDecks } from "./state.js";
import { createSession, completeSession } from "./db.js";
import { logMessage } from "./db.js";
import { alertAdmin } from "./alerts.js";

function buildKeyboard(index, revealed, isLast) {
    if (!revealed) {
        return {
            inline_keyboard: [
                [
                    {
                        text: "👁 Reveal answer",
                        callback_data: `flash:${index}:reveal`,
                    },
                ],
            ],
        };
    }
    return {
        inline_keyboard: [
            [
                {
                    text: isLast ? "✓ Finish" : "Next →",
                    callback_data: `flash:${index}:next`,
                },
            ],
        ],
    };
}

async function sendFront(chatId, deck) {
    const card = deck.cards[deck.index];
    const body = `**Card ${deck.index + 1} of ${deck.cards.length}**\n\n${card.front}`;
    const sent = await sendRichOrFallback(chatId, body, {
        reply_markup: buildKeyboard(deck.index, false, false),
    }).catch(() => null);
    if (sent) deck.messageId = sent.message_id;
    deck.revealed = false;
    console.log(
        `Deck ${chatId}: card ${deck.index + 1}/${deck.cards.length} front`,
    );
}

async function sendBack(chatId, deck) {
    const card = deck.cards[deck.index];
    const isLast = deck.index === deck.cards.length - 1;
    const body = `**Card ${deck.index + 1} of ${deck.cards.length}**\n\n${card.front}\n\n**Answer**\n${card.back}`;
    const sent = await sendRichOrFallback(chatId, body, {
        reply_markup: buildKeyboard(deck.index, true, isLast),
    }).catch(() => null);
    if (sent) deck.messageId = sent.message_id;
    deck.revealed = true;
    console.log(`Deck ${chatId}: card ${deck.index + 1} back`);
}

async function finishDeck(chatId, deck) {
    const body =
        `🎓 **Deck complete!**\n\n` +
        `You reviewed ${deck.cards.length} cards on _${deck.topic}_.\n\n` +
        `Want to test yourself? Just say: "quiz me on ${deck.topic}"\n\n` +
        `Or ask "how am I doing?" for your progress.`;
    await sendRichOrFallback(chatId, body).catch(() => {});
    await logMessage({
        chatId,
        userId: null,
        role: "assistant",
        content: `Deck complete: ${deck.cards.length} cards on ${deck.topic}`,
    });
    await completeSession(deck.sessionId, null);
    activeDecks.delete(chatId);
    console.log(`Deck ${chatId}: finished`);
}

export async function triggerFlashcards(
    chatId,
    replyToId,
    topic,
    userId,
    imageBase64 = null,
) {
    if (activeDecks.has(chatId)) {
        return bot
            .sendMessage(
                chatId,
                'Finish the current deck first, or say "reset" to cancel.',
                {
                    reply_to_message_id: replyToId,
                    allow_sending_without_reply: true,
                },
            )
            .catch(() => {});
    }
    if (activeQuizzes.has(chatId)) {
        return bot
            .sendMessage(
                chatId,
                'Finish the current quiz first, or say "reset" to cancel.',
                {
                    reply_to_message_id: replyToId,
                    allow_sending_without_reply: true,
                },
            )
            .catch(() => {});
    }

    const chat = getChat(chatId);
    const cleanTopic = (topic || "").trim();
    const fromImage = !!imageBase64;
    const sessionTopic = fromImage
        ? "image-flashcards"
        : cleanTopic || "general knowledge";

    console.log(
        `Deck ${chatId}: building ${fromImage ? "FROM IMAGE" : `on "${sessionTopic}"`}`,
    );

    const prompt = flashcardPrompt(cleanTopic, fromImage);
    const userMessage = fromImage
        ? {
              role: "user",
              content: [
                  { type: "text", text: prompt },
                  {
                      type: "image_url",
                      image_url: {
                          url: `data:image/jpeg;base64,${imageBase64}`,
                      },
                  },
              ],
          }
        : { role: "user", content: prompt };

    const status = await bot
        .sendMessage(
            chatId,
            fromImage
                ? "Reading the image and building your deck…"
                : "Building your deck…",
            {
                reply_to_message_id: replyToId,
                allow_sending_without_reply: true,
            },
        )
        .catch(() => null);

    try {
        const result = await generateSilent(
            [{ role: "system", content: SYSTEM_PROMPT }, userMessage],
            4096,
        );

        const cards = parseFlashcards(result.content);
        console.log(`Deck ${chatId}: parsed ${cards.length} cards`);

        if (cards.length < 4) {
            if (status)
                await bot
                    .deleteMessage(chatId, status.message_id)
                    .catch(() => {});
            return bot
                .sendMessage(
                    chatId,
                    `I only built ${cards.length} clean cards. Try a more specific topic or a clearer photo.`,
                    {
                        reply_to_message_id: replyToId,
                        allow_sending_without_reply: true,
                    },
                )
                .catch(() => {});
        }

        if (fromImage) {
            chat.messages.push({
                role: "user",
                content: `[Generated flashcards from image${cleanTopic ? ": " + cleanTopic : ""}]`,
            });
        } else {
            chat.messages.push({ role: "user", content: prompt });
        }
        chat.messages.push({ role: "assistant", content: result.content });
        chat.lastReasoning = result.reasoning;

        if (status)
            await bot.deleteMessage(chatId, status.message_id).catch(() => {});

        const sessionId = await createSession({
            chatId,
            userId,
            type: "flashcards",
            topic: sessionTopic,
            sourceType: fromImage ? "image" : "text",
            totalQuestions: cards.length,
        });

        const deck = {
            cards: cards.slice(0, 5),
            index: 0,
            revealed: false,
            messageId: null,
            chatId,
            sessionId,
            topic:
                cleanTopic || (fromImage ? "this image" : "general knowledge"),
        };
        activeDecks.set(chatId, deck);
        await sendFront(chatId, deck);
        await logMessage({
            chatId,
            userId,
            role: "user",
            content: `[Started flashcards: ${sessionTopic}]`,
        });
    } catch (err) {
        if (status)
            await bot.deleteMessage(chatId, status.message_id).catch(() => {});
        console.error("flashcard error:", err.message);
        await alertAdmin('flashcard', err);
        bot.sendMessage(
            chatId,
            `Flashcard generation failed: ${err.message.slice(0, 200)}`,
            {
                reply_to_message_id: replyToId,
                allow_sending_without_reply: true,
            },
        ).catch(() => {});
    }
}

import { activeQuizzes } from "./state.js";

export async function handleFlashcardAction(query) {
    const [, indexStr, action] = query.data.split(":");
    const chatId = query.message.chat.id;
    const deck = activeDecks.get(chatId);
    if (!deck)
        return bot
            .answerCallbackQuery(query.id, { text: "Deck expired." })
            .catch(() => {});
    const index = Number(indexStr);
    if (index !== deck.index)
        return bot
            .answerCallbackQuery(query.id, { text: "Already done." })
            .catch(() => {});

    if (action === "reveal") {
        if (deck.revealed)
            return bot
                .answerCallbackQuery(query.id, { text: "Already revealed." })
                .catch(() => {});
        await bot
            .answerCallbackQuery(query.id, { text: "Revealed." })
            .catch(() => {});
        await bot.deleteMessage(chatId, deck.messageId).catch(() => {});
        await sendBack(chatId, deck);
    } else if (action === "next") {
        await bot
            .answerCallbackQuery(query.id, { text: "Next." })
            .catch(() => {});
        await bot.deleteMessage(chatId, deck.messageId).catch(() => {});
        deck.index++;
        if (deck.index < deck.cards.length) {
            await sendFront(chatId, deck);
            await logMessage({
                chatId,
                userId,
                role: "user",
                content: `[Started flashcards: ${sessionTopic}]`,
            });
        } else {
            await finishDeck(chatId, deck);
        }
    }
}
