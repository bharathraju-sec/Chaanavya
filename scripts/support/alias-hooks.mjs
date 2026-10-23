// Node module resolution hooks for tests and admin scripts (Stage 05): resolve the project's "@/..." imports the way
// tsconfig "paths" and Next.js do, and add the file extensions that bundlers add implicitly
// (for example "next/server" -> "next/server.js"). Tests and scripts only; the application never loads this.
const ROOT = new URL("../../", import.meta.url)
const SOURCE_EXTENSIONS = ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts", "/index.js"]
const PACKAGE_EXTENSIONS = [".js", "/index.js"]

async function firstResolvable(candidates, context, nextResolve) {
  let lastError
  for (const candidate of candidates) {
    try {
      return await nextResolve(candidate, context)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const base = new URL(specifier.slice(2), ROOT).href
    return firstResolvable(SOURCE_EXTENSIONS.map(ext => base + ext), context, nextResolve)
  }
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" && error?.code !== "ERR_UNSUPPORTED_DIR_IMPORT") throw error
    if (/\.[cm]?[jt]sx?$/.test(specifier)) throw error
    return firstResolvable(PACKAGE_EXTENSIONS.map(ext => specifier + ext), context, nextResolve)
  }
}
