const QUESTION_START =
    /^(?:what|how|why|when|where|who|which|is|are|was|were|do|does|did|can|could|would|should|will)\b/i;
const POLITE =
    /\b(please|now|thanks|thank\s+you|asap|for\s+me|quickly|real\s+quick|then|next)\b/gi;

export const PHOTO_REF =
    /^(?:this|these|that|the\s+(?:photo|image|picture|notes?|page|homework|sheet)|it|them)$/i;

export function detectQuizIntent(text) {
    if (!/\b(?:quiz|test|exam|examination)\b/i.test(text)) return null;

    const bare = text.replace(POLITE, "").replace(/\s+/g, " ").trim();
    if (
        /^(?:(?:i\s+(?:want|need)\s+)|(?:let'?s\s+(?:do\s+)?)|(?:give\s+me\s+)?)(?:a\s+|some\s+)?(?:quiz|test|exam)[.!\s]*$/i.test(
            bare,
        )
    ) {
        return "";
    }

    let m = text.match(
        /\b(?:quiz|test|exam)\s+(?:me\s+)?(?:on|about|over|for|covering|in|of)\s+(.+?)(?:[.!?]|$)/i,
    );
    if (m) return m[1].trim();

    if (/\b(?:quiz|test)\s+me\b/i.test(text)) {
        const t = text.match(
            /\b(?:on|about|over|for|covering|in|of)\s+(.+?)(?:[.!?]|$)/i,
        );
        return t ? t[1].trim() : "";
    }

    m = text.match(
        /\b(?:give|make|create|generate|build|do|want|need|would\s+like|please|can\s+you|can\s+i|could\s+you|i[''`]?d\s+like|i\s+want|i\s+need|let[''`]?s)\b[^.!?]{0,80}?\b(?:quiz|test|exam)\b(?:[^.!?]{0,40}?\b(?:on|about|over|for|covering|in|of)\s+(.+?))?(?:[.!?]|$)/i,
    );
    if (m) return m[1] ? m[1].trim() : "";

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

export function detectFlashcardIntent(text) {
    if (!/\bflash\s*cards?\b/i.test(text)) return null;

    const bare = text.replace(POLITE, "").replace(/\s+/g, " ").trim();
    if (
        /^(?:(?:i\s+(?:want|need)\s+)|(?:let'?s\s+(?:do\s+)?)|(?:give\s+me\s+)?)(?:a\s+|some\s+)?flash\s*cards?[.!\s]*$/i.test(
            bare,
        )
    ) {
        return "";
    }

    let m = text.match(
        /\bflash\s*cards?\s+(?:on|about|over|for|covering|in|of)\s+(.+?)(?:[.!?]|$)/i,
    );
    if (m) return m[1].trim();

    m = text.match(
        /\b(?:give|make|create|generate|build|do|want|need|would\s+like|please|can\s+you|can\s+i|could\s+you|i[''`]?d\s+like|i\s+want|i\s+need|let[''`]?s)\b[^.!?]{0,80}?\bflash\s*cards?\b(?:[^.!?]{0,40}?\b(?:on|about|over|for|covering|in|of)\s+(.+?))?(?:[.!?]|$)/i,
    );
    if (m) return m[1] ? m[1].trim() : "";

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

function cleanTopic(raw) {
    return raw
        .replace(/\s+(?:and\s+)?(?:show|give|send|tell)\s+me.*$/i, "")
        .replace(/\s+(?:please|for\s+me|now|quickly|thanks).*$/i, "")
        .replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, "")
        .trim();
}

export function detectImageIntent(text) {
    if (
        !/\b(?:draw|sketch|illustrate|generate\s+(?:a\s+)?(?:diagram|image|picture)|create\s+(?:a\s+)?(?:diagram|image|picture)|show\s+me\s+(?:a\s+)?(?:diagram|drawing|sketch)|make\s+(?:a\s+)?(?:diagram|drawing|sketch))\b/i.test(
            text,
        )
    ) {
        return null;
    }
    if (/\b(?:quiz|test|flashcard)\b/i.test(text)) return null;

    let m = text.match(
        /\b(?:draw|sketch|illustrate)\s+(?:a|an|the)?\s*(.+?)(?:[.!?]|$)/i,
    );
    if (m) {
        const t = cleanTopic(m[1]);
        if (t.length > 2) return t;
    }

    m = text.match(
        /\b(?:diagram|drawing|sketch|image|picture)\s+(?:of|for|showing)\s+(.+?)(?:[.!?]|$)/i,
    );
    if (m) {
        const t = cleanTopic(m[1]);
        if (t.length > 2) return t;
    }

    m = text.match(
        /\b(?:show\s+me|make|create|generate)\s+(?:a|an)?\s*(?:diagram|drawing|sketch|image|picture)\s+(?:of|for|showing)?\s*(.+?)(?:[.!?]|$)/i,
    );
    if (m) {
        const t = cleanTopic(m[1]);
        if (t.length > 2) return t;
    }

    return null;
}
