import { bot } from "./telegram.js";
import { ADMIN_USER_ID } from "./config.js";
import {
    getUserInfo,
    getUserCount,
    getMaxUsers,
    setSetting,
    blockUser,
    unblockUser,
    upsertUser,
    adminGlobalStats,
    listUsersForAdmin,
} from "./db.js";

export function isAdmin(userId) {
    return ADMIN_USER_ID != null && String(userId) === String(ADMIN_USER_ID);
}

const MSG_BLOCKED =
    "You've been removed from the beta. To rejoin, text 07074069485 — Great on WhatsApp/Telegram.";

function msgFull(count, limit) {
    return (
        `Beta list is full (${count}/${limit}). ` +
        `To secure a spot, text 07074069485 — Great on WhatsApp/Telegram.`
    );
}

export async function checkAccess(chatId, from, replyToId) {
    if (!from?.id) return false;
    if (isAdmin(from.id)) {
        await upsertUser(from);
        return true;
    }
    const info = await getUserInfo(from.id);
    if (info.blocked) {
        await bot
            .sendMessage(chatId, MSG_BLOCKED, {
                reply_to_message_id: replyToId,
                allow_sending_without_reply: true,
            })
            .catch(() => {});
        return false;
    }
    if (!info.exists) {
        const [count, limit] = await Promise.all([
            getUserCount(),
            getMaxUsers(),
        ]);
        if (count >= limit) {
            await bot
                .sendMessage(chatId, msgFull(count, limit), {
                    reply_to_message_id: replyToId,
                    allow_sending_without_reply: true,
                })
                .catch(() => {});
            return false;
        }
    }
    await upsertUser(from);
    return true;
}

export async function handleAdminCommand(msg, text) {
    const chatId = msg.chat.id;
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase().replace(/^\//, "");
    const args = parts.slice(1);

    const reply = (t, opts = {}) =>
        bot
            .sendMessage(chatId, t, {
                reply_to_message_id: msg.message_id,
                allow_sending_without_reply: true,
                ...opts,
            })
            .catch(() => {});

    if (cmd === "stats" || cmd === "admin") {
        const [stats, count, limit] = await Promise.all([
            adminGlobalStats(),
            getUserCount(),
            getMaxUsers(),
        ]);
        return reply(
            `📊 *Beta stats*\n\n` +
                `Active users: *${count}/${limit}*\n` +
                `Last 24h: ${stats.active_24h} active\n` +
                `Sessions: ${stats.sessions}\n` +
                `Answers: ${stats.answers}\n` +
                `Messages: ${stats.messages}`,
            { parse_mode: "Markdown" },
        );
    }

    if (cmd === "users") {
        const list = await listUsersForAdmin();
        if (!list.length) return reply("No users yet.");
        const lines = list.map((u) => {
            const name = u.username ? "@" + u.username : u.first_name || "anon";
            return `${u.blocked ? "🚫" : "✅"} ${u.user_id}  ${name}`;
        });
        return reply(`*Users (${list.length})*\n\n${lines.join("\n")}`, {
            parse_mode: "Markdown",
        });
    }

    if (cmd === "limit") {
        const n = Number(args[0]);
        if (!Number.isFinite(n) || n < 1) return reply("Usage: /limit 20");
        await setSetting("max_users", n);
        const count = await getUserCount();
        return reply(`✅ Max users set to ${n} (currently ${count} active)`);
    }

    if (cmd === "kick") {
        const id = Number(args[0]);
        if (!Number.isFinite(id)) return reply("Usage: /kick 123456789");
        const info = await getUserInfo(id);
        if (!info.exists) return reply(`User ${id} is not in the DB.`);
        await blockUser(id);
        return reply(
            `✅ User ${id} blocked. They'll get the "removed from beta" message if they message the bot.`,
        );
    }

    if (cmd === "unkick") {
        const id = Number(args[0]);
        if (!Number.isFinite(id)) return reply("Usage: /unkick 123456789");
        await unblockUser(id);
        return reply(`✅ User ${id} unblocked.`);
    }

    if (cmd === "who") {
        const id = Number(args[0]);
        if (!Number.isFinite(id)) return reply("Usage: /who 123456789");
        const info = await getUserInfo(id);
        if (!info.exists) return reply(`User ${id} not in DB.`);
        return reply(
            `User ${id}: ${info.blocked ? "🚫 blocked" : "✅ active"}`,
        );
    }

    return reply(
        `*Commands:*\n` +
            `/stats — users, sessions, activity\n` +
            `/users — list all users with IDs\n` +
            `/limit <n> — set max users\n` +
            `/kick <id> — block a user\n` +
            `/unkick <id> — unblock a user\n` +
            `/who <id> — check a user's status`,
        { parse_mode: "Markdown" },
    );
}
