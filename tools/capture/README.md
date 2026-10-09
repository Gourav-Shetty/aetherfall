# tools/capture — demo screenshots + benchmark dashboard

Playwright-less by design. Real screenshots when Playwright exists, SVG
placeholders otherwise, so README/landing never show broken images.

## Capture

```powershell
cd C:\aetherfall
npm run dev:server     # :8081 WS, :9090 /metrics + /healthz (terminal 1)
npm run dev:client     # :5173 (terminal 2)
node tools/capture/capture.mjs
```

What it does:

1. GETs `http://localhost:9090/healthz` + `http://localhost:5173` and prints
   reachability (offline → suggests the replay-file fallback).
2. `npx --no-install playwright --version` — if found, screenshots 3 views
   (play / night / `?editormode=1`) into `docs/screenshots/shot-*.png`.
3. Always (re)generates the 3 SVG placeholders it owns:
   `map-isometric-shrine.svg`, `combat-night-raid.svg`,
   `editor-boss-arena.svg` — never deletes real `*.png` captures.
4. Mirrors SVGs into `client/public/shots/` so Vite serves them at `/shots/`.

Manual F12 flow (no playwright):

1. Open `http://localhost:5173/?name=hero&autojoin=1`, play 30s.
2. F12 → device toolbar 1280×720 → screenshot → save as
   `docs/screenshots/shot-play.png`.
3. Repeat with `?editormode=1` → `docs/screenshots/shot-editor.png`.

Regenerate only mockups: `node tools/capture/mockups.mjs [outDir]`.

## Dashboard

Static, zero-dep: open `tools/capture/dashboard.html` (file:// works).

- Dropdown reads `../bots/report.csv` / `../bots/report-qa20.csv`,
  file picker loads any `report-*.csv`, embedded 5-row sample on failure.
- Canvas charts: connect_ms histogram, snapshots/bot, msgs/bot, inputs/bot.
- Cards assume the 15s baseline from `docs/BENCHMARKS.md` for per-second rates.
