import { bot } from "./telegram.js";

const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";

if (!GROQ_KEY) {
    console.warn("[voice] GROQ_API_KEY not set — voice notes will fail");
}

export async function downloadVoice(fileId) {
    const link = await bot.getFileLink(fileId);
    const res = await fetch(link);
    if (!res.ok) throw new Error(`voice download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

export async function transcribeVoice(oggBuffer) {
    if (!GROQ_KEY) throw new Error("GROQ_API_KEY missing");

    const form = new FormData();
    // Groq accepts ogg/opus natively — send the Telegram file as-is.
    form.append(
        "file",
        new Blob([oggBuffer], { type: "audio/ogg" }),
        "voice.ogg",
    );
    form.append("model", GROQ_MODEL);
    form.append("language", "en");
    form.append("response_format", "json");
    form.append("temperature", "0");

    console.log(
        `[voice] POST ${GROQ_URL} (${oggBuffer.length} bytes, ${GROQ_MODEL})`,
    );

    const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${GROQ_KEY}` },
        body: form,
    });

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`[voice] ${res.status}:`, text.slice(0, 400));
        throw new Error(
            `transcription failed: ${res.status} ${text.slice(0, 200)}`,
        );
    }

    const data = await res.json();
    const transcript = (data.text || "").trim();
    if (!transcript) throw new Error("empty transcript");

    console.log(`[voice] ✓ "${transcript.slice(0, 80)}"`);
    return transcript;
}
