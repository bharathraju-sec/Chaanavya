// Local development: compiles the API on change (tsc --watch) and restarts it (node --watch).
// Reads the repository's .env.local. Stop with Ctrl+C.
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const tsc = fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url))
const run = (args, options = {}) => spawn(process.execPath, args, { cwd: root, stdio: "inherit", ...options })

const build = spawn(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" })
build.on("exit", code => {
  if (code !== 0 || !existsSync(new URL("../dist/main.js", import.meta.url))) process.exit(code ?? 1)
  const children = [
    run([tsc, "-p", "tsconfig.build.json", "--watch", "--preserveWatchOutput"]),
    run(["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--env-file-if-exists=../../.env.local", "--watch-path=dist", "dist/main.js"]),
  ]
  const stop = () => children.forEach(child => child.kill())
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
})
