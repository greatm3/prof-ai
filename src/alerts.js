import { ADMIN_USER_ID } from "./config.js";

const lastSent = new Map();
const COOLDOWN_MS = 15 * 60 * 1000; // one alert per unique error per 15 min

export async function alertAdmin(context, err) {
    if (!ADMIN_USER_ID) return;
    const message = (err?.message || String(err || "")).slice(0, 500);
    const key = `${context}:${message.slice(0, 100)}`;
    const now = Date.now();
    const last = lastSent.get(key);
    if (last && now - last < COOLDOWN_MS) return;
    lastSent.set(key, now);

    const time = new Date().toISOString().replace("T", " ").slice(0, 19);
    const body = `🚨 *${context}*\n\n\`${message}\`\n\n_${time}_`;

    try {
        // dynamic import to avoid circular dependency with telegram.js
        const { bot } = await import("./telegram.js");
        try {
            await bot.sendMessage(ADMIN_USER_ID, body, {
                parse_mode: "Markdown",
            });
        } catch {
            await bot.sendMessage(
                ADMIN_USER_ID,
                `🚨 ${context}\n\n${message}\n\n${time}`,
            );
        }
    } catch (e) {
        console.error("[alerts] failed to DM admin:", e.message);
    }
}

export function installGlobalAlertHandlers() {
    process.on("unhandledRejection", (err) => {
        console.error("unhandledRejection:", err);
        alertAdmin("unhandledRejection", err);
    });
    process.on("uncaughtException", (err) => {
        console.error("uncaughtException:", err);
        alertAdmin("uncaughtException", err);
    });
}
