import { asNumber, asObject, asString, type FetchLike, type JsonObject } from "./types"

export class RetryableResponseError extends Error {}

export class RetryableTransportError extends Error {}

export class HttpError extends Error {
    status: number
    retryAfterMs?: number

    constructor(status: number, message: string, retryAfterMs?: number) {
        super(message)
        this.status = status
        this.retryAfterMs = retryAfterMs
    }
}

export type CodexResponse = {
    id?: string
    output: JsonObject[]
    usage?: JsonObject
}

type StreamOptions = {
    endpoint: string
    headers: HeadersInit
    body: JsonObject
    fetchImpl?: FetchLike
    signal?: AbortSignal
    onEvent?: (event: JsonObject) => void | Promise<void>
}

const eventError = (event: JsonObject): string => {
    const response = asObject(event.response)
    const error = asObject(response?.error) ?? asObject(event.error)
    return asString(error?.message) ?? "Codex response failed"
}

export const streamCodexResponse = async (options: StreamOptions): Promise<CodexResponse> => {
    let response: Response
    try {
        response = await (options.fetchImpl ?? fetch)(options.endpoint, {
            method: "POST",
            headers: options.headers,
            body: JSON.stringify(options.body),
            signal: options.signal,
        })
    } catch (error) {
        options.signal?.throwIfAborted()
        throw new RetryableTransportError(error instanceof Error ? error.message : String(error))
    }
    if (!response.ok) {
        let detail: string
        try {
            detail = (await response.text()).slice(0, 1000).trim()
        } catch (error) {
            options.signal?.throwIfAborted()
            throw new RetryableTransportError(error instanceof Error ? error.message : String(error))
        }
        const retryAfter = response.headers.get("Retry-After")?.trim()
        const retryAfterSeconds = retryAfter ? Number(retryAfter) : Number.NaN
        const retryAfterDate = retryAfter && !Number.isFinite(retryAfterSeconds) ? Date.parse(retryAfter) : Number.NaN
        const retryAfterMs = Number.isFinite(retryAfterSeconds)
            ? Math.max(0, retryAfterSeconds * 1000)
            : Number.isFinite(retryAfterDate)
                ? Math.max(0, retryAfterDate - Date.now())
                : undefined
        throw new HttpError(
            response.status,
            `Codex request failed with status ${response.status}${detail ? `: ${detail}` : ""}`,
            retryAfterMs,
        )
    }
    if (!response.body) {
        throw new Error("Codex response did not include a stream")
    }

    const output: JsonObject[] = []
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    let buffer = ""
    let completed = false
    let responseId: string | undefined
    let usage: JsonObject | undefined

    const processEvent = async (block: string): Promise<void> => {
        const data = block
            .split("\n")
            .filter(line => line.startsWith("data:"))
            .map(line => line.slice(5).trimStart())
            .join("\n")
        if (!data || data === "[DONE]") {
            return
        }
        const event = asObject(JSON.parse(data))
        const type = asString(event?.type)
        if (!event || !type) {
            return
        }
        if (
            type === "response.output_text.delta"
            || type === "response.web_search_call.in_progress"
            || type === "response.web_search_call.searching"
            || type === "response.web_search_call.completed"
        ) {
            await options.onEvent?.(event)
            return
        }
        if (type === "response.output_item.done") {
            const item = asObject(event.item)
            if (item) {
                output.push(item)
            }
            return
        }
        if (type === "response.failed") {
            throw new RetryableResponseError(eventError(event))
        }
        if (type === "response.incomplete") {
            throw new Error("Codex response was incomplete")
        }
        if (type !== "response.completed") {
            return
        }

        completed = true
        const completedResponse = asObject(event.response)
        responseId = asString(completedResponse?.id)
        usage = asObject(completedResponse?.usage)
        if (!output.length && Array.isArray(completedResponse?.output)) {
            for (const item of completedResponse.output) {
                const parsed = asObject(item)
                if (parsed) {
                    output.push(parsed)
                }
            }
        }
    }

    while (true) {
        const chunk = await reader.read().catch(error => {
            options.signal?.throwIfAborted()
            throw new RetryableTransportError(error instanceof Error ? error.message : String(error))
        })
        if (chunk.done) {
            buffer += decoder.decode()
            break
        }
        buffer += decoder.decode(chunk.value, { stream: true })
        buffer = buffer.replaceAll("\r\n", "\n")
        let boundary = buffer.indexOf("\n\n")
        while (boundary >= 0) {
            await processEvent(buffer.slice(0, boundary))
            buffer = buffer.slice(boundary + 2)
            boundary = buffer.indexOf("\n\n")
        }
    }
    if (buffer.trim()) {
        await processEvent(buffer)
    }
    if (!completed) {
        throw new Error("Codex response stream ended before completion")
    }
    return { id: responseId, output, usage }
}

const rawCitationMarker = /[\t ]*\uE200cite(?:\uE202[^\uE200\uE201]+)+\uE201/g
const exactRawCitationMarker = /^\uE200cite(?:\uE202[^\uE200\uE201]+)+\uE201$/

const withCitationLinks = (part: JsonObject, text: string): string => {
    const citations = Array.isArray(part.annotations)
        ? part.annotations.flatMap(annotation => {
            const entry = asObject(annotation)
            const start = asNumber(entry?.start_index)
            const end = asNumber(entry?.end_index)
            const url = asString(entry?.url)
            if (
                entry?.type !== "url_citation"
                || !Number.isInteger(start)
                || !Number.isInteger(end)
                || start === undefined
                || end === undefined
                || start < 0
                || end <= start
                || end > text.length
                || (!url?.startsWith("https://") && !url?.startsWith("http://"))
            ) {
                return []
            }
            return [{ start, end, url }]
        }).sort((left, right) => right.start - left.start)
        : []
    let citedText = text
    let earliestStart = text.length
    for (const citation of citations) {
        if (citation.end > earliestStart) {
            continue
        }
        const annotatedText = text.slice(citation.start, citation.end)
        if (/\[[^\]\n]+\]\(\S+\)/.test(annotatedText)) {
            earliestStart = citation.start
            continue
        }
        const label = exactRawCitationMarker.test(annotatedText)
            ? "Source"
            : annotatedText
                .replaceAll("\\", "\\\\")
                .replaceAll("[", "\\[")
                .replaceAll("]", "\\]")
        const url = encodeURI(citation.url).replaceAll("(", "%28").replaceAll(")", "%29")
        citedText = `${citedText.slice(0, citation.start)}[${label}](${url})${citedText.slice(citation.end)}`
        earliestStart = citation.start
    }
    return citedText.replace(rawCitationMarker, "")
}

export const extractOutputText = (output: JsonObject[]): string => output.flatMap(item => {
    if (item.type === "output_audio") {
        return asString(item.transcript)?.trim() ?? []
    }
    if (item.type !== "message" || !Array.isArray(item.content)) {
        return []
    }
    const message = item.content.flatMap(content => {
        const part = asObject(content)
        if (part?.type === "output_text") {
            const text = asString(part.text)
            return text ? [withCitationLinks(part, text)] : []
        }
        if (part?.type === "refusal") {
            return asString(part.refusal) ?? []
        }
        if (part?.type === "output_audio") {
            return asString(part.transcript) ?? []
        }
        return []
    }).join("")
    return message.trim() ? [message] : []
}).join("\n\n")

export const extractReasoningText = (output: JsonObject[]): string => {
    const parts: string[] = []
    for (const item of output) {
        if (item.type !== "reasoning") {
            continue
        }
        for (const collection of [item.summary, item.content]) {
            if (!Array.isArray(collection)) {
                continue
            }
            for (const value of collection) {
                const part = asObject(value)
                if (part?.type !== "summary_text" && part?.type !== "reasoning_text") {
                    continue
                }
                const text = asString(part.text)?.trim()
                if (text && !parts.includes(text)) {
                    parts.push(text)
                }
            }
        }
    }
    return parts.join("\n\n")
}
