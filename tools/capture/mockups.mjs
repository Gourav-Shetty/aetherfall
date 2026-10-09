#!/usr/bin/env node
/**
 * SVG mockup generator for docs/screenshots/.
 * Zero dependencies. Idempotent — rewrites the 3 SVGs it owns.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_OUT = resolve(root, "docs/screenshots");

const W = 960;
const H = 600;

function isoTiles({ cols = 14, rows = 9, tw = 56, th = 28, ox = 480, oy = 120, night = false }) {
  const base = night ? ["#16233d", "#101c33"] : ["#1d3a2f", "#173325"];
  const alt = night ? ["#1b2c4d", "#1e3a2e"] : ["#24503c", "#1e4433"];
  let s = "";
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const cx = ox + ((x - y) * tw) / 2;
      const cy = oy + ((x + y) * th) / 2;
      const c = (x + y) % 2 === 0 ? base[(x * 7 + y) % 2] : alt[(x * 3 + y * 5) % 2];
      s += `<polygon points="${cx},${cy - th / 2} ${cx + tw / 2},${cy} ${cx},${cy + th / 2} ${cx - tw / 2},${cy}" fill="${c}" stroke="#0b0e14" stroke-width="1"/>`;
    }
  }
  return s;
}

function hud({ hp = 82, xp = 45 }) {
  return `
  <g font-family="system-ui,sans-serif">
    <rect x="16" y="14" width="220" height="18" rx="4" fill="#20262f" stroke="#3a4557"/>
    <rect x="16" y="14" width="${(220 * hp) / 100}" height="18" rx="4" fill="#2ca85c"/>
    <text x="126" y="27" font-size="11" fill="#fff" text-anchor="middle">HP ${hp}/100</text>
    <rect x="16" y="36" width="220" height="12" rx="4" fill="#20262f" stroke="#3a4557"/>
    <rect x="16" y="36" width="${(220 * xp) / 100}" height="12" rx="4" fill="#3b6fd4"/>
    <rect x="16" y="52" width="220" height="40" rx="4" fill="rgba(20,26,36,.85)" stroke="#3a4557"/>
    <text x="26" y="68" font-size="10" fill="#8fa3bf">inv: iron-sword · potion ×3 · quest-scroll</text>
    <text x="26" y="82" font-size="10" fill="#59d98c">quest: Maren chain 2/5 — find the north shrine</text>
  </g>`;
}

function minimap({ x = 824, y = 14, s = 120 }) {
  return `
  <g font-family="system-ui,sans-serif">
    <rect x="${x}" y="${y}" width="${s}" height="${s}" rx="6" fill="#0d1f16" stroke="#3a4557"/>
    <text x="${x + 8}" y="${y + 16}" font-size="10" fill="#8fa3bf">100×100 · seed 1337</text>
    ${Array.from({ length: 12 }, (_, i) => `<circle cx="${x + 14 + ((i * 37) % (s - 28))}" cy="${y + 26 + ((i * 53) % (s - 40))}" r="3" fill="${i === 3 ? "#59d98c" : i % 4 === 0 ? "#ff5252" : "#4dc3ff"}"/>`).join("")}
    <circle cx="${x + s / 2}" cy="${y + s / 2}" r="16" fill="none" stroke="#ffe066" stroke-dasharray="4 3"/>
  </g>`;
}

function chrome(title, sub) {
  return `
  <rect x="0" y="0" width="${W}" height="46" fill="#11161f"/>
  <text x="16" y="29" font-family="system-ui,sans-serif" font-size="16" font-weight="800" letter-spacing="3" fill="#9ecbff">AETHERFALL</text>
  <text x="190" y="29" font-family="system-ui,sans-serif" font-size="12" fill="#8fa3bf">${title}</text>
  <rect x="0" y="${H - 34}" width="${W}" height="34" fill="rgba(10,14,20,.9)"/>
  <text x="16" y="${H - 12}" font-family="system-ui,sans-serif" font-size="11" fill="#8fa3bf">${sub}</text>`;
}

function actors(kind) {
  if (kind === "map") {
    return `
    <g font-family="system-ui,sans-serif" text-anchor="middle">
      <ellipse cx="480" cy="330" rx="46" ry="20" fill="#0e2a22" stroke="#59d98c" stroke-width="2"/>
      <rect x="462" y="270" width="36" height="52" rx="4" fill="#2a3547" stroke="#9ecbff"/>
      <text x="480" y="258" font-size="13" fill="#ffe066">⛩ shrine (50,50)</text>
      <circle cx="430" cy="352" r="10" fill="#59d98c" stroke="#06130c" stroke-width="2"/>
      <text x="430" y="332" font-size="11" fill="#fff">hero</text>
      <circle cx="540" cy="360" r="9" fill="#4dc3ff" stroke="#06130c" stroke-width="2"/>
      <text x="540" y="342" font-size="11" fill="#fff">bot7</text>
      <circle cx="505" cy="300" r="8" fill="#ff5252"/>
      <rect x="488" y="282" width="34" height="6" fill="#20262f"/><rect x="488" y="282" width="22" height="6" fill="#ff5252"/>
      <text x="505" y="274" font-size="10" fill="#ffb3b3">gloom rat · 12hp</text>
      <text x="700" y="540" font-size="11" fill="#8fa3bf">day cycle ☀ · 20Hz tick · 10Hz snapshots · 40m interest</text>
    </g>`;
  }
  if (kind === "combat") {
    return `
    <g font-family="system-ui,sans-serif" text-anchor="middle">
      <ellipse cx="480" cy="360" rx="120" ry="46" fill="none" stroke="#ff5252" stroke-width="2" stroke-dasharray="8 5"/>
      <text x="480" y="310" font-size="12" fill="#ff8080">BOSS TELEGRAPH — 2.0s windup, get out of the ring</text>
      <rect x="452" y="330" width="56" height="64" rx="6" fill="#3a1f2a" stroke="#ff5252" stroke-width="2"/>
      <text x="480" y="322" font-size="12" fill="#ff8080">👹 hollow king</text>
      <rect x="446" y="400" width="68" height="7" fill="#20262f"/><rect x="446" y="400" width="41" height="7" fill="#ff5252"/>
      <circle cx="400" cy="380" r="10" fill="#59d98c" stroke="#06130c" stroke-width="2"/>
      <circle cx="560" cy="385" r="10" fill="#4dc3ff" stroke="#06130c" stroke-width="2"/>
      <text x="360" y="350" font-size="14" font-weight="800" fill="#ffe066">-24</text>
      <text x="600" y="360" font-size="14" font-weight="800" fill="#ffe066">-18</text>
      <text x="400" y="362" font-size="11" fill="#fff">hero</text>
      <text x="560" y="367" font-size="11" fill="#fff">bot3</text>
      <text x="700" y="540" font-size="11" fill="#8fa3bf">night raid 🌙 · server owns damage · client predicts + reconciles</text>
    </g>`;
  }
  return `
  <g font-family="system-ui,sans-serif">
    <rect x="60" y="70" width="600" height="440" rx="8" fill="#141021" stroke="#6a4a9a" stroke-width="2"/>
    <text x="80" y="100" font-size="13" fill="#b9a8d9">LEVEL EDITOR — paint walls, export JSON → tools/ import</text>
    ${Array.from({ length: 12 }, (_, r) => Array.from({ length: 18 }, (_, c) => {
      const wall = (r === 2 && c > 3 && c < 12) || (c === 14 && r > 3 && r < 9);
      return `<rect x="${90 + c * 28}" y="${120 + r * 28}" width="26" height="26" rx="3" fill="${wall ? "#6a4a9a" : "#1c1626"}" stroke="#3a2f52"/>`;
    }).join("")).join("")}
    <circle cx="480" cy="330" r="70" fill="none" stroke="#ffb84d" stroke-width="2" stroke-dasharray="6 4"/>
    <text x="480" y="335" font-size="12" fill="#ffb84d" text-anchor="middle">boss arena trigger r=8u</text>
    <rect x="690" y="70" width="210" height="440" rx="8" fill="#1a2230" stroke="#2a3547"/>
    <text x="706" y="100" font-size="12" fill="#e8eef7">brush: wall ⬛</text>
    <text x="706" y="122" font-size="11" fill="#8fa3bf">[1] wall  [2] erase</text>
    <text x="706" y="144" font-size="11" fill="#8fa3bf">[e] export JSON</text>
    <text x="706" y="180" font-size="11" fill="#59d98c">exported: arena-3zone.json</text>
    <text x="706" y="198" font-size="11" fill="#8fa3bf">132 walls · seed 1337</text>
  </g>`;
}

function svgDoc(kind) {
  const titles = {
    map: ["ISOMETRIC SHRINE · day", "WASD move · Space attack · Enter chat · L leaderboard · M mute — capture: ?name=hero&amp;autojoin=1"],
    combat: ["NIGHT RAID · boss telegraph", "server-authoritative damage · prediction + reconcile — capture: night run with 2 clients"],
    editor: ["EDITOR · boss arena paint", "?editormode=1 — walls export to tools/ — capture: paint + export JSON"],
  };
  const night = kind === "combat";
  const bg = night ? "#0a0e1a" : "#0b0e14";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${bg}"/>
${night ? `<ellipse cx="800" cy="90" rx="26" ry="26" fill="#e8eef7" opacity=".85"/><ellipse cx="790" cy="84" rx="26" ry="26" fill="${bg}" opacity=".9"/>` : `<circle cx="830" cy="90" r="24" fill="#ffe066" opacity=".9"/>`}
${isoTiles({ night })}
${kind === "editor" ? "" : `<ellipse cx="480" cy="352" rx="150" ry="30" fill="#000" opacity=".35"/>`}
${actors(kind)}
${hud({})}
${minimap({})}
${chrome(titles[kind][0], titles[kind][1])}
<text x="${W - 16}" y="${H - 12}" font-family="system-ui,sans-serif" font-size="11" fill="#55677f" text-anchor="end">SVG placeholder — replace with F12 .png when captured</text>
</svg>
`;
}

export function generateMockups(outDir = DEFAULT_OUT) {
  mkdirSync(outDir, { recursive: true });
  const files = {
    "map-isometric-shrine.svg": svgDoc("map"),
    "combat-night-raid.svg": svgDoc("combat"),
    "editor-boss-arena.svg": svgDoc("editor"),
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(resolve(outDir, name), content, "utf8");
  }
  return Object.keys(files);
}

const isCLI = resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (isCLI) {
  const out = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_OUT;
  const made = generateMockups(out);
  console.log(`[mockups] wrote ${made.join(", ")} -> ${out}`);
}
