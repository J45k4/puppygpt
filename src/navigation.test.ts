import { expect, test } from "bun:test"
import { chatPath, readRoute } from "./navigation"
const route = (path: string, state?: unknown) => readRoute(new URL(path, "http://localhost:3000"), state)
test("settings deep links and legacy links resolve to the correct section", () => {
    for (const section of ["accounts", "preferences", "agent"] as const) {
        expect(route(`/settings/${section}`)).toEqual({ settings: true, section, chatId: null })
        expect(route(`/?settings=1&section=${section}&chat=old`)).toEqual({ settings: true, section, chatId: "old" })
    }
    expect(route("/settings").section).toBe("accounts")
    expect(route("/settings/unknown").section).toBe("accounts")
    expect(route("/settings-other").settings).toBeFalse()
})
test("settings history preserves the return chat and chat routes ignore stale history", () => {
    expect(route("/settings/agent", { chatId: "saved" }).chatId).toBe("saved")
    expect(route("/", { chatId: "saved" }).chatId).toBeNull()
    expect(route(chatPath("a&b"), { chatId: "saved" }).chatId).toBe("a&b")
    expect(chatPath(null)).toBe("/")
})

test("chat paths support deep links, encoded IDs, and legacy query links", () => {
    expect(chatPath("chat-123")).toBe("/chat/chat-123")
    expect(route("/chat/chat-123").chatId).toBe("chat-123")
    expect(route("/chat/chat-123/").chatId).toBe("chat-123")
    expect(route("/chat/chat-123?chat=old").chatId).toBe("chat-123")
    expect(route("/?chat=old").chatId).toBe("old")
    expect(route(chatPath("a/b ?#%")).chatId).toBe("a/b ?#%")
    expect(route("/chat/%invalid").chatId).toBeNull()
    expect(route("/chat/id/extra").chatId).toBeNull()
})
