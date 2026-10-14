# Chaanavya Agent Instructions

Project documentation lives in a local `docs/` folder that is not versioned in git or deployed. When it is present, read `docs/AGENTS.md` before changing this project; it defines the project context, documentation map, implementation conventions, and validation requirements.

Use [design-system/chaanavya/MASTER.md](design-system/chaanavya/MASTER.md) as the visual authority. Check for a page override under `design-system/chaanavya/pages/` when working on a specific page.

Inspect relevant code as well as documentation. Documented current behavior is descriptive; launch requirements and proposed work are not claims that those features already exist. Identify material conflicts instead of silently resolving business decisions.

Keep credentials and full Shopify cart IDs out of documentation, logs, and responses. Do not read or print `.env.local` values merely to understand the project. Never turn demonstration catalog data into confirmed merchandise or publish placeholder policies as approved business terms.
