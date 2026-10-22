import { createClient } from "@libsql/client";
import "dotenv/config";

export const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

// ─── Schema init (retried — free-tier remote can hiccup at boot) ─────
const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        started_by_user_id INTEGER,
        type TEXT NOT NULL,
        topic TEXT,
        source_type TEXT NOT NULL DEFAULT 'text',
        score INTEGER,
        total_questions INTEGER,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS answers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        question_text TEXT,
        topic TEXT,
        is_correct INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        user_id INTEGER,
        role TEXT NOT NULL,
        content TEXT,
        has_photo INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_answers_user ON answers(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_answers_topic ON answers(user_id, topic)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(started_by_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at)`,
];

async function initSchema(attempt = 1) {
    try {
        await db.batch(SCHEMA, "write");
        console.log("[db] schema ready");
    } catch (err) {
        console.error(
            `[db] schema init failed (attempt ${attempt}):`,
            err.message,
        );
        if (attempt >= 3) throw err;
        await new Promise((r) => setTimeout(r, attempt * 1500));
        return initSchema(attempt + 1);
    }
}

await initSchema();

// ─── Coercion helpers (libSQL returns numbers or bigints) ────────────
function num(v) {
    return v == null ? 0 : Number(v) || 0;
}
function str(v) {
    return v == null ? null : String(v);
}
function int(v) {
    return v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null;
}

function plainUser(u) {
    return {
        user_id: num(u.user_id),
        username: str(u.username),
        first_name: str(u.first_name),
        first_seen: num(u.first_seen),
        last_seen: num(u.last_seen),
    };
}

// ─── Writes ──────────────────────────────────────────────────────────
export async function upsertUser(user) {
    if (!user?.id) return;
    const now = Date.now();
    await db.execute({
        sql: `INSERT INTO users (user_id, username, first_name, first_seen, last_seen)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET
                username   = excluded.username,
                first_name = excluded.first_name,
                last_seen  = excluded.last_seen`,
        args: [
            user.id,
            user.username ?? null,
            user.first_name ?? null,
            now,
            now,
        ],
    });
}

export async function createSession({
    chatId,
    userId,
    type,
    topic,
    sourceType = "text",
    totalQuestions,
}) {
    const r = await db.execute({
        sql: `INSERT INTO sessions
              (chat_id, started_by_user_id, type, topic, source_type, total_questions, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
            chatId,
            userId ?? null,
            type,
            topic ?? null,
            sourceType,
            totalQuestions ?? null,
            Date.now(),
        ],
    });
    return Number(r.lastInsertRowid);
}

export async function completeSession(sessionId, score) {
    await db.execute({
        sql: `UPDATE sessions SET score = ?, completed_at = ? WHERE id = ?`,
        args: [score ?? null, Date.now(), sessionId],
    });
}

export async function logAnswer({
    sessionId,
    userId,
    questionText,
    topic,
    isCorrect,
}) {
    await db.execute({
        sql: `INSERT INTO answers
              (session_id, user_id, question_text, topic, is_correct, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
            sessionId,
            userId ?? null,
            questionText ?? null,
            topic ?? null,
            isCorrect ? 1 : 0,
            Date.now(),
        ],
    });
}

export async function logMessage({
    chatId,
    userId,
    role,
    content,
    hasPhoto = false,
}) {
    await db.execute({
        sql: `INSERT INTO messages (chat_id, user_id, role, content, has_photo, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
            chatId,
            userId ?? null,
            role,
            content ?? "",
            hasPhoto ? 1 : 0,
            Date.now(),
        ],
    });
}

// ─── User-level reads ────────────────────────────────────────────────
export async function getUserOverall(userId) {
    const { rows } = await db.execute({
        sql: `SELECT COUNT(*) AS total, COALESCE(SUM(is_correct), 0) AS correct
              FROM answers WHERE user_id = ?`,
        args: [userId],
    });
    const total = num(rows[0]?.total);
    const correct = num(rows[0]?.correct);
    return {
        total_answers: total,
        total_correct: correct,
        accuracy: total > 0 ? Math.round((correct / total) * 1000) / 10 : 0,
    };
}

export async function getUserSessionCount(userId) {
    const { rows } = await db.execute({
        sql: `SELECT COUNT(*) AS n FROM sessions
              WHERE started_by_user_id = ? AND completed_at IS NOT NULL`,
        args: [userId],
    });
    return num(rows[0]?.n);
}

export async function getUserLastSession(userId) {
    const { rows } = await db.execute({
        sql: `SELECT type, topic, score, total_questions, completed_at
              FROM sessions
              WHERE started_by_user_id = ? AND completed_at IS NOT NULL
              ORDER BY completed_at DESC LIMIT 1`,
        args: [userId],
    });
    return rows[0] ?? null;
}

export async function getUserTopicStats(userId, minAnswers = 3) {
    const { rows } = await db.execute({
        sql: `SELECT topic, COUNT(*) AS total, SUM(is_correct) AS correct
              FROM answers
              WHERE user_id = ? AND topic IS NOT NULL
              GROUP BY topic
              HAVING total >= ?
              ORDER BY correct * 1.0 / total DESC`,
        args: [userId, minAnswers],
    });
    return Array.from(rows || []).map((t) => {
        const total = num(t.total);
        const correct = num(t.correct);
        return {
            topic: t.topic,
            total,
            correct,
            accuracy: total > 0 ? Math.round((correct / total) * 1000) / 10 : 0,
        };
    });
}

// ─── Admin reads ─────────────────────────────────────────────────────
export async function adminGlobalStats() {
    const [u, s, a, m, ac] = await db.batch(
        [
            "SELECT COUNT(*) AS n FROM users",
            "SELECT COUNT(*) AS n FROM sessions WHERE completed_at IS NOT NULL",
            "SELECT COUNT(*) AS n FROM answers",
            "SELECT COUNT(*) AS n FROM messages",
            {
                sql: "SELECT COUNT(*) AS n FROM users WHERE last_seen > ?",
                args: [Date.now() - 86400000],
            },
        ],
        "read",
    );

    return {
        users: num(u.rows[0]?.n),
        sessions: num(s.rows[0]?.n),
        answers: num(a.rows[0]?.n),
        messages: num(m.rows[0]?.n),
        active_24h: num(ac.rows[0]?.n),
    };
}

export async function adminUserList() {
    const { rows } = await db.execute({
        sql: `SELECT u.user_id, u.username, u.first_name, u.first_seen, u.last_seen,
                     COALESCE(a.total, 0)    AS answers,
                     COALESCE(a.correct, 0)  AS correct,
                     COALESCE(s.n, 0)        AS sessions,
                     COALESCE(m.n, 0)        AS messages
              FROM users u
              LEFT JOIN (
                  SELECT user_id, COUNT(*) AS total, SUM(is_correct) AS correct
                  FROM answers GROUP BY user_id
              ) a ON a.user_id = u.user_id
              LEFT JOIN (
                  SELECT started_by_user_id AS uid, COUNT(*) AS n
                  FROM sessions WHERE completed_at IS NOT NULL
                  GROUP BY started_by_user_id
              ) s ON s.uid = u.user_id
              LEFT JOIN (
                  SELECT user_id, COUNT(*) AS n FROM messages GROUP BY user_id
              ) m ON m.user_id = u.user_id
              ORDER BY u.last_seen DESC
              LIMIT 200`,
        args: [],
    });

    return Array.from(rows || []).map((u) => {
        const p = plainUser(u);
        const total = num(u.answers);
        const correct = num(u.correct);
        return {
            ...p,
            answers: total,
            correct,
            accuracy: total > 0 ? Math.round((correct / total) * 1000) / 10 : 0,
            sessions: num(u.sessions),
            messages: num(u.messages),
        };
    });
}

export async function adminRecentSessions(limit = 50) {
    const { rows } = await db.execute({
        sql: `SELECT s.id, s.started_by_user_id, s.type, s.topic, s.score,
                     s.total_questions, s.created_at, s.completed_at,
                     u.username, u.first_name
              FROM sessions s
              LEFT JOIN users u ON u.user_id = s.started_by_user_id
              WHERE s.completed_at IS NOT NULL
              ORDER BY s.completed_at DESC
              LIMIT ?`,
        args: [limit],
    });

    return Array.from(rows || []).map((s) => ({
        id: num(s.id),
        started_by_user_id: int(s.started_by_user_id),
        type: str(s.type) || "",
        topic: str(s.topic),
        score: int(s.score),
        total_questions: int(s.total_questions),
        created_at: num(s.created_at),
        completed_at: int(s.completed_at),
        username: str(s.username),
        first_name: str(s.first_name),
    }));
}

export async function adminUserDetail(userId) {
    const [
        userRs,
        overallRs,
        sessionCountRs,
        topicsRs,
        sessionsRs,
        messagesRs,
    ] = await db.batch(
        [
            {
                sql: `SELECT user_id, username, first_name, first_seen, last_seen
                          FROM users WHERE user_id = ?`,
                args: [userId],
            },
            {
                sql: `SELECT COUNT(*) AS total, COALESCE(SUM(is_correct), 0) AS correct
                          FROM answers WHERE user_id = ?`,
                args: [userId],
            },
            {
                sql: `SELECT COUNT(*) AS n FROM sessions
                          WHERE started_by_user_id = ? AND completed_at IS NOT NULL`,
                args: [userId],
            },
            {
                sql: `SELECT topic, COUNT(*) AS total, SUM(is_correct) AS correct
                          FROM answers WHERE user_id = ? AND topic IS NOT NULL
                          GROUP BY topic ORDER BY total DESC`,
                args: [userId],
            },
            {
                sql: `SELECT id, type, topic, score, total_questions, created_at, completed_at
                          FROM sessions
                          WHERE started_by_user_id = ? AND completed_at IS NOT NULL
                          ORDER BY completed_at DESC LIMIT 30`,
                args: [userId],
            },
            {
                sql: `SELECT id, role, content, has_photo, created_at
                          FROM messages WHERE user_id = ?
                          ORDER BY created_at DESC LIMIT 100`,
                args: [userId],
            },
        ],
        "read",
    );

    const rawUser = userRs.rows[0];
    if (!rawUser) return null;
    const user = plainUser(rawUser);

    const total = num(overallRs.rows[0]?.total);
    const correct = num(overallRs.rows[0]?.correct);

    const topics = Array.from(topicsRs.rows || []).map((t) => {
        const tt = num(t.total);
        const tc = num(t.correct);
        return {
            topic: str(t.topic) || "",
            total: tt,
            correct: tc,
            accuracy: tt > 0 ? Math.round((tc / tt) * 1000) / 10 : 0,
        };
    });

    const sessions = Array.from(sessionsRs.rows || []).map((s) => ({
        id: num(s.id),
        type: str(s.type) || "",
        topic: str(s.topic),
        score: int(s.score),
        total_questions: int(s.total_questions),
        created_at: num(s.created_at),
        completed_at: int(s.completed_at),
    }));

    const messages = Array.from(messagesRs.rows || []).map((m) => ({
        id: num(m.id),
        role: str(m.role) || "",
        content: str(m.content) || "",
        has_photo: num(m.has_photo),
        created_at: num(m.created_at),
    }));

    return {
        user,
        stats: {
            total_answers: total,
            total_correct: correct,
            accuracy: total > 0 ? Math.round((correct / total) * 1000) / 10 : 0,
            sessions: num(sessionCountRs.rows[0]?.n),
        },
        topics,
        sessions,
        messages,
    };
}

export async function adminDebug() {
    try {
        const { rows } = await db.execute("SELECT * FROM users LIMIT 5");
        const first = rows[0];
        return {
            ok: true,
            rowCount: rows.length,
            isArray: Array.isArray(rows),
            sampleTypes: first
                ? Object.fromEntries(
                      Object.entries(first).map(([k, v]) => [k, typeof v]),
                  )
                : null,
            sample: first || null,
        };
    } catch (err) {
        return {
            ok: false,
            error: err.message,
            stack: (err.stack || "").split("\n").slice(0, 5),
        };
    }
}
