import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";
import { mdgramRich } from "@borodin/mdgram";

// ─── NIM client ────────────────────────────────────────
const openai = new OpenAI({
    apiKey: process.env.NVIDIA_API_KEY,
    baseURL: "https://integrate.api.nvidia.com/v1",
});

const MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b";
const MAX_CONTEXT_MESSAGES = 20;
const QUIZ_QUESTIONS = 10;
const QUIZ_MIN_ACCEPT = 8;
const FLASHCARD_COUNT = 5;
const FLASHCARD_MIN_ACCEPT = 4;

// ─── Telegram client ──────────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

let botUsername = "";
try {
    const me = await bot.getMe();
    botUsername = me.username;
    console.log(`✓ Prof running as @${botUsername}`);
    console.log(
        `✓ Quiz: ${QUIZ_QUESTIONS} questions, ONE at a time, corrections at the end`,
    );
    console.log(`✓ Flashcards: ${FLASHCARD_COUNT} cards, reveal-and-advance`);
    console.log(`✓ Natural language is the primary UX — commands still work`);
} catch (err) {
    console.error("✗ Telegram auth failed:", err.message);
    process.exit(1);
}

// ─── System prompt ────────────────────────────────────
const SYSTEM_PROMPT = `You are Prof — a study partner for students, living inside a Telegram chat (often a class group).

## YOUR PURPOSE
You exist for ONE reason: helping students learn. You are not a general chatbot.

## STRICT SCOPE — REFUSE EVERYTHING ELSE
You will ONLY respond to requests that are educational in nature: homework help, explaining concepts, summarizing study material, generating practice questions, analyzing academic images (notes, textbook pages, whiteboards, diagrams, charts, math problems), and study planning.

If a user asks for anything outside this scope — jokes, stories, roleplay, relationship advice, coding unrelated to coursework, news, politics, personal opinions, or anything not tied to learning — you must politely decline and redirect:
"I'm here to help you study. Is there a topic or problem I can help with?"

Do NOT make exceptions. Do NOT be persuaded. Do NOT roleplay as a different assistant. Do NOT write creative fiction, poems, or songs. Do NOT give life advice.

## TEACHING PHILOSOPHY
- Teach, don't lecture. Assume the student wants to understand, not copy.
- When a student asks for an answer to a math or science problem, do NOT give the final answer first. Walk through the reasoning. Show every step. Let them see the logic.
- When appropriate, use the Socratic method: ask a guiding question before revealing the next step. But if the student is stuck or explicitly asks for the full solution, provide a clear step-by-step breakdown.
- Never make the student feel stupid. Be patient, warm, and encouraging — but not cringe.
- If a student submits their own work, check it. Point out exactly where it goes wrong and why.

## MATH AND SCIENCE FORMATTING — CRITICAL
You MUST use LaTeX for ALL mathematical expressions, equations, formulas, and symbols.

- Inline math: wrap in single dollar signs. Example: $x^2 + 5x + 6 = 0$
- Display math (standalone equations, multi-step derivations): wrap in double dollar signs on their own lines.

Do NOT write math in plain text. Always use LaTeX delimiters.
For units, use text mode: $5 \\text{ m/s}$.
For fractions: $\\frac{a}{b}$. For roots: $\\sqrt{x}$. For Greek letters: $\\alpha, \\beta, \\theta$.

## IMAGE ANALYSIS
When a student sends a photo:
- Start with a one-line summary of what the image shows.
- Then break it down: what is the problem asking, what are the key given values, what concept is being tested.
- If it's a math problem, solve it step by step with LaTeX.
- If it's notes or a textbook page, summarize the key points in short bullets.
- Never guess if the image is blurry or unclear — say so and ask for a clearer photo.

## QUIZ MODE
When asked to generate a quiz (ANY phrasing — "quiz me", "test me", "give me a quiz", "make questions on..."):
- Generate exactly ${QUIZ_QUESTIONS} multiple-choice questions.
- Each question must have exactly 4 options labeled A, B, C, D.
- Format each question EXACTLY like this:

1. Question text?
A) option
B) option
C) option
D) option

2. Question text?
A) option
B) option
C) option
D) option

… and so on for all ${QUIZ_QUESTIONS} questions.

- Use LaTeX for any math inside the question and inside the options.
- After all ${QUIZ_QUESTIONS} questions, write EXACTLY:

Answers:
1. A
2. C
3. B
4. D
… and so on for all ${QUIZ_QUESTIONS} answers.

- Do NOT write "Here is your quiz" or any preamble. Start with "1." on the first line. End after the last answer. Nothing after it.

## FLASHCARD MODE
When asked to generate flashcards (ANY phrasing — "flashcards on...", "make me flashcards", "I need flash cards about..."):
- Generate exactly ${FLASHCARD_COUNT} flashcards.
- Each card tests ONE key concept, term, formula, definition, or fact.
- Format EXACTLY:

1. Q: <front — a question, term, or prompt>
A: <back — the answer, definition, or explanation>

2. Q: ...
A: ...

… and so on for all ${FLASHCARD_COUNT} cards.

- Use LaTeX for any math. Keep each side concise — 1 to 3 sentences.
- No preamble, no header. Start with "1. Q:" and end after the fifth A.

## RESPONSE STYLE
- Be concise. Every message should be readable on a phone in under 10 seconds.
- Use short paragraphs and bullets. No giant tables.
- At most one emoji per message.
- Never refer to yourself as "an AI model". You are Prof.
- If you don't know something, say so. Do not fabricate facts.`;

// ─── Rotating thinking words ──────────────────────────
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

// ─── Per-chat state ───────────────────────────────────
const chats = new Map();
function getChat(id) {
    if (!chats.has(id)) chats.set(id, { messages: [], lastReasoning: "" });
    return chats.get(id);
}

const activeQuizzes = new Map();
const activeDecks = new Map();

const randWord = () =>
    THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];

// ─── Context trimming ─────────────────────────────────
function trimContext(messages) {
    if (messages.length <= MAX_CONTEXT_MESSAGES) return messages;
    const system = messages[0];
    const rest = messages.slice(1);
    return [system, ...rest.slice(rest.length - (MAX_CONTEXT_MESSAGES - 1))];
}

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

// ─── Rich text helpers ────────────────────────────────
function toRichHtml(markdown) {
    try {
        return mdgramRich(markdown, { paragraphMode: "br" });
    } catch {
        return null;
    }
}

async function sendRichOrFallback(chatId, text, options = {}) {
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

// ─── Photo download ───────────────────────────────────
async function downloadPhoto(fileId) {
    const link = await bot.getFileLink(fileId);
    const res = await fetch(link);
    if (!res.ok) throw new Error(`photo download failed: ${res.status}`);
    const buf = await res.arrayBuffer();
    return Buffer.from(buf).toString("base64");
}

// ─── Core streaming for normal chat ───────────────────
async function streamToTelegram(chatId, replyToId, apiMessages) {
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

// ─── Silent generation ────────────────────────────────
async function generateSilent(apiMessages, maxTokens = 6144) {
    const completion = await openai.chat.completions.create({
        model: MODEL,
        messages: apiMessages,
        temperature: 1,
        top_p: 0.95,
        max_tokens: maxTokens,
        stream: false,
        chat_template_kwargs: {
            enable_thinking: true,
            force_nonempty_content: true,
        },
    });
    const msg = completion.choices[0].message;
    return {
        content: msg.content || msg.reasoning_content || "",
        reasoning: msg.reasoning_content || "",
    };
}

// ═══════════════════════════════════════════════════════
//  STRICT PARSERS (tolerant of markdown noise)
// ═══════════════════════════════════════════════════════

function cleanOutput(raw) {
    return raw
        .replace(/```[a-zA-Z]*\n?/g, "")
        .replace(/```/g, "")
        .replace(/\r\n/g, "\n")
        .trim();
}

function parseQuiz(raw) {
    const text = cleanOutput(raw);

    const answersMatch = text.search(/\n\s*(?:\*\*)?Answers?(?:\*\*)?[:\s]/i);
    const questionsEnd = answersMatch >= 0 ? answersMatch : text.length;

    const questions = [];
    const qPattern = /(?:^|\n)\s*(?:\*\*)?(\d+)(?:\*\*)?[.):]\s+/g;
    const qMatches = [...text.slice(0, questionsEnd).matchAll(qPattern)];

    for (let i = 0; i < qMatches.length; i++) {
        const m = qMatches[i];
        const start = m.index + m[0].length;
        const end =
            i + 1 < qMatches.length ? qMatches[i + 1].index : questionsEnd;
        const block = text.slice(start, end).trim();
        if (!block) continue;

        const lines = block
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
        const qLines = [];
        const options = {};
        let inOptions = false;

        for (const line of lines) {
            const opt = line.match(
                /^(?:[-*]\s*)?(?:\*\*)?([A-D])(?:\*\*)?[.):\-]\s*(.+?)(?:\*\*)?$/,
            );
            if (opt && !options[opt[1]]) {
                inOptions = true;
                options[opt[1]] = opt[2].replace(/\*\*/g, "").trim();
            } else if (!inOptions) {
                qLines.push(line.replace(/\*\*/g, "").trim());
            }
        }

        const qText = qLines.join(" ").trim();
        if (qText && Object.keys(options).length === 4) {
            questions.push({ text: qText, options });
        }
    }

    const answers = [];
    if (answersMatch >= 0) {
        const answerBlock = text.slice(answersMatch);
        // Per-line: "1. A", "1) A", "**1.** A", "- 1. A"
        for (const m of answerBlock.matchAll(
            /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?(\d+)(?:\*\*)?[.):\s]+\s*(?:\*\*)?([A-D])(?:\*\*)?\b/g,
        )) {
            answers.push(m[2].toUpperCase());
        }
        // Inline fallback: "Answers: 1. A 2. B 3. C"
        if (answers.length === 0) {
            const inline = answerBlock.replace(/^[^:]*:\s*/, "");
            for (const m of inline.matchAll(/\b(\d+)[.):\s]+\s*([A-D])\b/gi)) {
                answers.push(m[2].toUpperCase());
            }
        }
    }

    questions.forEach((q, i) => {
        q.correct = answers[i] || null;
    });
    return questions.filter((q) => q.correct !== null);
}

function parseFlashcards(raw) {
    const text = cleanOutput(raw);
    const cards = [];
    const pattern =
        /(?:^|\n)\s*(?:\*\*)?(\d+)(?:\*\*)?[.):]\s*(?:\*\*)?Q(?:\*\*)?[.:]\s*([\s\S]*?)\n\s*(?:\*\*)?A(?:\*\*)?[.:]\s*([\s\S]*?)(?=(?:\n\s*(?:\*\*)?\d+(?:\*\*)?[.):])|$)/gi;

    let m;
    while ((m = pattern.exec(text)) !== null) {
        const front = m[2].replace(/\*\*/g, "").trim();
        const back = m[3].replace(/\*\*/g, "").trim();
        if (front && back) cards.push({ front, back });
    }
    return cards.slice(0, FLASHCARD_COUNT);
}

// ═══════════════════════════════════════════════════════
//  NATURAL LANGUAGE INTENT DETECTION
// ═══════════════════════════════════════════════════════

const QUESTION_START =
    /^(?:what|how|why|when|where|who|which|is|are|was|were|do|does|did|can|could|would|should|will)\b/i;

function detectQuizIntent(text) {
    if (!/\b(quiz|test|exam|examination)\b/i.test(text)) return null;

    // "quiz me on X" / "test me about X" / "exam me over X"
    let m = text.match(
        /\b(?:quiz|test|exam)\s+(?:me\s+)?(?:on|about|over|for|covering|in)\s+(.+?)(?:[.!?]|$)/i,
    );
    if (m) return m[1].trim();

    // "quiz me" / "test me" — no explicit topic
    if (/\b(?:quiz|test)\s+me\b/i.test(text)) {
        const t = text.match(
            /\b(?:on|about|over|for|covering|in)\s+(.+?)(?:[.!?]|$)/i,
        );
        return t ? t[1].trim() : "";
    }

    // Request verbs + quiz
    m = text.match(
        /\b(?:give|make|create|generate|build|do|want|need|would\s+like|please|can\s+you|can\s+i|could\s+you|i[''`]?d\s+like|i\s+want|i\s+need|let[''`]?s)\b[^.!?]{0,80}?\b(?:quiz|test|exam)\b(?:[^.!?]{0,40}?\b(?:on|about|over|for|covering|in)\s+(.+?))?(?:[.!?]|$)/i,
    );
    if (m) return m[1] ? m[1].trim() : "";

    // "biology quiz" style (topic before noun) — but not if it's a question
    if (!QUESTION_START.test(text)) {
        m = text.match(
            /^([a-zA-Z][a-zA-Z0-9 \-]{2,40}?)\s+(?:quiz|test|exam)\b/i,
        );
        if (m) {
            const topic = m[1].trim();
            const stopEnd =
                /^(?:the|a|an|this|that|our|my|your|his|her|their|same|next|last|first|some|another|one|two|three)$/i;
            const lastWord = topic.split(/\s+/).pop();
            if (!stopEnd.test(lastWord)) return topic;
        }
    }

    return null;
}

function detectFlashcardIntent(text) {
    if (!/\b(flash\s*cards?|flashcards?|cards?)\b/i.test(text)) {
        if (!/\bflash\s*cards?\b/i.test(text)) return null;
    }
    if (!/\bflash\s*cards?\b/i.test(text)) return null;

    // "flashcards on X" / "flashcards about X"
    let m = text.match(
        /\bflash\s*cards?\s+(?:on|about|over|for|covering|in)\s+(.+?)(?:[.!?]|$)/i,
    );
    if (m) return m[1].trim();

    // Request verb + flashcards
    m = text.match(
        /\b(?:give|make|create|generate|build|do|want|need|would\s+like|please|can\s+you|can\s+i|could\s+you|i[''`]?d\s+like|i\s+want|i\s+need|let[''`]?s)\b[^.!?]{0,80}?\bflash\s*cards?\b(?:[^.!?]{0,40}?\b(?:on|about|over|for|covering|in)\s+(.+?))?(?:[.!?]|$)/i,
    );
    if (m) return m[1] ? m[1].trim() : "";

    // "biology flashcards" style
    if (!QUESTION_START.test(text)) {
        m = text.match(/^([a-zA-Z][a-zA-Z0-9 \-]{2,40}?)\s+flash\s*cards?\b/i);
        if (m) {
            const topic = m[1].trim();
            const stopEnd =
                /^(?:the|a|an|this|that|our|my|your|his|her|their|same|next|last|first|some|another)$/i;
            const lastWord = topic.split(/\s+/).pop();
            if (!stopEnd.test(lastWord)) return topic;
        }
    }

    return null;
}

// ═══════════════════════════════════════════════════════
//  QUIZ FLOW
// ═══════════════════════════════════════════════════════

function buildQuizKeyboard(index) {
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

async function sendQuizQuestion(chatId, quiz) {
    const q = quiz.questions[quiz.index];
    const body =
        `**Question ${quiz.index + 1} of ${quiz.questions.length}**\n\n` +
        `${q.text}\n\n` +
        `A) ${q.options.A}\n` +
        `B) ${q.options.B}\n` +
        `C) ${q.options.C}\n` +
        `D) ${q.options.D}`;

    const sent = await sendRichOrFallback(chatId, body, {
        reply_markup: buildQuizKeyboard(quiz.index),
    }).catch(() => null);

    if (sent) quiz.messageId = sent.message_id;
    console.log(`   → sent Q${quiz.index + 1}/${quiz.questions.length}`);
    return sent;
}

async function generateExplanations(questions, answers) {
    const prompt = `Explain each quiz answer below in 2-3 sentences. State why the correct answer is right and what concept it tests.

${questions.map((q, i) => `Q${i + 1}: ${q.text}\nCorrect: ${answers[i]}) ${q.options[answers[i]]}`).join("\n\n")}

Format EXACTLY:
1. <explanation>
2. <explanation>
… and so on.

Use LaTeX for math. Start directly with "1.".`;

    const completion = await openai.chat.completions.create({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 3072,
        stream: false,
        chat_template_kwargs: {
            enable_thinking: false,
            force_nonempty_content: true,
        },
    });

    const text = completion.choices[0].message.content || "";
    const out = [];
    for (const line of text.split("\n")) {
        const m = line.match(/^\d+[.):]\s*(.+)/);
        if (m) out.push(m[1].trim());
    }
    while (out.length < questions.length) out.push("No explanation available.");
    return out.slice(0, questions.length);
}

async function finishQuiz(chatId, quiz) {
    const total = quiz.questions.length;
    const pct = Math.round((quiz.score / total) * 100);
    const correctAnswers = quiz.questions.map((q) => q.correct);

    let explanations = [];
    try {
        explanations = await generateExplanations(
            quiz.questions,
            correctAnswers,
        );
    } catch {
        explanations = quiz.questions.map(() => "No explanation available.");
    }

    let summary = `**Quiz complete**\n\nScore: ${quiz.score}/${total} (${pct}%)\n\n---\n\n`;
    for (let i = 0; i < quiz.questions.length; i++) {
        const q = quiz.questions[i];
        const a = quiz.answers[i];
        const isCorrect = a.chosen === q.correct;
        const marker = isCorrect ? "✅" : "❌";
        summary += `${marker} **Q${i + 1}.** ${q.text}\n\n`;
        summary += `Your answer: ${a.chosen}) ${q.options[a.chosen]}\n`;
        if (!isCorrect)
            summary += `Correct answer: ${q.correct}) ${q.options[q.correct]}\n`;
        summary += `\n💡 ${explanations[i] || "No explanation available."}\n\n---\n\n`;
    }
    if (quiz.score === total) summary += "**Perfect score. Well done.**";
    else if (pct >= 60)
        summary += "**Solid effort. Review the ones you missed.**";
    else summary += "**Keep practising — you will get there.**";

    for (const part of splitLong(summary)) {
        await sendRichOrFallback(chatId, part).catch(() => {});
    }
    activeQuizzes.delete(chatId);
    console.log(`Quiz ${chatId}: finished with ${quiz.score}/${total}`);
}

async function triggerQuiz(chatId, replyToId, topic) {
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
    const cleanTopic = (topic && topic.trim()) || "general knowledge";

    console.log(`Quiz ${chatId}: building on "${cleanTopic}"`);

    const prompt = `Generate a ${QUIZ_QUESTIONS}-question multiple-choice quiz on: ${cleanTopic}

Format each question EXACTLY like this:

1. Question text?
A) option
B) option
C) option
D) option

2. Question text?
A) option
B) option
C) option
D) option

… and so on for all ${QUIZ_QUESTIONS} questions.

After all ${QUIZ_QUESTIONS} questions, write exactly:

Answers:
1. A
2. C
3. B
… and so on for all ${QUIZ_QUESTIONS} answers.

Do not write anything before "1." and do not write anything after the last answer line.`;

    const status = await bot
        .sendMessage(chatId, "Building your quiz…", {
            reply_to_message_id: replyToId,
            allow_sending_without_reply: true,
        })
        .catch(() => null);

    try {
        const result = await generateSilent([
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
        ]);

        const questions = parseQuiz(result.content);
        console.log(
            `Quiz ${chatId}: parsed ${questions.length} questions (need ${QUIZ_MIN_ACCEPT})`,
        );

        if (questions.length < QUIZ_MIN_ACCEPT) {
            if (status)
                await bot
                    .deleteMessage(chatId, status.message_id)
                    .catch(() => {});
            return bot
                .sendMessage(
                    chatId,
                    `I only built ${questions.length} clean questions. Try a more specific topic.`,
                    {
                        reply_to_message_id: replyToId,
                        allow_sending_without_reply: true,
                    },
                )
                .catch(() => {});
        }

        chat.messages.push({ role: "user", content: prompt });
        chat.messages.push({ role: "assistant", content: result.content });
        chat.lastReasoning = result.reasoning;

        if (status)
            await bot.deleteMessage(chatId, status.message_id).catch(() => {});

        const quiz = {
            questions: questions.slice(0, QUIZ_QUESTIONS),
            index: 0,
            score: 0,
            answers: [],
            messageId: null,
            chatId,
        };
        activeQuizzes.set(chatId, quiz);
        console.log(`Quiz ${chatId}: starting, sending Q1`);
        await sendQuizQuestion(chatId, quiz);
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

// ═══════════════════════════════════════════════════════
//  FLASHCARD FLOW
// ═══════════════════════════════════════════════════════

function buildFlashcardKeyboard(index, revealed, isLast) {
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

async function sendFlashcardFront(chatId, deck) {
    const card = deck.cards[deck.index];
    const body = `**Card ${deck.index + 1} of ${deck.cards.length}**\n\n${card.front}`;
    const sent = await sendRichOrFallback(chatId, body, {
        reply_markup: buildFlashcardKeyboard(deck.index, false, false),
    }).catch(() => null);
    if (sent) deck.messageId = sent.message_id;
    deck.revealed = false;
    console.log(
        `Deck ${chatId}: card ${deck.index + 1}/${deck.cards.length} (front)`,
    );
}

async function sendFlashcardBack(chatId, deck) {
    const card = deck.cards[deck.index];
    const isLast = deck.index === deck.cards.length - 1;
    const body = `**Card ${deck.index + 1} of ${deck.cards.length}**\n\n${card.front}\n\n**Answer**\n${card.back}`;
    const sent = await sendRichOrFallback(chatId, body, {
        reply_markup: buildFlashcardKeyboard(deck.index, true, isLast),
    }).catch(() => null);
    if (sent) deck.messageId = sent.message_id;
    deck.revealed = true;
    console.log(`Deck ${chatId}: card ${deck.index + 1} (back)`);
}

async function finishDeck(chatId, deck) {
    const body =
        `🎓 **Deck complete!**\n\n` +
        `You reviewed ${deck.cards.length} cards on _${deck.topic}_.\n\n` +
        `Want to test yourself? Just say: "quiz me on ${deck.topic}"\n\n` +
        `Or start a new one: "flashcards on [topic]"`;
    await sendRichOrFallback(chatId, body).catch(() => {});
    activeDecks.delete(chatId);
    console.log(`Deck ${chatId}: finished`);
}

async function triggerFlashcards(chatId, replyToId, topic) {
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
    const cleanTopic = (topic && topic.trim()) || "general knowledge";

    console.log(`Deck ${chatId}: building on "${cleanTopic}"`);

    const prompt = `Generate exactly ${FLASHCARD_COUNT} study flashcards on: ${cleanTopic}

Each card tests ONE key concept, term, formula, definition, or fact.

Format EXACTLY:

1. Q: <front>
A: <back>

2. Q: ...
A: ...

… and so on for all ${FLASHCARD_COUNT} cards.

Use LaTeX for any math ($...$). Keep each side concise — 1 to 3 sentences.
No preamble. Start with "1. Q:" and end after the fifth A.`;

    const status = await bot
        .sendMessage(chatId, "Building your deck…", {
            reply_to_message_id: replyToId,
            allow_sending_without_reply: true,
        })
        .catch(() => null);

    try {
        const result = await generateSilent(
            [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: prompt },
            ],
            4096,
        );

        const cards = parseFlashcards(result.content);
        console.log(
            `Deck ${chatId}: parsed ${cards.length} cards (need ${FLASHCARD_MIN_ACCEPT})`,
        );

        if (cards.length < FLASHCARD_MIN_ACCEPT) {
            if (status)
                await bot
                    .deleteMessage(chatId, status.message_id)
                    .catch(() => {});
            return bot
                .sendMessage(
                    chatId,
                    `I only built ${cards.length} clean cards. Try a more specific topic.`,
                    {
                        reply_to_message_id: replyToId,
                        allow_sending_without_reply: true,
                    },
                )
                .catch(() => {});
        }

        chat.messages.push({ role: "user", content: prompt });
        chat.messages.push({ role: "assistant", content: result.content });
        chat.lastReasoning = result.reasoning;

        if (status)
            await bot.deleteMessage(chatId, status.message_id).catch(() => {});

        const deck = {
            cards: cards.slice(0, FLASHCARD_COUNT),
            index: 0,
            revealed: false,
            messageId: null,
            chatId,
            topic: cleanTopic,
        };
        activeDecks.set(chatId, deck);
        await sendFlashcardFront(chatId, deck);
    } catch (err) {
        if (status)
            await bot.deleteMessage(chatId, status.message_id).catch(() => {});
        console.error("flashcard generation error:", err.message);
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

// ═══════════════════════════════════════════════════════
//  WELCOME
// ═══════════════════════════════════════════════════════

const WELCOME_PRIVATE = `👋 I'm *Prof* — your study partner.

Just *talk to me normally*. Try:

• _explain photosynthesis in simple terms_
• _quiz me on the French Revolution_
• _flashcards on cellular respiration_
• send me a photo of your homework

If you get stuck:
• \`/why\` — see my reasoning for the last answer
• \`/reset\` — start fresh
• \`/context\` — see what I remember`;

const WELCOME_GROUP = `👋 I'm *Prof* — your study partner.

Mention me (@${botUsername}) or reply to one of my messages, then just *talk normally*. Try:

• _@${botUsername} quiz me on algebra_
• _@${botUsername} explain the water cycle_
• send a photo of your homework + mention me

*Tips:*
• Quiz mode asks ONE question at a time — tap A/B/C/D to answer.
• Scores and explanations come at the end.
• \`/reset\` to cancel anything running.`;

// ═══════════════════════════════════════════════════════
//  COMMANDS (backup — natural language is primary)
// ═══════════════════════════════════════════════════════

bot.onText(/^\/start/, (msg) => {
    const isGroup = msg.chat.type !== "private";
    bot.sendMessage(msg.chat.id, isGroup ? WELCOME_GROUP : WELCOME_PRIVATE, {
        parse_mode: "Markdown",
        reply_to_message_id: msg.message_id,
        allow_sending_without_reply: true,
    }).catch(() => {});
});

bot.onText(/^\/help/, (msg) => {
    bot.sendMessage(
        msg.chat.id,
        'Just talk to me normally — try "quiz me on biology" or "explain photosynthesis".',
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
    activeQuizzes.delete(msg.chat.id);
    activeDecks.delete(msg.chat.id);
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
    sendRichOrFallback(msg.chat.id, text, {
        reply_to_message_id: msg.message_id,
        allow_sending_without_reply: true,
    }).catch(() => {});
});

bot.onText(/^\/context/, (msg) => {
    const chat = getChat(msg.chat.id);
    const turns = chat.messages.length;
    const chars = chat.messages.reduce((n, m) => {
        if (typeof m.content === "string") return n + m.content.length;
        if (Array.isArray(m.content))
            return n + m.content.reduce((k, p) => k + (p.text?.length || 0), 0);
        return n;
    }, 0);
    bot.sendMessage(
        msg.chat.id,
        `📊 Memory: ${turns} message${turns === 1 ? "" : "s"} (~${chars} chars).\n` +
            `I keep the last ${MAX_CONTEXT_MESSAGES} turns. /reset clears everything.`,
        {
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true,
        },
    ).catch(() => {});
});

bot.onText(/^\/quiz(?:\s+(.+))?/, (msg, match) => {
    triggerQuiz(msg.chat.id, msg.message_id, (match[1] || "").trim());
});

bot.onText(/^\/flashcards?(?:\s+(.+))?/, (msg, match) => {
    triggerFlashcards(msg.chat.id, msg.message_id, (match[1] || "").trim());
});

// ═══════════════════════════════════════════════════════
//  CALLBACK HANDLER (quiz buttons + flashcard buttons)
// ═══════════════════════════════════════════════════════

bot.on("callback_query", async (query) => {
    const data = query.data;
    if (!data) return;

    // Flashcard branch
    if (data.startsWith("flash:")) {
        const [, indexStr, action] = data.split(":");
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
                    .answerCallbackQuery(query.id, {
                        text: "Already revealed.",
                    })
                    .catch(() => {});
            await bot
                .answerCallbackQuery(query.id, { text: "Revealed." })
                .catch(() => {});
            await bot.deleteMessage(chatId, deck.messageId).catch(() => {});
            await sendFlashcardBack(chatId, deck);
        } else if (action === "next") {
            await bot
                .answerCallbackQuery(query.id, { text: "Next." })
                .catch(() => {});
            await bot.deleteMessage(chatId, deck.messageId).catch(() => {});
            deck.index++;
            if (deck.index < deck.cards.length)
                await sendFlashcardFront(chatId, deck);
            else await finishDeck(chatId, deck);
        }
        return;
    }

    // Quiz branch
    if (!data.startsWith("quiz:")) return;

    const [, indexStr, chosen] = data.split(":");
    const chatId = query.message.chat.id;
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
    quiz.answers.push({ q: quiz.index + 1, chosen, correct: q.correct });
    if (chosen === q.correct) quiz.score++;

    // NEUTRAL — no correctness revealed until the very end
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
});

// ═══════════════════════════════════════════════════════
//  MAIN MESSAGE HANDLER
// ═══════════════════════════════════════════════════════

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

    // Special handling for natural text quiz/flashcard requests
    if (!isPhoto && cleanText) {
        // Check "reset" as natural language too
        if (
            /^(?:reset|start\s+over|clear|forget\s+(?:this|everything|that))$/i.test(
                cleanText,
            )
        ) {
            const c = getChat(chatId);
            c.messages = [];
            c.lastReasoning = "";
            activeQuizzes.delete(chatId);
            activeDecks.delete(chatId);
            return bot
                .sendMessage(chatId, "Cleared. What are we working on?", {
                    reply_to_message_id: msg.message_id,
                    allow_sending_without_reply: true,
                })
                .catch(() => {});
        }

        // Flashcard intent first (more specific)
        const flashTopic = detectFlashcardIntent(cleanText);
        if (flashTopic !== null) {
            console.log(
                `Chat ${chatId}: FLASHCARD intent → "${flashTopic || "(no topic → general knowledge)"}"`,
            );
            return triggerFlashcards(chatId, msg.message_id, flashTopic);
        }

        const quizTopic = detectQuizIntent(cleanText);
        if (quizTopic !== null) {
            console.log(
                `Chat ${chatId}: QUIZ intent → "${quizTopic || "(no topic → general knowledge)"}"`,
            );
            return triggerQuiz(chatId, msg.message_id, quizTopic);
        }

        console.log(
            `Chat ${chatId}: normal chat → "${cleanText.slice(0, 50)}"`,
        );
    }

    const chat = getChat(chatId);

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
            chat.messages.push({ role: "assistant", content: result.content });
            chat.lastReasoning = result.reasoning;
        } else {
            chat.messages.pop();
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
