import OpenAI from "openai";
import { NVIDIA_API_KEY, MODEL } from "./config.js";

const openai = new OpenAI({
    apiKey: NVIDIA_API_KEY,
    baseURL: "https://integrate.api.nvidia.com/v1",
});

export async function withRetry(fn, label, maxAttempts = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            const msg = err.message || "";
            const isNetwork =
                /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket\s+hang|network|timeout|fetch\s+failed/i.test(
                    msg,
                );
            if (!isNetwork || attempt === maxAttempts) throw err;
            console.log(
                `   ↻ ${label}: ${msg.slice(0, 60)} — retry ${attempt}/${maxAttempts} in ${attempt * 2}s`,
            );
            await new Promise((r) => setTimeout(r, attempt * 2000));
        }
    }
    throw lastErr;
}

export function nimStream(apiMessages) {
    return withRetry(
        () =>
            openai.chat.completions.create({
                model: MODEL,
                messages: apiMessages,
                temperature: 1,
                top_p: 0.95,
                max_tokens: 8192,
                stream: true,
                chat_template_kwargs: {
                    enable_thinking: true,
                    force_nonempty_content: true,
                },
            }),
        "NIM stream",
    );
}

export async function generateSilent(apiMessages, maxTokens = 6144) {
    const completion = await withRetry(
        () =>
            openai.chat.completions.create({
                model: MODEL,
                messages: apiMessages,
                temperature: 1,
                top_p: 0.95,
                max_tokens: maxTokens,
                stream: false,
                chat_template_kwargs: {
                    enable_thinking: true,
                    force_nonempty_content: true,
                },
            }),
        "NIM request",
    );
    const msg = completion.choices[0].message;
    return {
        content: msg.content || msg.reasoning_content || "",
        reasoning: msg.reasoning_content || "",
    };
}

export async function generateExplanations(prompt, count) {
    const completion = await withRetry(
        () =>
            openai.chat.completions.create({
                model: MODEL,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.3,
                max_tokens: 3072,
                stream: false,
                chat_template_kwargs: {
                    enable_thinking: false,
                    force_nonempty_content: true,
                },
            }),
        "NIM explanations",
    );
    const text = completion.choices[0].message.content || "";
    const out = [];
    for (const line of text.split("\n")) {
        const m = line.match(/^\d+[.):]\s*(.+)/);
        if (m) out.push(m[1].trim());
    }
    while (out.length < count) out.push("No explanation available.");
    return out.slice(0, count);
}
