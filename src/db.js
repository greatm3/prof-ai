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
// ─── Admin reads (super defensive) ───────────────────
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

export function adminGlobalStats() {
    try {
        const u = db.prepare("SELECT COUNT(*) AS n FROM users").get();
        const s = db
            .prepare(
                "SELECT COUNT(*) AS n FROM sessions WHERE completed_at IS NOT NULL",
            )
            .get();
        const a = db.prepare("SELECT COUNT(*) AS n FROM answers").get();
        const m = db.prepare("SELECT COUNT(*) AS n FROM messages").get();
        const ac = db
            .prepare("SELECT COUNT(*) AS n FROM users WHERE last_seen > ?")
            .get(Date.now() - 86400000);
        return {
            users: num(u?.n),
            sessions: num(s?.n),
            answers: num(a?.n),
            messages: num(m?.n),
            active_24h: num(ac?.n),
        };
    } catch (err) {
        console.error("[db.adminGlobalStats] error:", err);
        throw err;
    }
}

export function adminUserList() {
    try {
        const raw = db
            .prepare(
                `
      SELECT user_id, username, first_name, first_seen, last_seen
      FROM users
      ORDER BY last_seen DESC
      LIMIT 200
    `,
            )
            .all();

        const rows = Array.from(raw || []);
        console.log(`[db.adminUserList] ${rows.length} row(s)`);

        return rows.map((u) => {
            const p = plainUser(u);

            const a = db
                .prepare(
                    "SELECT COUNT(*) AS total, COALESCE(SUM(is_correct), 0) AS correct FROM answers WHERE user_id = ?",
                )
                .get(p.user_id) || { total: 0, correct: 0 };

            const s = db
                .prepare(
                    "SELECT COUNT(*) AS n FROM sessions WHERE started_by_user_id = ? AND completed_at IS NOT NULL",
                )
                .get(p.user_id) || { n: 0 };

            const m = db
                .prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?")
                .get(p.user_id) || { n: 0 };

            const total = num(a.total);
            const correct = num(a.correct);

            return {
                ...p,
                answers: total,
                correct,
                accuracy:
                    total > 0 ? Math.round((correct / total) * 1000) / 10 : 0,
                sessions: num(s.n),
                messages: num(m.n),
            };
        });
    } catch (err) {
        console.error("[db.adminUserList] error:", err);
        throw err;
    }
}

export function adminRecentSessions(limit = 50) {
    try {
        const raw = db
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

        return Array.from(raw || []).map((s) => {
            const u = db
                .prepare(
                    "SELECT username, first_name FROM users WHERE user_id = ?",
                )
                .get(s.started_by_user_id);
            return {
                id: num(s.id),
                started_by_user_id: int(s.started_by_user_id),
                type: str(s.type) || "",
                topic: str(s.topic),
                score: int(s.score),
                total_questions: int(s.total_questions),
                created_at: num(s.created_at),
                completed_at: int(s.completed_at),
                username: str(u?.username),
                first_name: str(u?.first_name),
            };
        });
    } catch (err) {
        console.error("[db.adminRecentSessions] error:", err);
        throw err;
    }
}

export function adminUserDetail(userId) {
    try {
        const raw = db
            .prepare(
                "SELECT user_id, username, first_name, first_seen, last_seen FROM users WHERE user_id = ?",
            )
            .get(userId);

        if (!raw) return null;
        const user = plainUser(raw);

        const overall = getUserOverall(userId);
        const sessionsCount = getUserSessionCount(userId);

        const rawTopics = db
            .prepare(
                `
      SELECT topic, COUNT(*) AS total, SUM(is_correct) AS correct
      FROM answers WHERE user_id = ? AND topic IS NOT NULL
      GROUP BY topic ORDER BY total DESC
    `,
            )
            .all(userId);

        const topics = Array.from(rawTopics || []).map((t) => {
            const total = num(t.total);
            const correct = num(t.correct);
            return {
                topic: str(t.topic) || "",
                total,
                correct,
                accuracy:
                    total > 0 ? Math.round((correct / total) * 1000) / 10 : 0,
            };
        });

        const rawSessions = db
            .prepare(
                `
      SELECT id, type, topic, score, total_questions, created_at, completed_at
      FROM sessions WHERE started_by_user_id = ? AND completed_at IS NOT NULL
      ORDER BY completed_at DESC LIMIT 30
    `,
            )
            .all(userId);

        const sessions = Array.from(rawSessions || []).map((s) => ({
            id: num(s.id),
            type: str(s.type) || "",
            topic: str(s.topic),
            score: int(s.score),
            total_questions: int(s.total_questions),
            created_at: num(s.created_at),
            completed_at: int(s.completed_at),
        }));

        const rawMessages = db
            .prepare(
                `
      SELECT id, role, content, has_photo, created_at
      FROM messages WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 100
    `,
            )
            .all(userId);

        const messages = Array.from(rawMessages || []).map((m) => ({
            id: num(m.id),
            role: str(m.role) || "",
            content: str(m.content) || "",
            has_photo: num(m.has_photo),
            created_at: num(m.created_at),
        }));

        return {
            user,
            stats: { ...overall, sessions: sessionsCount },
            topics,
            sessions,
            messages,
        };
    } catch (err) {
        console.error("[db.adminUserDetail] error:", err);
        throw err;
    }
}

export function adminDebug() {
    try {
        const users = db.prepare("SELECT * FROM users LIMIT 5").all();
        const rows = Array.from(users || []);
        return {
            ok: true,
            rowCount: rows.length,
            isArray: Array.isArray(users),
            sampleTypes: rows[0]
                ? Object.fromEntries(
                      Object.entries(rows[0]).map(([k, v]) => [k, typeof v]),
                  )
                : null,
            sample: rows[0] || null,
        };
    } catch (err) {
        return {
            ok: false,
            error: err.message,
            stack: (err.stack || "").split("\n").slice(0, 5),
        };
    }
}
