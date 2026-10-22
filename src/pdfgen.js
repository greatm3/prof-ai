import { Doc } from "@nemu-ai/pdf";
import fs from "node:fs/promises";

// Split a string on $...$ (inline math) and return an array mixing
// plain strings and { type: 'formula' } inline nodes.
function parseInlineMath(text) {
    if (!text || typeof text !== "string") return text;

    const parts = [];
    let i = 0;

    while (i < text.length) {
        const start = text.indexOf("$", i);

        // No more $ — push the rest as plain text
        if (start === -1) {
            if (i < text.length) parts.push(text.slice(i));
            break;
        }

        // Skip escaped \$
        if (start > 0 && text[start - 1] === "\\") {
            parts.push(text.slice(i, start - 1) + "$");
            i = start + 1;
            continue;
        }

        // Skip $$ (display math already handled as its own block)
        if (text[start + 1] === "$") {
            parts.push(text.slice(i, start + 2));
            i = start + 2;
            continue;
        }

        // Find closing $ (not $$ and not escaped)
        let end = start + 1;
        while (end < text.length) {
            if (
                text[end] === "$" &&
                text[end - 1] !== "\\" &&
                text[end + 1] !== "$"
            )
                break;
            end++;
        }

        if (end >= text.length) {
            // No closing $ — treat the rest as plain text
            parts.push(text.slice(i));
            break;
        }

        // Push preceding plain text
        if (start > i) parts.push(text.slice(i, start));

        // Push the formula (without the $ delimiters)
        const formula = text.slice(start + 1, end).trim();
        if (formula) parts.push({ type: "formula", text: formula });

        i = end + 1;
    }

    // If nothing was split, return the original string (avoids unnecessary arrays)
    if (parts.length === 1 && typeof parts[0] === "string") return parts[0];
    if (parts.length === 0) return text;
    return parts;
}

// Convert a markdown string into explicit @nemu-ai/pdf block objects.
// Every block gets a valid `type`, so the renderer never sees undefined.
function markdownToBlocks(markdown) {
    const lines = String(markdown || "")
        .replace(/\r\n/g, "\n")
        .split("\n");
    const blocks = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();

        // ── Code fence
        if (trimmed.startsWith("```")) {
            const language = trimmed.slice(3).trim() || undefined;
            const buf = [];
            i++;
            while (i < lines.length && !lines[i].trim().startsWith("```")) {
                buf.push(lines[i]);
                i++;
            }
            i++; // closing fence
            blocks.push({
                type: "code",
                text: buf.join("\n"),
                ...(language ? { language } : {}),
            });
            continue;
        }

        // ── Display math $$ ... $$
        if (trimmed.startsWith("$$")) {
            const after = trimmed.slice(2);
            // Single-line $$...$$
            if (after.endsWith("$$") && after.length > 2) {
                blocks.push({
                    type: "formula",
                    text: after.slice(0, -2).trim(),
                });
                i++;
                continue;
            }
            const buf = [];
            if (after) buf.push(after);
            i++;
            while (i < lines.length && !lines[i].trim().endsWith("$$")) {
                buf.push(lines[i]);
                i++;
            }
            if (i < lines.length) {
                const last = lines[i].trim();
                buf.push(last.slice(0, -2));
                i++;
            }
            blocks.push({ type: "formula", text: buf.join("\n").trim() });
            continue;
        }

        // ── Headings
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
            blocks.push({
                type: "heading",
                text: heading[2].trim(),
                level: heading[1].length,
            });
            i++;
            continue;
        }

        // ── Divider
        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            blocks.push({ type: "divider" });
            i++;
            continue;
        }

        // ── Unordered list
        if (/^\s*[-*+]\s+/.test(line)) {
            const items = [];
            while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
                items.push(lines[i].replace(/^\s*[-*+]\s+/, "").trim());
                i++;
            }
            blocks.push({
                type: "list",
                items: items.map(parseInlineMath),
                ordered: false,
            });
            continue;
        }

        // ── Ordered list
        if (/^\s*\d+[.)]\s+/.test(line)) {
            const items = [];
            while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
                items.push(lines[i].replace(/^\s*\d+[.)]\s+/, "").trim());
                i++;
            }
            blocks.push({
                type: "list",
                items: items.map(parseInlineMath),
                ordered: true,
            });
            continue;
        }

        // ── Blank line
        if (!trimmed) {
            i++;
            continue;
        }

        // ── Paragraph: collect until a blank line or the start of another block
        const buf = [line];
        i++;
        while (
            i < lines.length &&
            lines[i].trim() &&
            !/^#{1,6}\s+/.test(lines[i]) &&
            !lines[i].trim().startsWith("```") &&
            !/^\s*[-*+]\s+/.test(lines[i]) &&
            !/^\s*\d+[.)]\s+/.test(lines[i]) &&
            !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
            !lines[i].trim().startsWith("$$")
        ) {
            buf.push(lines[i]);
            i++;
        }
        const paraText = buf.join(" ").trim();
        blocks.push({ type: "paragraph", text: parseInlineMath(paraText) });
    }

    return blocks;
}

export async function generateStudyPdf({ title, markdown }) {
    const doc = new Doc({ page_size: "A4", margin: 54, padding: 10 });

    doc.set_style({
        heading: {
            font_family: "inter",
            color: "#0a0a0a",
            font_weight: "bold",
        },
        paragraph: {
            font_family: "source-serif-4",
            font_size: 11.5,
            line_height: 1.6,
        },
        list: {
            font_family: "source-serif-4",
            font_size: 11.5,
            line_height: 1.6,
        },
        code: { font_family: "geist-mono", font_size: 10 },
        formula: { font_family: "source-serif-4" },
    });

    // Title page header
    doc.page().content(
        { type: "heading", text: title || "Prof · Study Sheet", level: 1 },
        { type: "spacer", size: 8 },
        { type: "divider" },
        { type: "spacer", size: 8 },
    );

    // Body — explicit, typed blocks only
    const blocks = markdownToBlocks(markdown);
    if (!blocks.length) {
        blocks.push({ type: "paragraph", text: "(No content to render)" });
    }
    doc.page().content(...blocks);

    const tmp = `/tmp/prof-study-${Date.now()}.pdf`;
    await doc.build(tmp);

    const buffer = await fs.readFile(tmp);
    await fs.unlink(tmp).catch(() => {});
    return buffer;
}
