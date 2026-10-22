import {
    getUserTopicStats,
    getUserOverall,
    getUserSessionCount,
    getUserLastSession,
} from "./db.js";

const STRONG_THRESHOLD = 80;
const WEAK_THRESHOLD = 60;

export async function buildProgressReport(userId) {
    const overall = await getUserOverall(userId);
    if (overall.total_answers === 0) {
        return `📊 No stats yet.\n\nTake a quiz or review a flashcard deck first, then ask me "how am I doing?"`;
    }

    const quizzes = await getUserSessionCount(userId);
    const topics = await getUserTopicStats(userId, 3);
    const strengths = topics.filter((t) => t.accuracy >= STRONG_THRESHOLD);
    const weaknesses = topics.filter((t) => t.accuracy < WEAK_THRESHOLD);
    const lastSession = await getUserLastSession(userId);

    let out = `📊 **Your progress**\n\n`;
    out += `Overall: ${overall.accuracy}% across ${overall.total_answers} questions\n`;
    out += `Quizzes completed: ${quizzes}\n\n`;

    if (strengths.length) {
        out += `✅ **Strong areas**\n`;
        for (const t of strengths.slice(0, 5)) {
            out += `• ${t.topic} — ${t.accuracy}% (${t.total} q)\n`;
        }
        out += `\n`;
    }

    if (weaknesses.length) {
        out += `⚠️ **Weak areas**\n`;
        for (const t of weaknesses.slice(0, 5)) {
            out += `• ${t.topic} — ${t.accuracy}% (${t.total} q)\n`;
        }
        out += `\n`;
    }

    if (weaknesses.length) {
        out += `💡 **Focus on ${weaknesses[0].topic} next.** Just say "quiz me on ${weaknesses[0].topic}" or "flashcards on ${weaknesses[0].topic}" and I'll build a session around it.`;
    } else if (topics.length < 2) {
        out += `💡 Try a few more topics to see clearer strengths and weaknesses.`;
    } else {
        out += `💡 You're solid on everything tracked so far. Try a new topic to keep growing.`;
    }

    if (lastSession) {
        out += `\n\n_Last session: ${lastSession.type} on ${lastSession.topic || "general"} — ${lastSession.score ?? "?"}/${lastSession.total_questions ?? "?"}_`;
    }

    return out;
}

export function buildMiniStats(userId) {
    const overall = await getUserOverall(userId);
    if (overall.total_answers === 0) return null;
    return `${overall.total_correct}/${overall.total_answers} correct (${overall.accuracy}%)`;
}
