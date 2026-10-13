// Renders the three Chaanavya perfume bottle illustrations (1200x1500 PNG) with the real logo mark.
// Usage (from the project root): node scripts/perfume-art.mjs . [outDir]
// Drawn illustration, not a photo. Edit scents to add a fragrance, then re-upload the PNG in Shopify.
import { readFileSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"

const root = resolve(process.argv[2] || ".")
const outDir = process.argv[3] || join(root, "public", "assets")
const require = createRequire(join(root, "package.json"))
const sharp = require("sharp")

const logo = `data:image/png;base64,${readFileSync(join(root, "public", "assets", "logo-mark.png")).toString("base64")}`

// Brand palette only (no purple): teal, terracotta, midnight ink, with gold.
const scents = [
  { file: "perfume-royal-oud", name: "ROYAL OUD", notes: "AMBER · OUD · SAFFRON", glass: ["#0d5a5b", "#073f40", "#042829"] },
  { file: "perfume-gilded-rose", name: "GILDED ROSE", notes: "ROSE · PEONY · GOLD MUSK", glass: ["#c8704a", "#a8461f", "#6e2a10"] },
  { file: "perfume-midnight-court", name: "MIDNIGHT COURT", notes: "PLUM · VANILLA · DARK WOODS", glass: ["#2a3f4f", "#152633", "#0a141c"] },
]

const svg = ({ name, notes, glass: [g1, g2, g3] }) => `
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="1500" viewBox="0 0 1200 1500">
  <defs>
    <radialGradient id="bg" cx="50%" cy="38%" r="75%">
      <stop offset="0" stop-color="#fdfaf4"/><stop offset="0.6" stop-color="#f3ecdf"/><stop offset="1" stop-color="#e6d8be"/>
    </radialGradient>
    <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${g1}"/><stop offset="0.55" stop-color="${g2}"/><stop offset="1" stop-color="${g3}"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#8a6420"/><stop offset="0.25" stop-color="#d9b26a"/><stop offset="0.5" stop-color="#f3dca0"/>
      <stop offset="0.75" stop-color="#c99a45"/><stop offset="1" stop-color="#8a6420"/>
    </linearGradient>
    <linearGradient id="goldV" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f3dca0"/><stop offset="0.5" stop-color="#c99a45"/><stop offset="1" stop-color="#8a6420"/>
    </linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0"/><stop offset="0.5" stop-color="#ffffff" stop-opacity="0.22"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="shadow" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#5a4a30" stop-opacity="0.35"/><stop offset="1" stop-color="#5a4a30" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="body"><path d="M410 560 Q410 500 470 480 L730 480 Q790 500 790 560 L820 640 L820 1240 Q820 1300 760 1300 L440 1300 Q380 1300 380 1240 L380 640 Z"/></clipPath>
  </defs>

  <rect width="1200" height="1500" fill="url(#bg)"/>
  <ellipse cx="600" cy="1318" rx="330" ry="46" fill="url(#shadow)"/>

  <!-- Bottle body: faceted shoulders, deep glass -->
  <g clip-path="url(#body)">
    <rect x="370" y="470" width="460" height="840" fill="url(#glass)"/>
    <polygon points="380,640 470,560 470,1240 380,1240" fill="#ffffff" opacity="0.07"/>
    <polygon points="820,640 730,560 730,1240 820,1240" fill="#000000" opacity="0.18"/>
    <rect x="455" y="470" width="70" height="840" fill="url(#shine)"/>
    <rect x="700" y="470" width="22" height="840" fill="#ffffff" opacity="0.06"/>
    <path d="M470 560 L730 560" stroke="#ffffff" stroke-opacity="0.15" stroke-width="2"/>
  </g>
  <path d="M410 560 Q410 500 470 480 L730 480 Q790 500 790 560 L820 640 L820 1240 Q820 1300 760 1300 L440 1300 Q380 1300 380 1240 L380 640 Z" fill="none" stroke="url(#gold)" stroke-width="8"/>
  <path d="M398 1268 L802 1268" stroke="url(#gold)" stroke-width="5"/>

  <!-- Neck and gold collar -->
  <rect x="540" y="430" width="120" height="58" fill="url(#glass)"/>
  <rect x="520" y="404" width="160" height="40" rx="6" fill="url(#gold)"/>
  <rect x="520" y="404" width="160" height="40" rx="6" fill="none" stroke="#8a6420" stroke-width="2"/>
  <g stroke="#8a6420" stroke-width="2" opacity="0.6">
    <line x1="545" y1="410" x2="545" y2="438"/><line x1="575" y1="410" x2="575" y2="438"/><line x1="625" y1="410" x2="625" y2="438"/><line x1="655" y1="410" x2="655" y2="438"/>
  </g>
  <circle cx="600" cy="424" r="9" fill="${g2}" stroke="#f3dca0" stroke-width="3"/>

  <!-- Crown cap -->
  <rect x="505" y="300" width="190" height="104" fill="url(#gold)"/>
  <g fill="none" stroke="#8a6420" stroke-width="2" opacity="0.55">
    <line x1="540" y1="300" x2="540" y2="404"/><line x1="575" y1="300" x2="575" y2="404"/><line x1="625" y1="300" x2="625" y2="404"/><line x1="660" y1="300" x2="660" y2="404"/>
  </g>
  <rect x="505" y="300" width="190" height="104" fill="none" stroke="#8a6420" stroke-width="3"/>
  <path d="M505 300 L520 222 L560 268 L600 196 L640 268 L680 222 L695 300 Z" fill="url(#goldV)" stroke="#8a6420" stroke-width="3" stroke-linejoin="round"/>
  <circle cx="520" cy="216" r="11" fill="url(#goldV)" stroke="#8a6420" stroke-width="2"/>
  <circle cx="600" cy="186" r="14" fill="url(#goldV)" stroke="#8a6420" stroke-width="2"/>
  <circle cx="680" cy="216" r="11" fill="url(#goldV)" stroke="#8a6420" stroke-width="2"/>
  <circle cx="600" cy="268" r="10" fill="${g2}" stroke="#f3dca0" stroke-width="3"/>
  <circle cx="555" cy="282" r="6" fill="${g2}" stroke="#f3dca0" stroke-width="2"/>
  <circle cx="645" cy="282" r="6" fill="${g2}" stroke="#f3dca0" stroke-width="2"/>

  <!-- Label: arched ivory plaque with double gold frame and the real logo mark -->
  <path d="M455 760 Q455 650 600 640 Q745 650 745 760 L745 1150 Q745 1170 725 1170 L475 1170 Q455 1170 455 1150 Z" fill="#fbf7f0"/>
  <path d="M455 760 Q455 650 600 640 Q745 650 745 760 L745 1150 Q745 1170 725 1170 L475 1170 Q455 1170 455 1150 Z" fill="none" stroke="url(#gold)" stroke-width="6"/>
  <path d="M470 765 Q470 668 600 657 Q730 668 730 765 L730 1143 Q730 1155 718 1155 L482 1155 Q470 1155 470 1143 Z" fill="none" stroke="#b8893e" stroke-width="2"/>
  <image href="${logo}" xlink:href="${logo}" x="520" y="680" width="160" height="160"/>
  <text x="600" y="900" text-anchor="middle" font-family="Cormorant Garamond, Cormorant, Georgia, 'Times New Roman', serif" font-size="30" font-weight="600" letter-spacing="5" fill="#073f40">CHAANAVYA</text>
  <path d="M520 928 L585 928 M615 928 L680 928" stroke="#b8893e" stroke-width="2"/>
  <rect x="594" y="922" width="12" height="12" fill="#b8893e" transform="rotate(45 600 928)"/>
  <text x="600" y="992" text-anchor="middle" font-family="Cormorant Garamond, Cormorant, Georgia, 'Times New Roman', serif" font-size="${name.length > 11 ? 21 : 30}" font-weight="600" letter-spacing="${name.length > 11 ? 2 : 3}" fill="#a8461f">${name}</text>
  <text x="600" y="1040" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="13" letter-spacing="1.5" fill="#56625e">${notes}</text>
  <text x="600" y="1110" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="14" letter-spacing="3" fill="#073f40">EAU DE PARFUM · 50 ML</text>
</svg>`

mkdirSync(outDir, { recursive: true })
for (const scent of scents) {
  const out = join(outDir, `${scent.file}.png`)
  await sharp(Buffer.from(svg(scent))).png({ compressionLevel: 9 }).toFile(out)
  console.log("wrote", out)
}
