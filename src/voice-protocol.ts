// Wire contract checked against OpenClaw extensions/openai/realtime-quicksilver-wire.ts.
export const VOICE_MODEL = "gpt-live-1-codex"
export const VOICES = ["arbor", "breeze", "cove", "ember", "juniper", "maple", "sol", "spruce", "vale"] as const
export const VOICE_CALL_URL = "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas"
export type VoiceState = { id: string, chatId: string, status: "connecting" | "connected" | "closed" | "error", error?: string, transcript: { role: "user" | "assistant", text: string }[] }

export function validateVoiceOffer(sdp: unknown, voice: unknown): asserts sdp is string {
    if (typeof sdp !== "string" || sdp.length > 60_000 || !sdp.startsWith("v=0") || !/^m=audio /m.test(sdp) || /^m=(?!audio |application )/m.test(sdp)) throw new Error("Expected an audio-only WebRTC offer")
    if (!VOICES.includes(voice as typeof VOICES[number])) throw new Error("Choose a supported voice")
}

export function voiceCallId(headers: Headers): string {
    const valid = (value: string) => value.length <= 128 && (/^rtc_[\w-]+$/.test(value) || /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value))
    const location = headers.get("location")
    if (location && location.length < 1024) {
        try {
            const id = new URL(location, VOICE_CALL_URL).pathname.split("/").find(valid)
            if (id) return id
        } catch {}
    }
    const id = headers.get("openai-session-id")?.trim() ?? ""
    if (valid(id)) return id
    throw new Error("Voice backend returned no valid call ID")
}

export function voiceTextChunks(text: string): string[] {
    const chunks: string[] = []
    let chunk = "", size = 0
    for (const char of text) {
        const bytes = new TextEncoder().encode(char).length
        if (size + bytes > 500) { chunks.push(chunk); chunk = ""; size = 0 }
        chunk += char; size += bytes
    }
    if (chunk) chunks.push(chunk)
    return chunks
}
