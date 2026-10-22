import { FLASHCARD_COUNT } from "./config.js";

export function cleanOutput(raw) {
    return raw
        .replace(/```[a-zA-Z]*\n?/g, "")
        .replace(/```/g, "")
        .replace(/\r\n/g, "\n")
        .trim();
}

export function parseQuiz(raw) {
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
        for (const m of answerBlock.matchAll(
            /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?(\d+)(?:\*\*)?[.):\s]+\s*(?:\*\*)?([A-D])(?:\*\*)?\b/g,
        )) {
            answers.push(m[2].toUpperCase());
        }
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

export function parseFlashcards(raw) {
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

// Normalize LaTeX delimiters so mdgramRich always recognises them.
// Handles: \(...\), \[...\], unclosed $, and bare backslash-math.
export function normalizeLatex(text) {
    if (!text || typeof text !== "string") return text;

    let out = text;

    // 1. \( ... \)  →  $ ... $   (inline)
    out = out.replace(/\\\(([\s\S]*?)\\\)/g, (_, inner) => `$${inner.trim()}$`);

    // 2. \[ ... \]  →  $$ ... $$  (display)
    out = out.replace(
        /\\\[([\s\S]*?)\\\]/g,
        (_, inner) => `$$${inner.trim()}$$`,
    );

    // 3. Fix dollar signs with leading/trailing spaces inside delimiters:
    //    "$ \frac{1}{2} $"  →  "$\frac{1}{2}$"
    out = out.replace(/\$\s+([^$]+?)\s+\$/g, (_, inner) => `$${inner.trim()}$`);

    // 4. Wrap bare math that contains backslashes but has no $ delimiters:
    //    "\frac{1}{2}"  →  "$\frac{1}{2}$"
    //    But only for segments that look like math (contain \frac, \sqrt, ^, _, etc.)
    out = out.replace(
        /(^|[\s(])((?:\\[a-zA-Z]+(?:\{[^}]*\})?|[a-zA-Z0-9]+[\^_]\{[^}]*\})+)(?=$|[\s).,;:!?])/g,
        (match, prefix, math) => {
            // Skip if already inside $...$
            const before = out.slice(0, out.indexOf(match));
            const dollarCount = (before.match(/\$/g) || []).length;
            if (dollarCount % 2 === 1) return match; // inside existing math
            return `${prefix}$${math}$`;
        },
    );

    // 5. Unclosed $ at end of string:  "$x^2"  →  "$x^2$"
    out = out.replace(/\$([^$]*?)$/g, (match, inner) => {
        if (!inner.trim()) return match; // bare $, leave it
        return `$${inner.trim()}$`;
    });

    return out;
}
