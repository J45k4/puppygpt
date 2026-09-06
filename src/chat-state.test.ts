import { expect, test } from "bun:test"
import { latestChat } from "./chat-state"
import type { Chat } from "./chat-types"
const running: Chat = { id: "chat", title: "Test", cwd: "/tmp", model: "test", status: "running", updatedAt: "2026-09-06T04:00:00.000Z", messages: [] }
const completed: Chat = { ...running, status: "idle", updatedAt: "2026-09-06T04:00:01.000Z", messages: [{ id: "compact", role: "activity", text: "Conversation compacted" }] }
test("a delayed compact response cannot replace the completion event", () => {
    expect(latestChat(completed, running)).toBe(completed)
    expect(latestChat(running, completed)).toBe(completed)
})
test("running status refresh recovers missed completion and accepts subsequent turns", () => {
    expect(latestChat(running, completed).status).toBe("idle")
    const next = { ...running, updatedAt: "2026-09-06T04:00:02.000Z" }
    expect(latestChat(completed, next)).toBe(next)
    expect(latestChat(completed, { ...running, id: "another" }).id).toBe("another")
})
