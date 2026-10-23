# Chaanavya Agent Instructions

Project documentation lives in a local `docs/` folder that is not versioned in git or deployed. When it is present, read `docs/AGENTS.md` before changing this project; it defines the project context, documentation map, implementation conventions, and validation requirements.

Use [design-system/chaanavya/MASTER.md](design-system/chaanavya/MASTER.md) as the visual authority. Check for a page override under `design-system/chaanavya/pages/` when working on a specific page.

Inspect relevant code as well as documentation. Documented current behavior is descriptive; launch requirements and proposed work are not claims that those features already exist. Identify material conflicts instead of silently resolving business decisions.

Keep credentials, session tokens and one-time codes out of documentation, logs, and responses. Do not read or print `.env.local` values merely to understand the project. Never turn demonstration catalog data into confirmed merchandise or publish placeholder policies as approved business terms.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
