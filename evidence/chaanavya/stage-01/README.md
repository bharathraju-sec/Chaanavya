# Stage 01 evidence: repository audit and Shopify dependency map

Captured 15 October 2026 in the upgrade workspace `backup/upgrade` (copy of main 7347829; main is now 60ea71a).
Write-up: `docs/migration/dependency-map.md` (local docs folder, not versioned).

| File | What it shows |
| --- | --- |
| baseline.txt | Git SHAs, Node/npm and package versions, env variable names with set/empty status (no values) |
| lint.log | `npm run lint`, exit 0 |
| typecheck.log | `npm run typecheck`, exit 0 |
| build.log | `npm run build`, exit 0, route table |
| routes.txt | Local route statuses and redirects (dev server on port 5601, demo catalogue) |
| production-handles.txt | Product handles linked from live collection pages on https://chaanavya.in (public GET only) |
| no-change-check.txt | Workspace vs clean export of main 60ea71a |

Not verified: production environment variables on Vercel (connector returned 403, Vercel CLI not installed); checkout, payment and order emails (not exercised); reviewer sign-off (no reviewer assigned).
No credentials were printed or modified, and no cart IDs were recorded.
