import { readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"

const MAX_IMAGE_BYTES = 20 * 1024 * 1024

export type ViewedImage = {
    path: string
    mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp"
    size: number
    imageUrl: string
}

const detectMimeType = (data: Buffer): ViewedImage["mimeType"] | null => {
    if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return "image/png"
    }
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        return "image/jpeg"
    }
    if (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a") {
        return "image/gif"
    }
    if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
        return "image/webp"
    }
    return null
}

export const viewImage = async (path: string, workdir = process.cwd()): Promise<ViewedImage> => {
    const root = await realpath(workdir)
    const resolvedPath = await realpath(resolve(root, path))
    const relativePath = relative(root, resolvedPath)
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
        throw new Error("view_image path must point to an image inside the working directory")
    }
    const file = await stat(resolvedPath)
    if (!file.isFile()) {
        throw new Error("view_image path must point to a file")
    }
    if (file.size > MAX_IMAGE_BYTES) {
        throw new Error("view_image supports images up to 20 MB")
    }
    const data = await readFile(resolvedPath)
    const mimeType = detectMimeType(data)
    if (!mimeType) {
        throw new Error("view_image supports PNG, JPEG, GIF, and WebP images")
    }
    return {
        path: resolvedPath,
        mimeType,
        size: data.byteLength,
        imageUrl: `data:${mimeType};base64,${data.toString("base64")}`,
    }
}
