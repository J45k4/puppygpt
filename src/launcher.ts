import { supervise } from "./update/supervisor"

process.env.NODE_ENV ??= "production"

if (process.argv.includes("--auto-update")) {
  await supervise(process.execPath)
} else {
  await import("./index")
}
