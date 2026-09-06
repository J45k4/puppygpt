import { zipSync } from "fflate"
import { viewImage } from "./agent/image"
import type { Chat } from "./chat-types"

export function chatFilename(chat: Chat): string {
    const title = chat.title.normalize("NFKD").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "chat"
    return `${title}.md`
}
export function exportChat(chat: Chat, origin: string, imagePaths?: Map<string, string>): string {
    const lines = [`# ${chat.title.replace(/[\r\n]+/g, " ")}`, "", `Model: ${chat.model}`, `Updated: ${chat.updatedAt}`, ""]
    if (chat.gpt) lines.push(`Agent: ${chat.gpt.name}`, "")
    if (chat.status === "running") lines.push("This conversation was exported while a turn was still running.", "")
    for (const message of chat.messages) {
        const role = message.role === "user" ? "You" : message.role === "assistant" ? chat.gpt?.name ?? "PuppyGPT" : message.role === "activity" ? "Activity" : "Error"
        lines.push(`## ${role}`, "", message.text, "")
        if (message.detail) {
            const fence = "`".repeat(Math.max(3, ...Array.from(message.detail.matchAll(/`+/g), match => match[0].length + 1)))
            lines.push(fence, message.detail, fence, "")
        }
        if (message.image) {
            const url = `${origin}/api/chats/${encodeURIComponent(chat.id)}/images/${encodeURIComponent(message.id)}`
            lines.push(`Image prompt: ${message.image.prompt}`, "", imagePaths?.has(message.id) ? `![Image](${imagePaths.get(message.id)})` : `[Download image](${url})`, "")
        }
    }
    return lines.join("\n")
}

export async function exportChatZip(chat: Chat, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const files: Record<string, Uint8Array> = Object.create(null)
    const paths = new Map<string, string>()
    let total = 0
    for (const message of chat.messages) {
        signal?.throwIfAborted()
        if (!message.image) continue
        let image
        try { image = await viewImage(message.image.path, chat.cwd) }
        catch { throw new Error("An image is missing or unavailable. Download text only, or restore the image and try again.") }
        total += image.size
        if (total > 100 * 1024 * 1024) throw new Error("Images exceed the 100 MB archive limit. Download text only instead.")
        const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.split("/")[1]!
        const path = `images/image-${String(paths.size + 1).padStart(3, "0")}.${extension}`
        files[path] = Buffer.from(image.imageUrl.split(",")[1]!, "base64")
        paths.set(message.id, path)
    }
    signal?.throwIfAborted()
    files[chatFilename(chat)] = new TextEncoder().encode(exportChat(chat, "", paths))
    // Image formats are already compressed; store them without recompression.
    return zipSync(files, { level: 0 })
}
