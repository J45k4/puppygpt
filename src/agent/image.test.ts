import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { viewImage } from "./image"

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

test("view_image returns a supported image inside the work directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-image-"))
    try {
        await mkdir(join(directory, "screenshots"))
        await Bun.write(join(directory, "screenshots", "result.png"), Buffer.from(PNG_1X1, "base64"))

        const image = await viewImage("screenshots/result.png", directory)

        expect(image.path).toBe(join(directory, "screenshots", "result.png"))
        expect(image.mimeType).toBe("image/png")
        expect(image.imageUrl).toBe(`data:image/png;base64,${PNG_1X1}`)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("view_image rejects files outside the work directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-image-root-"))
    const outsideDirectory = await mkdtemp(join(tmpdir(), "puppygpt-image-outside-"))
    try {
        const outsidePath = join(outsideDirectory, "result.png")
        await Bun.write(outsidePath, Buffer.from(PNG_1X1, "base64"))
        await symlink(outsidePath, join(directory, "linked.png"))

        await expect(viewImage(outsidePath, directory)).rejects.toThrow("inside the working directory")
        await expect(viewImage("linked.png", directory)).rejects.toThrow("inside the working directory")
    } finally {
        await rm(directory, { recursive: true, force: true })
        await rm(outsideDirectory, { recursive: true, force: true })
    }
})
