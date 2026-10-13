// Renders the three Chaanavya perfume bottle illustrations (1200x1500 PNG): a classic rectangular
// bottle with a gold cap and the Chaanavya logo mark as the only label artwork.
// Usage (from the project root): node scripts/perfume-art.mjs . [outDir]
// Drawn illustration, not a photo. Edit `scents` to add a fragrance, then re-upload the PNG in Shopify.
import { readFileSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"

const root = resolve(process.argv[2] || ".")
const outDir = process.argv[3] || join(root, "public", "assets")
const require = createRequire(join(root, "package.json"))
const sharp = require("sharp")

const logo = `data:image/png;base64,${readFileSync(join(root, "public", "assets", "logo-mark.png")).toString("base64")}`

// Brand palette only: teal, terracotta, midnight ink.
const scents = [
  { file: "perfume-royal-oud-classic", glass: ["#0d5a5b", "#073f40", "#042829"] },
  { file: "perfume-gilded-rose-classic", glass: ["#c8704a", "#a8461f", "#6e2a10"] },
  { file: "perfume-midnight-court-classic", glass: ["#2a3f4f", "#152633", "#0a141c"] },
]

const svg = ({ glass: [g1, g2, g3] }) => `
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="1500" viewBox="0 0 1200 1500">
  <defs>
    <radialGradient id="bg" cx="50%" cy="40%" r="75%">
      <stop offset="0" stop-color="#fdfaf4"/><stop offset="0.6" stop-color="#f3ecdf"/><stop offset="1" stop-color="#e6d8be"/>
    </radialGradient>
    <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${g1}"/><stop offset="0.55" stop-color="${g2}"/><stop offset="1" stop-color="${g3}"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#8a6420"/><stop offset="0.3" stop-color="#d9b26a"/><stop offset="0.5" stop-color="#f3dca0"/>
      <stop offset="0.72" stop-color="#c99a45"/><stop offset="1" stop-color="#8a6420"/>
    </linearGradient>
    <radialGradient id="shadow" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#5a4a30" stop-opacity="0.32"/><stop offset="1" stop-color="#5a4a30" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="body"><rect x="400" y="560" width="400" height="720" rx="48"/></clipPath>
  </defs>

  <rect width="1200" height="1500" fill="url(#bg)"/>
  <ellipse cx="600" cy="1292" rx="300" ry="40" fill="url(#shadow)"/>

  <!-- Glass body -->
  <g clip-path="url(#body)">
    <rect x="400" y="560" width="400" height="720" fill="url(#glass)"/>
    <rect x="400" y="1196" width="400" height="84" fill="#000000" opacity="0.16"/>
    <rect x="432" y="600" width="34" height="580" rx="17" fill="#ffffff" opacity="0.12"/>
    <rect x="740" y="600" width="26" height="600" rx="13" fill="#000000" opacity="0.14"/>
  </g>
  <rect x="400" y="560" width="400" height="720" rx="48" fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="3"/>

  <!-- Neck, collar and cap -->
  <rect x="560" y="512" width="80" height="56" fill="url(#glass)"/>
  <rect x="540" y="492" width="120" height="30" rx="4" fill="url(#gold)"/>
  <rect x="520" y="300" width="160" height="196" rx="10" fill="url(#gold)"/>
  <rect x="520" y="300" width="160" height="196" rx="10" fill="none" stroke="#8a6420" stroke-width="2"/>
  <rect x="540" y="312" width="16" height="172" rx="8" fill="#ffffff" opacity="0.25"/>

  <!-- Label: the Chaanavya logo mark only -->
  <rect x="460" y="760" width="280" height="320" rx="10" fill="#fbf7f0"/>
  <rect x="472" y="772" width="256" height="296" rx="6" fill="none" stroke="#b8893e" stroke-width="2"/>
  <image href="${logo}" xlink:href="${logo}" x="490" y="810" width="220" height="220"/>
</svg>`

mkdirSync(outDir, { recursive: true })
for (const scent of scents) {
  const out = join(outDir, `${scent.file}.png`)
  await sharp(Buffer.from(svg(scent))).png({ compressionLevel: 9 }).toFile(out)
  console.log("wrote", out)
}
