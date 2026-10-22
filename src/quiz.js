import { bot, sendRichOrFallback } from "./telegram.js";
import { generateSilent, generateExplanations } from "./nim.js";
import { SYSTEM_PROMPT, quizPrompt, explanationsPrompt } from "./prompts.js";
import { parseQuiz, normalizeLatex } from "./parsers.js";
import { getChat, activeQuizzes } from "./state.js";
import { splitLong } from "./telegram.js";
import { createSession, completeSession, logAnswer } from "./db.js";
import { logMessage } from "./db.js";

export function buildQuizKeyboard(index) {
    return {
        inline_keyboard: [
            [
                { text: "A", callback_data: `quiz:${index}:A` },
                { text: "B", callback_data: `quiz:${index}:B` },
                { text: "C", callback_data: `quiz:${index}:C` },
                { text: "D", callback_data: `quiz:${index}:D` },
            ],
        ],
    };
}

export async function sendQuizQuestion(chatId, quiz) {
    const q = quiz.questions[quiz.index];
    const body =
        `**Question ${quiz.index + 1} of ${quiz.questions.length}**\n\n` +
        `${normalizeLatex(q.text)}\n\n` +
        `A) ${normalizeLatex(q.options.A)}\n` +
        `B) ${normalizeLatex(q.options.B)}\n` +
        `C) ${normalizeLatex(q.options.C)}\n` +
        `D) ${normalizeLatex(q.options.D)}`;

    const sent = await sendRichOrFallback(chatId, body, {
        reply_markup: buildQuizKeyboard(quiz.index),
    }).catch(() => null);

    if (sent) quiz.messageId = sent.message_id;
    console.log(`   → sent Q${quiz.index + 1}/${quiz.questions.length}`);
}

export async function triggerQuiz(
    chatId,
    replyToId,
    topic,
    userId,
    imageBase64 = null,
) {
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
        ? "image-quiz"
        : cleanTopic || "general knowledge";

    console.log(
        `Quiz ${chatId}: building ${fromImage ? "FROM IMAGE" : `on "${sessionTopic}"`}`,
    );

    const prompt = quizPrompt(cleanTopic, fromImage);
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
                ? "Reading the image and building your quiz…"
                : "Building your quiz…",
            {
                reply_to_message_id: replyToId,
                allow_sending_without_reply: true,
            },
        )
        .catch(() => null);

    try {
        const result = await generateSilent([
            { role: "system", content: SYSTEM_PROMPT },
            userMessage,
        ]);

        const questions = parseQuiz(result.content);
        console.log(`Quiz ${chatId}: parsed ${questions.length} questions`);

        if (questions.length < 8) {
            if (status)
                await bot
                    .deleteMessage(chatId, status.message_id)
                    .catch(() => {});
            return bot
                .sendMessage(
                    chatId,
                    `I only built ${questions.length} clean questions. Try a more specific topic or a clearer photo.`,
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
                content: `[Generated quiz from image${cleanTopic ? ": " + cleanTopic : ""}]`,
            });
        } else {
            chat.messages.push({ role: "user", content: prompt });
        }
        chat.messages.push({ role: "assistant", content: result.content });
        chat.lastReasoning = result.reasoning;

        if (status)
            await bot.deleteMessage(chatId, status.message_id).catch(() => {});

        const trimmed = questions.slice(0, 10);
        const sessionId = createSession({
            chatId,
            userId,
            type: "quiz",
            topic: sessionTopic,
            sourceType: fromImage ? "image" : "text",
            totalQuestions: trimmed.length,
        });

        const quiz = {
            questions: trimmed,
            index: 0,
            score: 0,
            answers: [],
            messageId: null,
            chatId,
            sessionId,
            topic: sessionTopic,
        };
        activeQuizzes.set(chatId, quiz);
        await sendQuizQuestion(chatId, quiz);
        logMessage({
            chatId,
            userId,
            role: "user",
            content: `[Started quiz: ${sessionTopic}]`,
        });
    } catch (err) {
        if (status)
            await bot.deleteMessage(chatId, status.message_id).catch(() => {});
        console.error("quiz generation error:", err.message);
        bot.sendMessage(
            chatId,
            `Quiz generation failed: ${err.message.slice(0, 200)}`,
            {
                reply_to_message_id: replyToId,
                allow_sending_without_reply: true,
            },
        ).catch(() => {});
    }
}

export async function handleQuizAnswer(query) {
    const [, indexStr, chosen] = query.data.split(":");
    const chatId = query.message.chat.id;
    const userId = query.from?.id;
    const quiz = activeQuizzes.get(chatId);
    if (!quiz)
        return bot
            .answerCallbackQuery(query.id, { text: "Quiz expired." })
            .catch(() => {});

    const index = Number(indexStr);
    if (index !== quiz.index)
        return bot
            .answerCallbackQuery(query.id, { text: "Already answered." })
            .catch(() => {});

    const q = quiz.questions[quiz.index];
    const isCorrect = chosen === q.correct;

    // Log every answer against the actual tapper, not just the starter
    if (userId) {
        logAnswer({
            sessionId: quiz.sessionId,
            userId,
            questionText: q.text,
            topic: quiz.topic,
            isCorrect,
        });
    }

    quiz.answers.push({
        q: quiz.index + 1,
        chosen,
        correct: q.correct,
        userId,
    });
    if (isCorrect) quiz.score++;

    await bot
        .answerCallbackQuery(query.id, { text: "Answer recorded." })
        .catch(() => {});
    await bot.deleteMessage(chatId, quiz.messageId).catch(() => {});
    quiz.index++;
    console.log(
        `Quiz ${chatId}: Q${quiz.index} answered (${chosen}), moving on`,
    );

    if (quiz.index < quiz.questions.length) {
        await sendQuizQuestion(chatId, quiz);
    } else {
        await finishQuiz(chatId, quiz);
    }
}

async function finishQuiz(chatId, quiz) {
    const total = quiz.questions.length;
    const pct = Math.round((quiz.score / total) * 100);
    const correctAnswers = quiz.questions.map((q) => q.correct);

    let explanations;
    try {
        const prompt = explanationsPrompt(quiz.questions, correctAnswers);
        explanations = await generateExplanations(prompt, total);
    } catch {
        explanations = quiz.questions.map(() => "No explanation available.");
    }

    let summary = `**Quiz complete**\n\nScore: ${quiz.score}/${total} (${pct}%)\n\n---\n\n`;
    for (let i = 0; i < quiz.questions.length; i++) {
        const q = quiz.questions[i];
        const a = quiz.answers[i];
        const ok = a.chosen === q.correct;
        summary += `${ok ? "✅" : "❌"} **Q${i + 1}.** ${q.text}\n\n`;
        summary += `Your answer: ${a.chosen}) ${q.options[a.chosen]}\n`;
        if (!ok)
            summary += `Correct answer: ${q.correct}) ${q.options[q.correct]}\n`;
        summary += `\n💡 ${explanations[i] || "No explanation available."}\n\n---\n\n`;
    }
    summary +=
        quiz.score === total
            ? "**Perfect score.**"
            : pct >= 60
              ? "**Solid effort. Review the ones you missed.**"
              : "**Keep practising.**";
    summary += `\n\n_Ask "how am I doing?" for your full progress._`;

    for (const part of splitLong(summary)) {
        await sendRichOrFallback(chatId, part).catch(() => {});
    }

    logMessage({
        chatId: quiz.chatId,
        userId: null,
        role: "assistant",
        content: `Quiz complete: ${quiz.score}/${total} on ${quiz.topic}`,
    });
    completeSession(quiz.sessionId, quiz.score);
    activeQuizzes.delete(chatId);
    console.log(`Quiz ${chatId}: finished ${quiz.score}/${total}`);
}
