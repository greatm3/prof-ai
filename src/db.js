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

  CREATE INDEX IF NOT EXISTS idx_answers_user ON answers(user_id);
  CREATE INDEX IF NOT EXISTS idx_answers_topic ON answers(user_id, topic);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(started_by_user_id);
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

// ─── Exports ─────────────────────────────────────────
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

export function getUserTopicStats(userId, minAnswers = 3) {
    return db
        .prepare(
            `
    SELECT topic,
           COUNT(*) AS total,
           SUM(is_correct) AS correct,
           ROUND(SUM(is_correct) * 100.0 / COUNT(*), 1) AS accuracy
    FROM answers
    WHERE user_id = ? AND topic IS NOT NULL
    GROUP BY topic
    HAVING total >= ?
    ORDER BY accuracy DESC
  `,
        )
        .all(userId, minAnswers);
}

export function getUserOverall(userId) {
    return (
        db
            .prepare(
                `
    SELECT COUNT(*) AS total_answers,
           COALESCE(SUM(is_correct), 0) AS total_correct,
           ROUND(COALESCE(SUM(is_correct) * 100.0 / NULLIF(COUNT(*), 0), 0), 1) AS accuracy
    FROM answers
    WHERE user_id = ?
  `,
            )
            .get(userId) || { total_answers: 0, total_correct: 0, accuracy: 0 }
    );
}

export function getUserSessionCount(userId) {
    return db
        .prepare(
            `
    SELECT COUNT(*) AS n FROM sessions
    WHERE started_by_user_id = ? AND completed_at IS NOT NULL
  `,
        )
        .get(userId).n;
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

// ─── Admin queries ────────────────────────────────────
export function adminGlobalStats() {
    return {
        users: db.prepare("SELECT COUNT(*) AS n FROM users").get().n,
        sessions: db
            .prepare(
                "SELECT COUNT(*) AS n FROM sessions WHERE completed_at IS NOT NULL",
            )
            .get().n,
        answers: db.prepare("SELECT COUNT(*) AS n FROM answers").get().n,
        active_24h: db
            .prepare(
                `SELECT COUNT(DISTINCT user_id) AS n FROM users WHERE last_seen > ?`,
            )
            .get(Date.now() - 24 * 60 * 60 * 1000).n,
    };
}

export function adminUserList() {
    return db
        .prepare(
            `
    SELECT u.user_id, u.username, u.first_name, u.last_seen,
           (SELECT COUNT(*) FROM answers a WHERE a.user_id = u.user_id) AS answers,
           (SELECT ROUND(COALESCE(SUM(is_correct) * 100.0 / NULLIF(COUNT(*), 0), 0), 1)
              FROM answers a WHERE a.user_id = u.user_id) AS accuracy
    FROM users u
    ORDER BY u.last_seen DESC
    LIMIT 100
  `,
        )
        .all();
}

export function adminRecentSessions(limit = 50) {
    return db
        .prepare(
            `
    SELECT s.id, s.type, s.topic, s.score, s.total_questions, s.created_at, s.completed_at,
           u.username, u.first_name
    FROM sessions s LEFT JOIN users u ON u.user_id = s.started_by_user_id
    WHERE s.completed_at IS NOT NULL
    ORDER BY s.completed_at DESC
    LIMIT ?
  `,
        )
        .all(limit);
}

export function adminUserDetail(userId) {
    const user = db
        .prepare("SELECT * FROM users WHERE user_id = ?")
        .get(userId);
    if (!user) return null;
    const topics = db
        .prepare(
            `
    SELECT topic, COUNT(*) AS total, SUM(is_correct) AS correct,
           ROUND(SUM(is_correct) * 100.0 / COUNT(*), 1) AS accuracy
    FROM answers WHERE user_id = ? AND topic IS NOT NULL
    GROUP BY topic ORDER BY accuracy DESC
  `,
        )
        .all(userId);
    const sessions = db
        .prepare(
            `
    SELECT id, type, topic, score, total_questions, completed_at
    FROM sessions WHERE started_by_user_id = ? AND completed_at IS NOT NULL
    ORDER BY completed_at DESC LIMIT 20
  `,
        )
        .all(userId);
    return { user, topics, sessions };
}
