# Hyperframes Composition Brief: AETHERFALL

## Objective
Create a short launch-style brag video for AETHERFALL (custom browser MMO engine).

## Output
- Composition directory: `C:\aetherfall\brag-output-2026-10-11-114319\composition\`
- Rendered video: `C:\aetherfall\brag-output-2026-10-11-114319\brag.mp4`
- Format: landscape — 1920x1080
- Duration: 20 seconds

## Source Material
- Project root: `C:\aetherfall`
- Primary files read: client/index.html (landing copy + palette), README.md, client/src/main.ts (HUD/kill-feed copy)
- Product name: AETHERFALL
- Tagline / strongest claim: "Just sockets, math, and pixels."
- Key UI moment to recreate: isometric gameplay framed by real screenshots (docs/screenshots/*.svg) + HUD copy (kill feed, damage numbers, ENTER THE FALL join card)
- Copy that must appear verbatim:
  - "No engine. No networking library."
  - "Just sockets, math, and pixels."
  - "ENTER THE FALL"
  - "github.com/Gourav-Shetty/aetherfall"

## Creative Direction
- Tone preset: cinematic
- Creative direction: dark-fantasy game trailer, trailer-scale type, hard cuts
- Interpretation: big motion, repo-true numbers, readability first
- Angle: a trailer edit for an engine; every number measured, from the repo
- Hook: black screen, two deadpan lines, gold title slam
- Outro / punchline: "Runs in your browser · MIT."
- Avoid: generic SaaS language, abstract filler, unrelated redesign

## Visual Identity
- Background: #0b0e14
- Text: #e8eef7 (dim #8fa3bf)
- Accent: #e8c66a gold (hi #f5d98a), secondary #4dc3ff
- Display font: system-ui stack (offline-safe; no webfonts)
- Body font: system-ui stack
- Visual references: gold-gradient wordmark, glass HUD cards, 3 SVG screenshots

## Storyboard
Use `brag-plan.md` as the creative contract.
Scene summary:
1. Cold open — 3.2s — two lines on black
2. Title reveal — 3.8s — gold AETHERFALL + tagline + shrine shot (beat-lock ~3.70s)
3. Combat — 4.0s — night-raid shot + telegraph/finisher callouts + kill feed pop
4. Numbers — 4.5s — 3 stat cards on beat grid (~11.06/11.60/12.65), hold set
5. Outro — 4.5s — editor shot + ENTER THE FALL + repo URL + MIT line

## Audio
- Audio role: cinematic support
- Audio arc: low bed → slam → rhythmic pops → shimmer fade
- Music: happy-beats-business-moves-vol-9-by-ende-dot-app.mp3 (114.84 BPM, cue preset in skill assets)
- Music treatment: steady bed at moderate volume, fade out over final 1.5s
- Music cue guidance: cue preset cues/vol-9; strong cues 3.70/4.23/6.34/10.54/12.65; title reveal locks ~3.70 (±0.15s); cards snap to beats (±0.10s)
- Audio-reactive treatment: subtle — hero gold glow breathes with music energy; skip if extraction unavailable
- Audio-coupled moments: title slam + impact; card pops; final shimmer
- SFX selection guidance: sparse; impact for slam, short pops for cards, shimmer for outro; low high-frequency-risk files for repeats
- SFX analysis guidance: skill assets sfx-analysis.md/json
- Exact SFX choice: Hyperframes decides filenames/timestamps/density/volume
- Audio files: music copied to composition/assets/music/ by builder

## Hyperframes Instructions
Build with the current Hyperframes workflow (hyperframes-core contract, determinism rules, lint-clean). Single index.html composition, GSAP paused timeline, local GSAP file. Show real project visuals (the 3 screenshots). Keep text readable. 20 seconds. Include music/SFX layer. Run `hyperframes check` before render. All local.
