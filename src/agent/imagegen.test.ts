import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { generateImage } from "./imagegen"

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function fixture() {
    const cwd = await mkdtemp(join(tmpdir(), "puppygpt-imagegen-"))
    dirs.push(cwd)
    return { cwd, endpoint: "https://example.test/backend-api/codex/responses", headers: { Authorization: "Bearer test", "ChatGPT-Account-ID": "account" }, history: [] }
}

test("generation sends Codex JSON, preserves auth and saves real PNG bytes", async () => {
    const options = await fixture()
    const image = await generateImage({ ...options, args: { prompt: "A puppy" }, fetchImpl: async (url, init) => {
        expect(String(url)).toBe("https://example.test/backend-api/codex/images/generations")
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test")
        expect(new Headers(init?.headers).get("ChatGPT-Account-ID")).toBe("account")
        expect(JSON.parse(String(init?.body))).toEqual({ model: "gpt-image-2", prompt: "A puppy", background: "auto", quality: "auto", size: "auto" })
        return Response.json({ data: [{ b64_json: png }] })
    } })
    expect(Buffer.from(await Bun.file(image.path).arrayBuffer()).toString("base64")).toBe(png)
    expect(image.imageUrl).toBe(`data:image/png;base64,${png}`)
    expect(image.path.startsWith(join(options.cwd, ".puppygpt", "generated_images"))).toBeTrue()
})

test("edits accept workspace paths and recent images in chronological order", async () => {
    const options = await fixture()
    await Bun.write(join(options.cwd, "input.png"), Buffer.from(png, "base64"))
    for (const args of [{ prompt: "Add a hat", referenced_image_paths: ["input.png"] }, { prompt: "Add a hat", num_last_images_to_include: 1 }]) {
        await generateImage({ ...options, args, history: [{ type: "function_call_output", output: [{ type: "input_image", image_url: `data:image/png;base64,${png}` }] }], fetchImpl: async (url, init) => {
            expect(String(url)).toEndWith("/images/edits")
            expect(JSON.parse(String(init?.body)).images).toEqual([{ image_url: `data:image/png;base64,${png}` }])
            return Response.json({ data: [{ b64_json: png }] })
        } })
    }
})

test("invalid references fail before sending anything", async () => {
    const options = await fixture()
    let requests = 0
    const fetchImpl = async () => { requests++; return Response.json({}) }
    for (const args of [
        { prompt: "edit", referenced_image_paths: ["input.png"], num_last_images_to_include: 1 },
        { prompt: "edit", num_last_images_to_include: 6 },
        { prompt: "edit", num_last_images_to_include: 1 },
        { prompt: "edit", referenced_image_paths: Array(6).fill("input.png") },
    ]) await expect(generateImage({ ...options, args, fetchImpl })).rejects.toThrow()
    const outside = await fixture()
    await Bun.write(join(outside.cwd, "outside.png"), Buffer.from(png, "base64"))
    await symlink(join(outside.cwd, "outside.png"), join(options.cwd, "linked.png"))
    await expect(generateImage({ ...options, args: { prompt: "edit", referenced_image_paths: ["linked.png"] }, fetchImpl })).rejects.toThrow("inside the working directory")
    expect(requests).toBe(0)
})

test("HTTP failures are not retried and malformed image results are rejected", async () => {
    const options = await fixture()
    let requests = 0
    await expect(generateImage({ ...options, args: { prompt: "puppy" }, fetchImpl: async () => { requests++; return new Response("overloaded", { status: 503 }) } })).rejects.toThrow("503")
    expect(requests).toBe(1)
    for (const body of [{ data: [] }, { data: [{ b64_json: Buffer.from("not a png").toString("base64") }] }]) {
        await expect(generateImage({ ...options, args: { prompt: "puppy" }, fetchImpl: async () => Response.json(body) })).rejects.toThrow()
    }
})

test("cancelling aborts the image request", async () => {
    const options = await fixture()
    const controller = new AbortController()
    const result = generateImage({ ...options, args: { prompt: "puppy" }, signal: controller.signal, fetchImpl: async (_url, init) => {
        return new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true })
            controller.abort(new DOMException("Stopped", "AbortError"))
        })
    } })
    await expect(result).rejects.toThrow("Stopped")
})
