import { expect, test } from "bun:test"
import { extractOutputText, extractReasoningText, HttpError, streamCodexResponse } from "./responses"

test("adds a Markdown link for a plain citation span", () => {
    expect(extractOutputText([{
        type: "message",
        content: [{
            type: "output_text",
            text: "Tesla source",
            annotations: [{
                type: "url_citation",
                start_index: 0,
                end_index: 12,
                url: "https://example.com/tesla",
            }],
        }],
    }])).toBe("[Tesla source](https://example.com/tesla)")
})

test("does not nest a citation around an existing Markdown link", () => {
    const text = "Zip2 ([ir.tesla.com](https://ir.tesla.com/corporate/elon-musk?utm_source=openai))"
    expect(extractOutputText([{
        type: "message",
        content: [{
            type: "output_text",
            text,
            annotations: [{
                type: "url_citation",
                start_index: 5,
                end_index: text.length,
                url: "https://ir.tesla.com/corporate/elon-musk?utm_source=openai",
            }],
        }],
    }])).toBe(text)
})

test("removes raw citation markers without URL annotations", () => {
    expect(extractOutputText([{
        type: "message",
        content: [{
            type: "output_text",
            text: "Compaction guidance. \uE200cite\uE202turn2search0\uE202turn2search1\uE201",
        }],
    }])).toBe("Compaction guidance.")
})

test("uses a readable label when a URL annotation covers a raw citation marker", () => {
    const marker = "\uE200cite\uE202turn2search0\uE201"
    expect(extractOutputText([{
        type: "message",
        content: [{
            type: "output_text",
            text: `Compaction guidance. ${marker}`,
            annotations: [{
                type: "url_citation",
                start_index: 21,
                end_index: 21 + marker.length,
                url: "https://example.com/guidance",
            }],
        }],
    }])).toBe("Compaction guidance. [Source](https://example.com/guidance)")
})

test("extracts every readable assistant text type", () => {
    expect(extractOutputText([{
        type: "message",
        content: [
            { type: "output_text", text: "Visible response. " },
            { type: "refusal", refusal: "Visible refusal." },
        ],
    }, {
        type: "message",
        content: [{ type: "output_audio", transcript: "Visible message transcript." }],
    }, {
        type: "output_audio",
        transcript: "Visible audio transcript.",
    }, {
        type: "function_call",
        arguments: "{\"secret\":\"tool arguments stay in the tool panel\"}",
    }])).toBe("Visible response. Visible refusal.\n\nVisible message transcript.\n\nVisible audio transcript.")
})

test("extracts all plaintext reasoning without exposing encrypted content", () => {
    expect(extractReasoningText([{
        type: "reasoning",
        encrypted_content: "opaque-private-reasoning",
        summary: [
            { type: "summary_text", text: "First visible summary." },
            { type: "summary_text", text: "Second visible summary." },
        ],
        content: [
            { type: "reasoning_text", text: "Visible reasoning content." },
            { type: "reasoning_text", text: "First visible summary." },
        ],
    }])).toBe("First visible summary.\n\nSecond visible summary.\n\nVisible reasoning content.")
})

test("Codex HTTP errors expose Retry-After delays", async () => {
    try {
        await streamCodexResponse({
            endpoint: "https://codex.example.test/responses",
            headers: {},
            body: {},
            fetchImpl: async () => new Response("Busy", {
                status: 503,
                headers: { "Retry-After": "2.5" },
            }),
        })
        throw new Error("Expected the request to fail")
    } catch (error) {
        expect(error).toBeInstanceOf(HttpError)
        expect((error as HttpError).status).toBe(503)
        expect((error as HttpError).retryAfterMs).toBe(2500)
    }
})
