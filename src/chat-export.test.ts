import { expect, test } from "bun:test"
import { exportChat, chatFilename } from "./chat-export"
import type { Chat } from "./chat-types"

test("export includes the full transcript, activity output, errors and image links", () => {
    const chat: Chat = { id:"chat-id",title:'Example / chat\r\n"',cwd:"/tmp",model:"gpt-6-astra",status:"running",updatedAt:"2026-09-06T00:00:00Z",messages:[
        {id:"u",role:"user",text:"Hello"},
        {id:"a",role:"assistant",text:"**Hello back**"},
        {id:"t",role:"activity",text:"Command",detail:"output\n```\nmore output"},
        {id:"e",role:"error",text:"Something failed"},
        {id:"i",role:"assistant",text:"",image:{path:"/private/file.png",prompt:"A puppy"}},
    ] }
    const result = exportChat(chat,"http://localhost:3000")
    for (const text of ["Hello","**Hello back**","Command","output\n```\nmore output","Something failed","A puppy","http://localhost:3000/api/chats/chat-id/images/i","still running"]) expect(result).toContain(text)
    expect(result).toContain("````\noutput")
    expect(result).not.toContain("/private/file.png")
    expect(chatFilename(chat)).toBe("Example-chat.md")
    expect(chatFilename({...chat,title:"///"})).toBe("chat.md")
})

test("ZIP contains exact image bytes and portable transcript links; missing and outside images fail", async () => {
    const { mkdtemp, rm, symlink } = await import("node:fs/promises")
    const { unzipSync } = await import("fflate")
    const { exportChatZip } = await import("./chat-export")
    const cwd = await mkdtemp("/tmp/puppygpt-zip-")
    const outside = await mkdtemp("/tmp/puppygpt-outside-")
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")
    const chat: Chat = { id:"id",title:"Images",cwd,model:"gpt-6-astra",status:"idle",updatedAt:"2026-09-06",messages:[{id:"../odd/id",role:"assistant",text:"Here is an image",image:{path:"image.png",prompt:"A dot"}}] }
    try {
        await Bun.write(`${cwd}/image.png`, png)
        const files = unzipSync(await exportChatZip(chat))
        expect(Object.keys(files).sort()).toEqual(["Images.md", "images/image-001.png"])
        expect(Buffer.from(files["images/image-001.png"]!)).toEqual(png)
        const markdown = new TextDecoder().decode(files["Images.md"])
        expect(markdown).toContain("![Image](images/image-001.png)")
        expect(markdown).not.toContain("/api/chats")
        await rm(`${cwd}/image.png`)
        await expect(exportChatZip(chat)).rejects.toThrow("missing or unavailable")
        await Bun.write(`${outside}/image.png`, png)
        await symlink(`${outside}/image.png`,`${cwd}/image.png`)
        await expect(exportChatZip(chat)).rejects.toThrow("missing or unavailable")
        const controller = new AbortController(); controller.abort()
        await expect(exportChatZip(chat,controller.signal)).rejects.toThrow()
    } finally { await rm(cwd,{recursive:true,force:true}); await rm(outside,{recursive:true,force:true}) }
})
