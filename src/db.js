import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, "prof.db"));
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
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
  );

  CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    question_text TEXT,
    topic TEXT,
    is_correct INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    user_id INTEGER,
    role TEXT NOT NULL,
    content TEXT,
    has_photo INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_answers_user ON answers(user_id);
  CREATE INDEX IF NOT EXISTS idx_answers_topic ON answers(user_id, topic);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(started_by_user_id);
  CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
`);

// ─── Prepared statements ─────────────────────────────
const upsertUserStmt = db.prepare(`
  INSERT INTO users (user_id, username, first_name, first_seen, last_seen)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    username = excluded.username,
    first_name = excluded.first_name,
    last_seen = excluded.last_seen
`);

const createSessionStmt = db.prepare(`
  INSERT INTO sessions (chat_id, started_by_user_id, type, topic, source_type, total_questions, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const completeSessionStmt = db.prepare(`
  UPDATE sessions SET score = ?, completed_at = ? WHERE id = ?
`);

const logAnswerStmt = db.prepare(`
  INSERT INTO answers (session_id, user_id, question_text, topic, is_correct, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const logMessageStmt = db.prepare(`
  INSERT INTO messages (chat_id, user_id, role, content, has_photo, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

// ─── Writes ──────────────────────────────────────────
export function upsertUser(user) {
    if (!user?.id) return;
    upsertUserStmt.run(
        user.id,
        user.username || null,
        user.first_name || null,
        Date.now(),
        Date.now(),
    );
}

export function createSession({
    chatId,
    userId,
    type,
    topic,
    sourceType = "text",
    totalQuestions,
}) {
    const r = createSessionStmt.run(
        chatId,
        userId || null,
        type,
        topic || null,
        sourceType,
        totalQuestions || null,
        Date.now(),
    );
    return Number(r.lastInsertRowid);
}

export function completeSession(sessionId, score) {
    completeSessionStmt.run(score, Date.now(), sessionId);
}

export function logAnswer({
    sessionId,
    userId,
    questionText,
    topic,
    isCorrect,
}) {
    logAnswerStmt.run(
        sessionId,
        userId,
        questionText || null,
        topic || null,
        isCorrect ? 1 : 0,
        Date.now(),
    );
}

export function logMessage({
    chatId,
    userId,
    role,
    content,
    hasPhoto = false,
}) {
    logMessageStmt.run(
        chatId,
        userId || null,
        role,
        content || "",
        hasPhoto ? 1 : 0,
        Date.now(),
    );
}

// ─── User-level reads ────────────────────────────────
export function getUserOverall(userId) {
    const r = db
        .prepare(
            `
    SELECT COUNT(*) AS total, COALESCE(SUM(is_correct), 0) AS correct
    FROM answers WHERE user_id = ?
  `,
        )
        .get(userId);
    const total = Number(r?.total || 0);
    const correct = Number(r?.correct || 0);
    return {
        total_answers: total,
        total_correct: correct,
        accuracy: total > 0 ? Math.round((correct / total) * 1000) / 10 : 0,
    };
}

export function getUserSessionCount(userId) {
    return Number(
        db
            .prepare(
                `
    SELECT COUNT(*) AS n FROM sessions
    WHERE started_by_user_id = ? AND completed_at IS NOT NULL
  `,
            )
            .get(userId)?.n || 0,
    );
}

export function getUserLastSession(userId) {
    return db
        .prepare(
            `
    SELECT type, topic, score, total_questions, completed_at
    FROM sessions
    WHERE started_by_user_id = ? AND completed_at IS NOT NULL
    ORDER BY completed_at DESC LIMIT 1
  `,
        )
        .get(userId);
}

export function getUserTopicStats(userId, minAnswers = 3) {
    return db
        .prepare(
            `
    SELECT topic, COUNT(*) AS total, SUM(is_correct) AS correct
    FROM answers
    WHERE user_id = ? AND topic IS NOT NULL
    GROUP BY topic
    HAVING total >= ?
    ORDER BY correct * 1.0 / total DESC
  `,
        )
        .all(userId, minAnswers)
        .map((t) => ({
            topic: t.topic,
            total: Number(t.total),
            correct: Number(t.correct),
            accuracy:
                Number(t.total) > 0
                    ? Math.round((Number(t.correct) / Number(t.total)) * 1000) /
                      10
                    : 0,
        }));
}

// ─── Admin reads (simple, single-table queries) ──────
export function adminGlobalStats() {
    return {
        users: Number(
            db.prepare("SELECT COUNT(*) AS n FROM users").get()?.n || 0,
        ),
        sessions: Number(
            db
                .prepare(
                    "SELECT COUNT(*) AS n FROM sessions WHERE completed_at IS NOT NULL",
                )
                .get()?.n || 0,
        ),
        answers: Number(
            db.prepare("SELECT COUNT(*) AS n FROM answers").get()?.n || 0,
        ),
        messages: Number(
            db.prepare("SELECT COUNT(*) AS n FROM messages").get()?.n || 0,
        ),
        active_24h: Number(
            db
                .prepare("SELECT COUNT(*) AS n FROM users WHERE last_seen > ?")
                .get(Date.now() - 24 * 60 * 60 * 1000)?.n || 0,
        ),
    };
}

export function adminUserList() {
    const rows = db
        .prepare(
            `
    SELECT user_id, username, first_name, first_seen, last_seen
    FROM users
    ORDER BY last_seen DESC
    LIMIT 200
  `,
        )
        .all();

    // Enrich each row with simple aggregate queries (safe, no joins)
    return rows.map((u) => {
        const a = db
            .prepare(
                `
      SELECT COUNT(*) AS total, COALESCE(SUM(is_correct), 0) AS correct
      FROM answers WHERE user_id = ?
    `,
            )
            .get(u.user_id);
        const s = db
            .prepare(
                `
      SELECT COUNT(*) AS n FROM sessions
      WHERE started_by_user_id = ? AND completed_at IS NOT NULL
    `,
            )
            .get(u.user_id);
        const m = db
            .prepare(
                `
      SELECT COUNT(*) AS n FROM messages WHERE user_id = ?
    `,
            )
            .get(u.user_id);
        const total = Number(a?.total || 0);
        const correct = Number(a?.correct || 0);
        return {
            user_id: u.user_id,
            username: u.username,
            first_name: u.first_name,
            first_seen: u.first_seen,
            last_seen: u.last_seen,
            answers: total,
            correct,
            accuracy: total > 0 ? Math.round((correct / total) * 1000) / 10 : 0,
            sessions: Number(s?.n || 0),
            messages: Number(m?.n || 0),
        };
    });
}

export function adminRecentSessions(limit = 50) {
    const rows = db
        .prepare(
            `
    SELECT id, started_by_user_id, type, topic, score, total_questions, created_at, completed_at
    FROM sessions
    WHERE completed_at IS NOT NULL
    ORDER BY completed_at DESC
    LIMIT ?
  `,
        )
        .all(limit);

    return rows.map((s) => {
        const u = db
            .prepare("SELECT username, first_name FROM users WHERE user_id = ?")
            .get(s.started_by_user_id);
        return {
            ...s,
            username: u?.username || null,
            first_name: u?.first_name || null,
        };
    });
}

export function adminUserDetail(userId) {
    const user = db
        .prepare(
            `
    SELECT user_id, username, first_name, first_seen, last_seen
    FROM users WHERE user_id = ?
  `,
        )
        .get(userId);
    if (!user) return null;

    const overall = getUserOverall(userId);
    const sessionsCount = getUserSessionCount(userId);

    const topics = db
        .prepare(
            `
    SELECT topic, COUNT(*) AS total, SUM(is_correct) AS correct
    FROM answers WHERE user_id = ? AND topic IS NOT NULL
    GROUP BY topic ORDER BY total DESC
  `,
        )
        .all(userId)
        .map((t) => ({
            topic: t.topic,
            total: Number(t.total),
            correct: Number(t.correct),
            accuracy:
                Number(t.total) > 0
                    ? Math.round((Number(t.correct) / Number(t.total)) * 1000) /
                      10
                    : 0,
        }));

    const sessions = db
        .prepare(
            `
    SELECT id, type, topic, score, total_questions, created_at, completed_at
    FROM sessions WHERE started_by_user_id = ? AND completed_at IS NOT NULL
    ORDER BY completed_at DESC LIMIT 30
  `,
        )
        .all(userId);

    const messages = db
        .prepare(
            `
    SELECT id, role, content, has_photo, created_at
    FROM messages WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 100
  `,
        )
        .all(userId);

    return {
        user,
        stats: {
            ...overall,
            sessions: sessionsCount,
        },
        topics,
        sessions,
        messages,
    };
}
