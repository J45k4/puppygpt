import { mkdir, mkdtemp, realpath } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { viewImage } from "./image"
import { HttpError } from "./responses"
import { asObject, asString, type FetchLike, type JsonObject } from "./types"

export const IMAGEGEN_TOOL: JsonObject = {
    type: "function",
    name: "imagegen",
    description: "Generate or edit images with gpt-image-2. Supply a detailed prompt. For edits, supply up to five workspace image paths OR num_last_images_to_include (1–5), never both. Omit both for a new image. Request transparency in the prompt when needed. Images are saved in the workspace and displayed to the user automatically. Use this tool for image creation and editing requests.",
    strict: false,
    parameters: {
        type: "object",
        properties: {
            prompt: { type: "string" },
            referenced_image_paths: { type: ["array", "null"], items: { type: "string" }, maxItems: 5 },
            num_last_images_to_include: { type: ["integer", "null"], minimum: 1, maximum: 5 },
        },
        required: ["prompt"],
        additionalProperties: false,
    },
}

export type ImagegenArgs = { prompt: string, referenced_image_paths?: string[] | null, num_last_images_to_include?: number | null }
export type GeneratedImage = { path: string, imageUrl: string, mimeType: "image/png", size: number }
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

export function parseImagegenArgs(value: unknown): ImagegenArgs {
    const args = asObject(value)
    const prompt = asString(args?.prompt)?.trim()
    if (!prompt) throw new Error("imagegen requires a non-empty prompt")
    const paths = args?.referenced_image_paths
    const count = args?.num_last_images_to_include
    if (paths != null && (!Array.isArray(paths) || paths.length > 5 || paths.some(path => typeof path !== "string" || !path.trim()))) {
        throw new Error("referenced_image_paths must contain at most five non-empty paths")
    }
    if (count != null && (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 5)) {
        throw new Error("num_last_images_to_include must be between 1 and 5")
    }
    if (Array.isArray(paths) && paths.length && count != null) throw new Error("Provide image paths or a recent-image count, never both")
    return { prompt, referenced_image_paths: paths as string[] | null | undefined, num_last_images_to_include: count as number | null | undefined }
}

function recentImages(history: JsonObject[], count: number): string[] {
    const urls: string[] = []
    for (const item of history) {
        const content = item.type === "function_call_output" || item.type === "custom_tool_call_output" ? item.output : item.content
        if (!Array.isArray(content)) continue
        for (const part of content) {
            const image = asObject(part)
            if (image?.type === "input_image" && typeof image.image_url === "string") urls.push(image.image_url)
        }
    }
    if (urls.length < count) throw new Error(`Requested ${count} recent images, but only ${urls.length} are available; use saved image paths instead`)
    return urls.slice(-count)
}

async function boundedJson(response: Response): Promise<unknown> {
    if (!response.body) throw new Error("Image generation returned no response body")
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            bytes += value.length
            if (bytes > MAX_RESPONSE_BYTES) throw new Error("Image generation response is too large")
            chunks.push(value)
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } finally {
        await reader.cancel().catch(() => {})
    }
}

export async function generateImage(options: {
    args: ImagegenArgs, cwd: string, endpoint: string, headers: HeadersInit,
    history: JsonObject[], fetchImpl?: FetchLike, signal?: AbortSignal,
}): Promise<GeneratedImage> {
    const args = parseImagegenArgs(options.args)
    const images = args.referenced_image_paths?.length
        ? await Promise.all(args.referenced_image_paths.map(async path => (await viewImage(path, options.cwd)).imageUrl))
        : args.num_last_images_to_include ? recentImages(options.history, args.num_last_images_to_include) : []
    const endpoint = new URL(options.endpoint)
    if (!endpoint.pathname.endsWith("/responses")) throw new Error("Codex endpoint must end with /responses")
    endpoint.pathname = endpoint.pathname.slice(0, -"responses".length) + (images.length ? "images/edits" : "images/generations")
    endpoint.search = ""
    const headers = new Headers(options.headers)
    headers.set("Accept", "application/json")
    headers.set("Content-Type", "application/json")
    const timeout = AbortSignal.timeout(300_000)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
        method: "POST", headers, signal,
        body: JSON.stringify({
            model: "gpt-image-2", prompt: args.prompt, background: "auto", quality: "auto", size: "auto",
            ...(images.length ? { images: images.map(image_url => ({ image_url })) } : {}),
        }),
    })
    if (!response.ok) {
        // Never replay a potentially completed generation after a network/server failure.
        await response.body?.cancel()
        throw new HttpError(response.status, `Image generation failed (HTTP ${response.status})`)
    }
    const data = asObject(await boundedJson(response))
    const b64 = asString(asObject(Array.isArray(data?.data) ? data.data[0] : undefined)?.b64_json)
    if (!b64 || b64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
        throw new Error("Image generation returned missing, invalid, or oversized image data")
    }
    const bytes = Buffer.from(b64, "base64")
    if (bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error("Image generation did not return a supported PNG")
    }
    signal.throwIfAborted()
    const cwd = await realpath(options.cwd)
    let resolved = cwd
    for (const segment of [".puppygpt", "generated_images"]) {
        const directory = join(resolved, segment)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        resolved = await realpath(directory)
        const rel = relative(cwd, resolved)
        if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Generated image directory must be inside the workspace")
    }
    const directory = await mkdtemp(join(resolved, "image-"))
    const path = join(directory, "image.png")
    await Bun.write(path, bytes, { mode: 0o600 })
    return { path, mimeType: "image/png", size: bytes.length, imageUrl: `data:image/png;base64,${b64}` }
}
