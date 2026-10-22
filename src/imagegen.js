import { NVIDIA_API_KEY, IMAGE_MODEL } from "./config.js";

// Per-model body shaping. Distilled FLUX models (schnell / klein) are
// fixed at 4 steps and cfg_scale 0. `mode` must be t2i or i2i — "base"
// is only valid on flux.1-dev.
function buildBody(prompt) {
    return {
        mode: "t2i",
        prompt,
        width: 1024,
        height: 1024,
        samples: 1,
        seed: 0,
        steps: 16,
        cfg_scale: 3.5, // validator requires > 1.0; distilled Klein ignores CFG anyway
    };
}

function extractImage(data) {
    // NIM response shape varies across models and has changed before.
    // Handle every shape seen in the wild.
    if (typeof data === "string" && data.length > 100) return data; // raw base64
    if (Buffer.isBuffer(data)) return data.toString("base64");

    const candidates = [
        data?.artifacts?.[0]?.base64,
        data?.artifacts?.[0]?.image,
        data?.images?.[0]?.image,
        data?.images?.[0]?.base64,
        data?.data?.[0]?.b64_json,
        data?.data?.[0]?.base64,
        data?.image,
        data?.b64_json,
    ];

    for (const c of candidates) {
        if (typeof c === "string" && c.length > 100) return c;
    }
    return null;
}

export async function generateDiagram(topic) {
    const prompt =
        `Clean educational diagram for a student: ${topic}. ` +
        `White background, black lines, simple clear labels, textbook style, ` +
        `no decorative elements, no shading, no watermark.`;

    const url = `https://ai.api.nvidia.com/v1/genai/${IMAGE_MODEL}`;
    console.log(`[imagegen] POST ${url}`);
    console.log(
        `[imagegen] body:`,
        JSON.stringify(buildBody(prompt)).slice(0, 300),
    );

    const res = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${NVIDIA_API_KEY}`,
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        body: JSON.stringify(buildBody(prompt)),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`[imagegen] ${res.status} response:`, text.slice(0, 500));
        throw new Error(
            `image generation failed: ${res.status} ${text.slice(0, 300)}`,
        );
    }

    const data = await res.json();
    const b64 = extractImage(data);

    if (!b64) {
        console.error(
            "[imagegen] unrecognised response shape:",
            JSON.stringify(data).slice(0, 400),
        );
        throw new Error("image generation returned no image");
    }

    return Buffer.from(b64, "base64");
}
