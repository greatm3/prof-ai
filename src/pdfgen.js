import { Doc } from "@nemu-ai/pdf";

/**
 * Generate a PDF study sheet from a markdown string.
 * Supports inline ($...$) and display ($$...$$) LaTeX.
 */
export async function generateStudyPdf({ title, markdown }) {
    const doc = new Doc({
        page_size: "A4",
        margin: 48,
        padding: 12,
    });

    doc.set_style({
        heading: { font_family: "inter", color: "#0a0a0a" },
        paragraph: {
            font_family: "source-serif-4",
            font_size: 11.5,
            line_height: 1.6,
        },
        code: { font_family: "jetbrains-mono", font_size: 10 },
    });

    // Title block
    if (title) {
        doc.page().content(
            { type: "heading", text: title, level: 1 },
            { type: "divider" },
        );
    }

    // Body — @nemu-ai/pdf parses markdown when you pass plain strings
    doc.page().content(markdown);

    // build() writes to a path; we use a temp path and read it back
    const tmp = `/tmp/prof-${Date.now()}.pdf`;
    await doc.build(tmp);

    const fs = await import("node:fs/promises");
    const buffer = await fs.readFile(tmp);
    await fs.unlink(tmp).catch(() => {});

    return buffer;
}
