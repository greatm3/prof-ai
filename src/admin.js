import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ADMIN_PASSWORD, ADMIN_PORT } from "./config.js";
import {
    adminGlobalStats,
    adminUserList,
    adminRecentSessions,
    adminUserDetail,
    adminDebug,
} from "./db.js";

const PUBLIC_DIR = path.join(process.cwd(), "public");

function sendJson(res, status, data) {
    let body;
    try {
        body = JSON.stringify(data);
    } catch (err) {
        console.error("[admin.sendJson] serialize failed:", err);
        body = JSON.stringify({
            error: "serialization failed: " + err.message,
        });
        status = 500;
    }
    if (body == null) body = "{}";

    try {
        const buf = Buffer.from(body, "utf8");
        res.writeHead(status, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": buf.length,
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
        });
        res.end(buf);
    } catch (err) {
        console.error("[admin.sendJson] write failed:", err);
        try {
            if (!res.headersSent)
                res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("error");
        } catch {
            /* socket dead */
        }
    }
}

export function startAdminServer() {
    const server = http.createServer(async (req, res) => {
        const t0 = Date.now();
        const url = new URL(req.url, `http://${req.headers.host}`);
        const token = url.searchParams.get("token");

        res.on("finish", () => {
            console.log(
                `[admin] ${req.method} ${url.pathname} → ${res.statusCode} (${Date.now() - t0}ms)`,
            );
        });

        if (url.pathname === "/" || url.pathname === "/index.html") {
            const filePath = path.join(PUBLIC_DIR, "admin.html");
            if (!fs.existsSync(filePath))
                return sendJson(res, 404, { error: "admin.html missing" });
            res.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
            });
            return res.end(fs.readFileSync(filePath));
        }

        if (!url.pathname.startsWith("/api/"))
            return sendJson(res, 404, { error: "not found" });
        if (token !== ADMIN_PASSWORD)
            return sendJson(res, 401, { error: "unauthorized" });

        try {
            if (url.pathname === "/api/stats")
                return sendJson(res, 200, await adminGlobalStats());
            if (url.pathname === "/api/users")
                return sendJson(res, 200, await adminUserList());
            if (url.pathname === "/api/sessions")
                return sendJson(res, 200, await adminRecentSessions(50));
            if (url.pathname === "/api/debug")
                return sendJson(res, 200, await adminDebug());

            const m = url.pathname.match(/^\/api\/user\/(\d+)$/);
            if (m) {
                const detail = await adminUserDetail(Number(m[1]));
                if (!detail)
                    return sendJson(res, 404, { error: "user not found" });
                return sendJson(res, 200, detail);
            }
            return sendJson(res, 404, { error: "not found" });
        } catch (err) {
            console.error("[admin] handler error:", err);
            return sendJson(res, 500, {
                error: err.message,
                stack: (err.stack || "").split("\n").slice(0, 3),
            });
        }
    });

    server.listen(ADMIN_PORT, () => {
        console.log(
            `✓ Admin: http://localhost:${ADMIN_PORT}?token=${ADMIN_PASSWORD}`,
        );
    });
}
