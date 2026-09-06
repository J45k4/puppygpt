import type { ChatSummary } from "./chat-types"

export function layoutBranches(chats: ChatSummary[]) {
    const ids = new Set(chats.map(chat => chat.id))
    const children = new Map<string, ChatSummary[]>()
    for (const chat of chats) {
        const parent = chat.parentChatId && ids.has(chat.parentChatId) ? chat.parentChatId : ""
        children.set(parent, [...(children.get(parent) ?? []), chat])
    }
    const nodes: { chat: ChatSummary, x: number, y: number }[] = []
    const visited = new Set<string>()
    const visit = (chat: ChatSummary, depth: number) => {
        if (visited.has(chat.id)) return
        visited.add(chat.id)
        const node = { chat, x: depth * 320 + 24, y: nodes.length * 128 + 24 }
        nodes.push(node)
        for (const child of children.get(chat.id) ?? []) visit(child, depth + 1)
    }
    for (const root of children.get("") ?? []) visit(root, 0)
    // Keep malformed or orphaned historical records visible instead of hanging the map.
    for (const chat of chats) visit(chat, 0)
    const positions = new Map(nodes.map(node => [node.chat.id, node]))
    const edges = nodes.flatMap(node => {
        const parent = positions.get(node.chat.parentChatId ?? "")
        return parent ? [{ from: parent, to: node }] : []
    })
    return { nodes, edges, width: Math.max(600, ...nodes.map(node => node.x + 296)), height: Math.max(300, nodes.length * 128 + 48) }
}
