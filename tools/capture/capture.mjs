#!/usr/bin/env node
/**
 * AETHERFALL demo-capture — playwright-less capture helper.
 *
 * Tries real screenshots when Playwright is installed; otherwise generates
 * SVG mockups so README / landing never show broken images.
 *
 * Usage:
 *   node tools/capture/capture.mjs [--out docs/screenshots]
 *      [--server ws://localhost:8081] [--health http://localhost:9090/healthz]
 *      [--client http://localhost:5173]
 *
 * Manual F12 flow (when playwright is missing):
 *   1. npm run dev:server  ( :8081 WS, :9090 /metrics + /healthz )
 *   2. npm run dev:client  ( :5173 )
 *   3. Open http://localhost:5173/?name=hero&autojoin=1  → F12 → device 1280x720
 *      → screenshot → save as docs/screenshots/shot-play.png
 *   4. Same with ?editormode=1 for the editor shot.
 *   5. Re-run this script — it keeps any *.png you captured and only
 *      (re)generates the SVG placeholders it owns.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) {
      const k = cur.slice(2);
      const v = arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "1";
      acc.push([k, v]);
    }
    return acc;
  }, []),
);

const outDir = resolve(root, args.out ?? "docs/screenshots");
const healthUrl = args.health ?? "http://localhost:9090/healthz";
const clientUrl = args.client ?? "http://localhost:5173";
const serverUrl = args.server ?? "ws://localhost:8081";

mkdirSync(outDir, { recursive: true });

function hasPlaywright() {
  try {
    execSync("npx --no-install playwright --version", { stdio: "pipe", timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

async function checkHttp(url, timeoutMs = 4000) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message ?? e) };
  }
}

async function tryPlaywrightShots() {
  // Dynamic import so the script works with zero deps when playwright is absent.
  let pw;
  try {
    pw = await import("playwright");
  } catch {
    return { ok: false, reason: "playwright npm package not installed" };
  }
  const shots = [
    { name: "shot-play.png", url: `${clientUrl}/?name=hero&autojoin=1`, label: "gameplay" },
    { name: "shot-night.png", url: `${clientUrl}/?name=hero&autojoin=1&night=1`, label: "night raid" },
    { name: "shot-editor.png", url: `${clientUrl}/?editormode=1&name=hero&autojoin=1`, label: "editor" },
  ];
  try {
    const browser = await pw.chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    for (const s of shots) {
      try {
        await page.goto(s.url, { waitUntil: "networkidle", timeout: 20000 });
        await page.waitForTimeout(4000);
        await page.screenshot({ path: resolve(outDir, s.name) });
        console.log(`[capture] shot ${s.label} -> ${s.name}`);
      } catch (e) {
        console.log(`[capture] shot ${s.label} FAILED: ${String(e?.message ?? e)}`);
      }
    }
    await browser.close();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

async function main() {
  console.log("[capture] AETHERFALL demo capture");
  console.log(`[capture] server=${serverUrl} health=${healthUrl} client=${clientUrl}`);
  console.log(`[capture] out=${outDir}`);

  const [health, client] = await Promise.all([checkHttp(healthUrl), checkHttp(clientUrl)]);
  console.log(
    `[capture] healthz ${healthUrl} -> ${health.ok ? `OK ${health.status}` : `UNREACHABLE (${health.error ?? health.status})`}`,
  );
  console.log(
    `[capture] client  ${clientUrl} -> ${client.ok ? `OK ${client.status}` : `UNREACHABLE (${client.error ?? client.status})`}`,
  );
  if (!health.ok) {
    console.log("[capture] server offline — using replay-file fallback for the demo:");
    console.log("  node tools/replay/dist/recorder.js --help   # record when server is back");
    console.log("  open tools/replay/viewer.html + tools/replay/recordings/*.ndjson for a scrubbed run");
  }

  const pw = hasPlaywright();
  console.log(`[capture] playwright CLI: ${pw ? "FOUND" : "missing — SVG fallback mode"}`);
  if (pw) {
    const r = await tryPlaywrightShots();
    console.log(`[capture] playwright shots: ${r.ok ? "done" : `skipped (${r.reason})`}`);
  }

  // Always (re)generate SVG placeholders — never overwrites real *.png captures.
  const { generateMockups } = await import("./mockups.mjs");
  const made = generateMockups(outDir);
  // Mirror into client/public/shots so vite preview/serving can display them.
  const pubDir = resolve(root, "client/public/shots");
  if (resolve(outDir) !== resolve(pubDir)) {
    mkdirSync(pubDir, { recursive: true });
    const { copyFileSync } = await import("node:fs");
    for (const f of made) {
      try {
        copyFileSync(resolve(outDir, f), resolve(pubDir, f));
      } catch { /* best-effort mirror */ }
    }
    console.log(`[capture] mirrored ${made.length} svg(s) -> client/public/shots/`);
  }

  const existing = existsSync(outDir) ? readdirSync(outDir) : [];
  console.log(`[capture] docs/screenshots now: ${existing.join(", ")}`);
  console.log("[capture] manual F12 steps (when playwright missing):");
  console.log("  1. npm run dev:server  &  npm run dev:client");
  console.log("  2. http://localhost:5173/?name=hero&autojoin=1  → F12 → 1280x720 → screenshot");
  console.log("  3. save as docs/screenshots/shot-play.png (this script never deletes *.png)");
  console.log("[capture] done.");
}

await main();
