import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ADMIN_PASSWORD, ADMIN_PORT } from "./config.js";
import {
    adminGlobalStats,
    adminUserList,
    adminRecentSessions,
    adminUserDetail,
} from "./db.js";

const PUBLIC_DIR = path.join(process.cwd(), "public");

function auth(url) {
    const token = url.searchParams.get("token");
    return token === ADMIN_PASSWORD;
}

function sendJson(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
}

export function startAdminServer() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);

        if (url.pathname === "/" || url.pathname === "/index.html") {
            const filePath = path.join(PUBLIC_DIR, "admin.html");
            if (!fs.existsSync(filePath))
                return sendJson(res, 404, { error: "admin.html missing" });
            res.writeHead(200, { "Content-Type": "text/html" });
            return res.end(fs.readFileSync(filePath));
        }

        if (!url.pathname.startsWith("/api/"))
            return sendJson(res, 404, { error: "not found" });
        if (!auth(url)) return sendJson(res, 401, { error: "unauthorized" });

        try {
            if (url.pathname === "/api/stats")
                return sendJson(res, 200, adminGlobalStats());
            if (url.pathname === "/api/users")
                return sendJson(res, 200, adminUserList());
            if (url.pathname === "/api/sessions")
                return sendJson(res, 200, adminRecentSessions(50));
            const match = url.pathname.match(/^\/api\/user\/(\d+)$/);
            if (match) {
                const detail = adminUserDetail(Number(match[1]));
                return detail
                    ? sendJson(res, 200, detail)
                    : sendJson(res, 404, { error: "not found" });
            }
            return sendJson(res, 404, { error: "not found" });
        } catch (err) {
            return sendJson(res, 500, { error: err.message });
        }
    });
    server.listen(ADMIN_PORT, () => {
        console.log(
            `✓ Admin: http://localhost:${ADMIN_PORT}?token=${ADMIN_PASSWORD}`,
        );
    });
}
