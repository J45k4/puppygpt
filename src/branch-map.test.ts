import { expect, test } from "bun:test"
import { layoutBranches } from "./branch-map"
import type { ChatSummary } from "./chat-types"
const chat = (id: string, parentChatId?: string): ChatSummary => ({ id, parentChatId, title: id, cwd: "/tmp", model: "test", status: "idle", updatedAt: "now" })
test("branch map connects nested forks and keeps independent roots visible", () => {
    const graph = layoutBranches([chat("root"), chat("child", "root"), chat("nested", "child"), chat("sibling", "root"), chat("other")])
    expect(graph.nodes).toHaveLength(5)
    expect(graph.edges.map(edge => [edge.from.chat.id, edge.to.chat.id])).toEqual([["root", "child"], ["child", "nested"], ["root", "sibling"]])
    expect(new Set(graph.nodes.map(node => `${node.x}:${node.y}`)).size).toBe(5)
    expect(graph.nodes.find(node => node.chat.id === "nested")!.x).toBeGreaterThan(graph.nodes.find(node => node.chat.id === "child")!.x)
})
test("branch map tolerates orphan and cyclic records", () => {
    expect(layoutBranches([chat("orphan", "missing"), chat("a", "b"), chat("b", "a")]).nodes).toHaveLength(3)
})
