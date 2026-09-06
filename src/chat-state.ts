import type { ChatSummary } from "./chat-types"

// A slow POST/GET response must not overwrite a newer completion received over SSE.
export function latestChat<T extends ChatSummary>(current: T | null, incoming: T): T {
    return current?.id === incoming.id && current.updatedAt > incoming.updatedAt ? current : incoming
}
