# Systems Layer

The pure modules in `server/src/systems/*` are composed into
the running server via `server/src/game/integrated.ts` and adds the matching
client panels, behind the `SYSTEMS` feature flag. No gameplay rule is
re-implemented in the integration layer — it is glue only.

```
server/src/systems/            (pure, unchanged)
  combat_ext.ts    damage types, resistances, crit, block, stagger/knockback, burn/HoT
  economy.ts       vendor buy/sell + supply/demand pricing, repair, auction house (24h + escrow)
  social.ts        party (max 5), loot rules, party XP split, 10m proximity chat, 8 emotes
  progression.ts   XP curve, talent points, 3x5 skill tree, respec cost, stat aggregation
  index.ts         barrel
  *.test.ts        154 node:test assertions

server/src/game/integrated.ts       (GameSession: the composition layer)
client/src/social.ts                (pure client view models)
client/src/panels.ts                (party HUD, emotes, vendor, talents)
```

Nothing in `server/src/game/*` was removed or rewritten: the legacy XP curve,
inventory and melee curve all still work, and the composition reads them.

## Design contract

Every exported function is **pure**: state in, a *new* state object plus a list
of events out.

- No mutation of any argument. Callers thread the returned state forward
  (`const next = resolveHit(a, t, hit);` then reuse `next.state`).
- No clocks: `now` is always an explicit parameter (ms epoch). `expireAuctions(state, now)`
  is a pure sweep, not a timer.
- No RNG except an injected `rand: () => number = Math.random` last parameter, so
  replays and tests are seed-deterministic (`mulberry32(n)` from `@aetherfall/shared`).
- No I/O, no sockets. Integration is therefore trivial: the server tick owns the
  state object and replays `events` as `t:'event'` payloads. Protocol v1 is untouched.

Result shape (most modules):

```ts
{ ok: true, state, events, value } | { ok: false, reason }
```

## Tuning tables

### `combat_ext.ts`

| Constant | Value | Notes |
| --- | --- | --- |
| `DAMAGE_TYPES` | `physical`, `fire`, `holy` | holy is the armour-piercing lane |
| `CRIT_CHANCE` / `CRIT_MULTIPLIER` | 5% / x2 | rolled after resistance |
| `BLOCK_REDUCTION` / `BLOCK_COOLDOWN_MS` | 30% / 200 ms | per-target internal cooldown |
| `STAGGER_MS` | 1200 ms | target cannot swing or block |
| `STAGGER_HP_FRACTION` | 0.25 | a hit >= 25% max HP staggers outright |
| `POISE_MAX` / `POISE_DAMAGE_PER_HP` / `POISE_REGEN_PER_SEC` | 100 / 1 / 10 | poise route to stagger |
| `KNOCKBACK_UNITS` / `KNOCKBACK_MS` | 1.8 / 220 ms | caller lerps + resolves walls |
| `BURN_DAMAGE_PER_TICK` / `BURN_TICK_MS` / `BURN_DURATION_MS` | 6 / 1000 / 4000 | 4 ticks, 24 dmg total |
| `HOT_HEAL_PER_TICK` / `HOT_TICK_MS` / `HOT_DURATION_MS` | 8 / 1000 / 5000 | never overheals, never revives |

Damage pipeline (fixed order, `resolveHit`):

```
dead? -> resistance -> crit -> block -> apply -> stagger -> knockback -> death
```

Mob resistances (fraction reduced; negative = vulnerable, capped at +50%):

| Mob | physical | fire | holy |
| --- | --- | --- | --- |
| gloomfang | 0.10 | 0 | -0.10 |
| mistwisp | 0.25 | 0.25 | 0 |
| thornback | 0.30 | -0.10 | 0 |
| meadow-sprite | 0 | 0.40 | -0.15 |
| ashcrawler | 0.20 | 0.30 | 0 |
| hollow-knight | 0.35 | 0 | 0.15 |
| cinder-imp | 0.10 | 0.50 | -0.20 |
| caldera-wyrm | 0.15 | 0.45 | -0.25 |
| void-wisp | -0.10 | 0.20 | 0.35 |
| magma-golem | 0.25 | 0.60 | -0.30 |
| ember-wyrm | 0.20 | 0.50 | 0.10 |
| crypt-warden | 0.30 | -0.20 | 0.40 |

Events: `damage`, `immune`, `block`, `stagger`, `knockback`, `dot-apply`,
`dot-tick`, `hot-tick`, `death`.

### `economy.ts`

| Constant | Value | Notes |
| --- | --- | --- |
| `VENDOR_BUY_MARGIN` / `VENDOR_SELL_MARGIN` | +15% (ceil) / -35% (floor) | permanent spread sink |
| `PRICE_ELASTICITY` | 0.30 | price mult swing per unit of pressure |
| `PRICE_PRESSURE_DAMPING` | 0.5 | `0.5 * log2((buyQty+1)/(sellQty+1))` |
| `PRICE_MIN_MULT` / `PRICE_MAX_MULT` | 0.50 / 2.50 | hard clamps vs base price |
| `PRICE_HISTORY_WINDOW` / `PRICE_HISTORY_TTL_MS` | 20 trades / 7 days | newest 20 inside 7 days |
| `REPAIR_COST_PER_POINT` / `REPAIR_FLAT_FEE` | 1 / 5 | per missing durability point |
| `REPAIR_FULL_FACTOR` | 0.60 | a full repair never exceeds 60% of base |
| `AUCTION_DURATION_MS` | 86,400,000 (24 h) | listing expiry |
| `AUCTION_LISTING_FEE_PCT` | 2% | non-refundable, refunded only on cancel |
| `AUCTION_SOLD_FEE_PCT` | 5% | house cut on the winning bid |
| `AUCTION_ESCROW_FEE_PCT` | 1% | buyer-side escrow fee |
| `AUCTION_MIN_BID_INCREMENT_PCT` | +5% | `minNextBid()` |

Two price signals, deliberately different:

| Signal | Formula | Range | Used by |
| --- | --- | --- | --- |
| `supplyDemandIndex` | `(buyQty - sellQty) / (buyQty + sellQty)` | `[-1, 1]` | analytics / UI |
| `pricePressure` | `0.5 * log2((buyQty+1) / (sellQty+1))` | unbounded | `dynamicUnitPrice()` |

Auction states: `active -> sold | expired | cancelled`. Goods sit in escrow
(`Escrow { gold, items, ownerId, released }`) from `listAuction` until the
listing resolves; a listing can only exist once its goods are escrowed, so a
player can never list and also use the same item.

| Action | Success | Rejections |
| --- | --- | --- |
| `listAuction` | escrows goods, sets `expiresAt = now+24h`, charges 2% | `bad-qty`, `bad-start-price`, `bad-seller`, `insufficient-gold` |
| `bidAuction` | sets `currentBid` + `highestBidderId`, reports `refundTo` | `no-such-auction`, `not-active`, `expired`, `self-bid`, `bid-too-low`, `already-highest`, `insufficient-gold` |
| `buyoutAuction` | moves goods to buyer, credits seller `gross - 5%` | `not-active`, `expired`, `no-buyout`, `self-buy`, `insufficient-gold` |
| `cancelAuction` | seller-only, zero bids, refunds the 2% fee | `not-seller`, `has-bids`, `expired` |
| `expireAuctions` | sweeps every active listing past 24 h, returns goods | (never fails) |
| `repair` | restores to `maxDurability`, charges `repairCost` | `un-repairable`, `full-durability`, `insufficient-gold`, `bad-durability` |

Events: `auction-listed`, `auction-bid`, `auction-outbid`, `auction-buyout`,
`auction-sold`, `auction-expired`, `auction-cancelled`.

### `social.ts`

| Constant | Value | Notes |
| --- | --- | --- |
| `PARTY_MAX` | 5 | hard cap on `joinParty` |
| `PARTY_XP_RADIUS` | 30 m | XP share radius around the killer |
| `PARTY_XP_DEAD_FACTOR` | 0.5 | dead members take half |
| `PARTY_XP_MAX_LEVEL_GAP` | 10 | members >10 levels *below* the killer get none |
| `CHAT_RADIUS` | 10 m | proximity chat + emote baseline |
| `NEARBY_CHAT_MAX_LEN` / `NEARBY_CHAT_RATE_MS` | 200 / 1000 ms | same limits as `game/chat.ts` |

Loot rules (`LOOT_RULES`, leader-only to change):

| Rule | Aliases accepted | Behaviour |
| --- | --- | --- |
| `freeforst` | `ffa`, `freeforall`, `free-for-all`, `free` | every stack rolls, distributed across all members |
| `leader` | — | every stack goes to the party leader |
| `master` | `lootmaster`, `ml` | only `ready` members roll; with nobody ready, drops pend for the master looter |

`freeforst` is the canonical wire spelling (kept stable so the client string
never changes); `normalizeLootRule()` folds the human spellings onto it.

Emotes (exactly 8):

| id | label | duration | radius |
| --- | --- | --- | --- |
| `wave` | Wave | 2000 ms | 10 |
| `cheer` | Cheer | 2000 ms | 12 |
| `bow` | Bow | 2500 ms | 10 |
| `laugh` | Laugh | 2000 ms | 12 |
| `cry` | Cry | 3000 ms | 8 |
| `sit` | Sit | 4000 ms | 6 |
| `point` | Point | 2000 ms | 12 |
| `dance` | Dance | 4000 ms | 14 |

Party XP split is exact: weights are 10 units (5 for dead members), the integer
remainder is handed to the lowest player ids, so `sum(awards) === totalXp`
always. The killer is always eligible for their own kill.

Events: `party-created`, `party-joined`, `party-left`, `party-kicked`,
`party-leader-changed`, `party-loot-rule`, `party-disbanded`, `party-ready`,
`party-member-update`, `party-chat`, `nearby-chat`, `emote`.

### `progression.ts`

| Constant | Value |
| --- | --- |
| `MAX_LEVEL` | 60 |
| `xpToNextLevel(L)` | `50 * L * (L + 1)` |
| `talentPointsForLevel(L)` | `L + floor(L / 5)` (bonus point every 5th level) |
| `respecCost(L, n)` | `100 * L^2 * 1.5^n` gold, refunds **every** spent point |
| `STAT_MIN` / `STAT_MAX` | 0 / 999 (post-aggregation clamp) |

XP curve checkpoints:

| Level | XP to next | Cumulative | Talent points | Respec |
| --- | --- | --- | --- | --- |
| 1 | 100 | 0 | 1 | 100 |
| 2 | 300 | 100 | 2 | 400 |
| 5 | 1,500 | 2,000 | 6 | 2,500 |
| 10 | 5,500 | 16,500 | 12 | 10,000 |
| 20 | 21,000 | 133,000 | 24 | 40,000 |
| 30 | 46,500 | 449,500 | 36 | 90,000 |
| 40 | 82,000 | 1,066,000 | 48 | 160,000 |
| 50 | 127,500 | 2,082,500 | 60 | 250,000 |
| 60 | 183,000 | 3,599,000 | 72 | 360,000 |

Skill tree — 3 branches, 5 tiers each, tier N+1 gated on tier N (tiers 4 and 5
need the previous tier at **rank 2**):

| id | branch | tier | name | maxRank | cost/rank | requires | per-rank effect |
| --- | --- | --- | --- | --- | --- | --- | --- |
| might-1 | might | 1 | Braced Stance | 3 | 1 | — | +2 might, +10 maxHp |
| might-2 | might | 2 | Iron Skin | 3 | 1 | might-1:1 | +8 maxHp, +0.2 hpRegen |
| might-3 | might | 3 | Shield Wall | 3 | 1 | might-2:1 | +0.05 blockChance |
| might-4 | might | 4 | Bonebreaker | 3 | 1 | might-3:2 | +3 attackPower |
| might-5 | might | 5 | Aegis Ascendant | 1 | 2 | might-4:2 | +0.10 blockReduction, +15 maxHp |
| guile-1 | guile | 1 | Light Step | 3 | 1 | — | +2 guile, +0.1 moveSpeed |
| guile-2 | guile | 2 | Keen Eye | 3 | 1 | guile-1:1 | +0.02 critChance |
| guile-3 | guile | 3 | Duelist | 3 | 1 | guile-2:1 | +0.03 attackSpeed, +2 attackPower |
| guile-4 | guile | 4 | Executioner | 3 | 1 | guile-3:2 | +0.15 critMultiplier |
| guile-5 | guile | 5 | Ghostblade | 1 | 2 | guile-4:2 | +0.06 critChance, +0.2 moveSpeed |
| will-1 | will | 1 | Inner Light | 3 | 1 | — | +2 will, +10 maxMp |
| will-2 | will | 2 | Deep Well | 3 | 1 | will-1:1 | +8 maxMp, +0.2 mpRegen |
| will-3 | will | 3 | Warded Mind | 3 | 1 | will-2:1 | +3 spellPower |
| will-4 | will | 4 | Sustenance | 3 | 1 | will-3:2 | +2 hpRegen, +10 maxHp |
| will-5 | will | 5 | Archon | 1 | 2 | will-4:2 | +8 spellPower, +0.5 mpRegen |

Stat aggregation: `base + perLevel * (level - 1) + talents + items`, then clamp
`[0, 999]` and round (4 decimals on fractional stats). Weapons map
`WeaponDef.damage -> attackPower` via `statsForItem()`; other item kinds
contribute nothing passively. Masks ride the same call as `EquippedItem`s and
vocations swap the `perLevel` curve (see below). Clamped so crit/block chance
and block reduction can never leave `[0, 1]` for any legal build.

### Vocations (4 original callings)

Opt-in and in-memory only (`/vocation <id>`; a reconnect starts unsworn).
Each calling sets a per-level growth curve (used *instead of*
`PER_LEVEL_STATS`, every curve non-negative so aggregation stays monotonic),
a starting weapon + mask (granted once), one signature active on a shared
12 s cooldown (`SIGNATURE_COOLDOWN_MS`, fired from the `input.skill` slot),
and a favored talent branch whose every-5th rank is free (20% off).

| id | name | role | curve/level (highlights) | kit | favors | signature (12s) |
| -- | ---- | ---- | ------------------------ | --- | ------ | --------------- |
| dawnwarden | Dawnwarden | melee tank | +18 maxHp, +3 might, +0.004 block | ward-blade + cinder-hide | might | Oath of Embers — heal 25 |
| galehunter | Galehunter | ranged skirmisher | +2 attackPower, +3 guile, +0.02 moveSpeed | wisp-touched-dagger + gallow-beak | guile | Skyhook Volley — 6.5u strike +6 |
| pyrecantor | Pyrecantor | fire caster | +2 spellPower, +3 will, +9 maxMp | ward-blade + vesper-plume | will | Pyre Canticle — strike +10 |
| vesperal | Vesperal | holy support | +1 spellPower, +3 will, +0.15 regen | wisp-touched-dagger + halo-rind | will | Vesper Benediction — heal 40 |

## Integration

Through the integration work, `systems/*` is now composed
into the running server through one new module,
**`server/src/game/integrated.ts`**, which owns all cross-module state and turns
the pure functions into a per-tick pipeline. Nothing in `game/*` was gutted: the
legacy XP curve, the legacy inventory and the legacy melee curve all still work,
and the composition reads them rather than replacing them.

```
server/src/game/integrated.ts        GameSession: progression + party + wallet +
                                     vendor price history + emotes -> protocol v1
server/src/game/integrated.test.ts   82 assertions, 10 suites
client/src/social.ts                 pure view models fed by `event` payloads
client/src/social.test.ts            51 assertions
client/src/panels.ts                 party HUD · emote bubbles · vendor · talents
client/src/panels.test.ts            34 assertions (headless DOM)
```

### Feature flag

| `SYSTEMS` | Behaviour |
| --- | --- |
| unset | **on** (default) |
| `1` / `true` / `yes` / `on` | on |
| `0` / `false` / `no` / `off` | off — legacy XP / inventory / chat path, verbatim |
| unrecognised | falls back to the default (on) |

The flag is **on by default** because `systems/*.test.ts` (154) and
`game/integrated.test.ts` (82) both gate this module and are green. `SYSTEMS=0`
is a complete fallback, not a degraded one: the composed session is skipped
entirely and every pre-existing code path resumes unchanged. The server prints
its state on boot (`... systems=on` / `systems=off`) so a shard's mode is never
in doubt.

### What is composed

| Feature | Systems function | Wire effect |
| --- | --- | --- |
| XP curve | `addXp` + `xpToNextLevel` | private `xp-gain` (`xpLeft`, `next`) |
| Talent points | `talentPointsForLevel` on every level-up | `levelup` now carries `talentPointsGained` + `talentPoints` |
| Talent spend | `learnNode`, `respec` | `talent-learned` / `talent-denied` / `respec` |
| Stat aggregation | `aggregateStats` | `progression` snapshot (`stats`, `meleeDamage`, `power`) |
| Melee damage | aggregated `attackPower` | the swing's damage number; `maxHp` mirrored onto the sim player |
| Party | `createParty` / `joinParty` / `leaveParty` / `kickParty` / `promoteLeader` / `setLootRule` / `setReady` | private `party` snapshots |
| Party XP | `splitPartyXp` | one `xp-gain` per eligible member |
| Proximity chat | `nearbyChat` (10 m) | `{t:'chat'}` to just the listeners |
| Emotes | `playEmote` (per-emote radius) | `emote` to just the listeners, `emote-end` on expiry |
| Vendor | `vendorBuy` / `vendorSell` / `vendorBuyPrice` / `vendorSellPrice` | `vendor-trade`, `gold`, `inventory`, `vendor-stock` |
| Masks | `maskEquippedItem` + perk helpers (`game/masks.ts`) | `mask-equipped` / `mask-unequipped`, perk-aware `meleeDamage`, `wall-ping` 1/s |
| Vocations | `VOCATIONS`, `talentRankCost`, `signatureReady` | `vocation`, discounted `talent-learned`, `signature` / `signature-denied` |

**One XP authority.** With the flag on, `absorbLegacyXp` in `server/src/index.ts`
intercepts the legacy `xp-gain` / `levelup` events and re-grants them through
`GameSession.awardXp`. Without that, two curves (`level * 100` and
`50 * L * (L + 1)`) would race on the same HUD bar. Quest rewards (`rewardXp`)
are forwarded *and* re-granted, so the client still sees the chain event.

**Melee TTK is unchanged.** `aggregateStats` folds `+1 attackPower` per level in,
which is a gentler slope than the legacy `+3`. `GameSession.meleeDamage`
subtracts the per-level part and adds the legacy `+3` slope back, so with no
talents and no weapon the damage number is byte-identical to
`combat.damageFor(level)` — docs/WORLD.md's TTK table stays valid. Talents and
weapons then land on top as a strict increase.

**Commands are not chat-throttled.** Slash commands bypass the legacy 1 msg/sec
chat limiter and carry their own guards instead: `CMD_RATE_MS` (250) per command
burst and `INVITE_COOLDOWN_MS` (2000) per inviter. Otherwise `/buy` twice in a
row would be swallowed.

### Event kinds added

All additive protocol v1 `t:'event'` frames; the pre-existing client ignores
kinds it does not know, so this is safe to ship server-first.

| `kind` | Recipients | Payload |
| --- | --- | --- |
| `progression` | private | level, xp, xpNeeded, talentPoints, talents, stats, meleeDamage, power, gold, maskId, maskBonus, vocation |
| `talent-tree` | private | the 15 nodes + branch order + vocation/mask choice catalogs (sent once on join) |
| `talent-learned` / `talent-denied` | private | nodeId, rank, remainingPoints / reason |
| `respec` | private | cost, refundedPoints, clearedNodes |
| `party` | private, per member | roster with hp / maxHp / level / dead / ready / leader |
| `party-invite` | private | fromId, fromName, partyId, expiresAt |
| `emote` | listeners in radius | seq, fromId, emote, label, x, y, radius, expiresAt |
| `emote-end` | private | seq, fromId, emote |
| `vendor-stock` | private | 23 rows (10 + 5 + 8 masks) with dynamic buy / sell / demand index |
| `vendor-trade` | private | side, itemId, qty, unitPrice, total, gold, ok, reason |
| `mask-equipped` / `mask-unequipped` | private | maskId, perk, glyph (+ replaced) |
| `vocation` | private | vocation, name, role, favoredBranch, signature |
| `signature` / `signature-denied` | private | signature, name, effect / retryMs |
| `wall-ping` | private | maskId, x, y, at (at most 1/s while the plume is worn) |
| `gold` / `inventory` | private | wallet / 20 slots + equipped list |
| `sys-msg` | private | one line of command feedback |

### Chat-command reference

Commands work on any channel and are answered with `sys-msg` lines in the chat
log. `/help` returns exactly this list.

| Command | Effect |
| --- | --- |
| `/invite <name>` | invite a player; forms a party if you have none (alias `/inv`) |
| `/accept` | accept the newest pending invite (alias `/join`) |
| `/decline` | drop the pending invite |
| `/party` | roster with HP, level, leader marks and the loot rule |
| `/party leave` | leave; leadership passes to the lowest remaining id (alias `/leave`, `/quit`) |
| `/party kick <name>` | leader only (alias `/kick`) |
| `/party promote <name>` | leader only (alias `/promote`) |
| `/party loot <rule>` | leader only; `ffa` \| `leader` \| `master` (aliases `/loot`, `ml`, `lootmaster`) |
| `/party ready` | toggle your loot readiness |
| `/p <text>` | party chat (aliases `/partychat`, `/pc`) |
| `/emote <id>` | one of `wave cheer bow laugh cry sit point dance` (alias `/em`) |
| `/shop` | vendor stock with live prices (aliases `/vendor`, `/store`) |
| `/buy <itemId> [qty]` | buy 1..999; gated on gold, bag space and `levelReq` |
| `/sell <itemId> [qty]` | sell 1..999; gated on bag contents |
| `/equip <itemId>` | equip a carried weapon; its `damage` feeds `attackPower` |
| `/unequip <itemId>` | unequip |
| `/talents` | the 3x5 tree with your ranks and locks (alias `/tree`) |
| `/talent <nodeId>` | spend points on one rank (alias `/spend`) |
| `/respec` | wipe every talent, refund all points, charged `100 * level^2` |
| `/stats` | the aggregated stat block |
| `/mask` | list the 8 masks · `/mask equip <id>` · `/mask unequip` (one slot) |
| `/vocation` | list the callings · `/vocation <id>` (starting kit + favored branch 20% off) |
| `/sig` | signature status (fire it from skill slot 1; 12s cooldown) |
| `/help` | this list (aliases `/?`, `/commands`) |

Plain text on the `say` channel is 10 m proximity chat. `global` and `guild` are
unchanged and stay shard-/cross-shard-wide. Chat is still profanity-masked
(`game/chat.ts`) and capped at 200 characters.

### Client panels

Additive only — each panel owns its own root element and stylesheet, mounts into
the existing `#hud` / `#labels`, and re-renders only when its store's `revision`
moves, so a 10 Hz snapshot stream costs zero DOM work here.

| Panel | Shows |
| --- | --- |
| Party HUD | one row per member: name, leader star, readiness, live HP bar, dead strikethrough; loot rule and `n/m` in the footer; the pending-invite banner names `/accept` |
| Emote bubbles | a glyph above the player in `#labels`, positioned through the active renderer's projection, expiring on the server's `expiresAt` |
| Vendor panel | name, bag count, live buy price with a supply/demand arrow, sell price, wallet total; mask rows wear their glyph; rejected rows are dimmed with the reason on hover |
| Talent tree | 3 branch columns, 5 tiers each, rank `n/max`, prerequisite or points shortfall spelled out; click spends via `/talent`, locked and maxed nodes are not clickable; calling + mask pickers on top (click sends `/vocation` / `/mask equip`) |
| Avatar overlay | worn-mask glyph above the avatar (glyph nametag in 3D, canvas glyph in 2D) + class-coloured base disc from the active a11y palette; tracked per player from `mask-equipped` / `vocation` / `progression` events |

### Integration sketch (server tick)

```ts
// one-time
const session = createGameSession({ enabled: systemsEnabledFromEnv() });

// per tick: sync the authoritative view, then drain the pipeline
const out = tickIntegrated(session, Date.now(), playerViews);
for (const o of out) {
  if (o.type === 'chat') sendToMany(o.recipients, { t: 'chat', ...o });
  else if (o.recipients) sendToMany(o.recipients, { t: 'event', kind: o.kind, payload: o.payload });
  else broadcast({ t: 'event', kind: o.kind, payload: o.payload });
}
```

Nothing in `systems/*` mutates the caller's inputs, so any integration order is
safe. `GameSession` is the only mutable state holder.

## Tests

`server/src/systems/*.test.ts` — 154 `node:test` assertions across 25 suites
(the pure layer, unchanged by the integration):

| Suite file | Covers |
| --- | --- |
| `combat_ext.test.ts` | resistance/immunity/clamping, crit RNG + x2, block %/cd/stagger interaction, poise + big-hit stagger, knockback axis and overlap, death once, burn (resist/expiry/catch-up/kill), regen (overheal/no-revive), roster batching |
| `economy.test.ts` | history window/TTL/sort, index vs pressure, 50-250% clamps, spread never inverts, buy/sell rejections, spread sink, repair caps + reasons, auction escrow/24h expiry/bid escalation/buyout cut/cancel/expire, no double-release |
| `social.test.ts` | party cap + leader gating, level-gap join, leave/promote/kick/disband, loot rules + master readiness, XP split exactness/radius/dead/gap, 10m chat + rate limit, 8 emotes + expiry |
| `progression.test.ts` | curve monotonicity, multi-level XP, MAX_LEVEL, talent point grant, tree structure validation, prereqs, rank caps, apex cost, respec cost/refund, stat aggregation + clamps |
| `vocations.test.ts` | 4 callings, monotonic curves, 20%-off discount end to end, 12s signature cooldown, starting-kit validity |
| `game/masks.test.ts` | 8 defs (one perk each), all perks on/off over equip/unequip, one-slot replacement, 25%/5% drop odds, vendor buy/sell |

Plus the integration suites — `server/src/game/integrated.test.ts` (82
assertions, 10 suites), `client/src/social.test.ts` (51) and
`client/src/panels.test.ts` (34) — see the Integration section above.

## Follow-ups (not this change)

- Persistence adapters (`toJSON`/`fromJSON`) for `PriceHistory`,
  `AuctionState` and `ProgressionState` — the shapes are already plain data.
  `GameSession` keeps its state in memory only, so a reconnect starts fresh
  (masks, vocations, kits and signature timers included).
- The auction house and `combat_ext`'s burn/HoT/stagger are reachable through
  `GameSession` APIs (`recordMarketTrade`, per-mob resistances) but have no chat
  command or client panel yet. `planLoot` drives the rule `/party loot` sets, but
  drops still spawn as world pickups via `loot.ts`.
- Item durability wiring so `repairCost()` consumes real equipped durability.
- Party invites do not survive a reconnect: `INVITE_TTL_MS` is 30 s and the
  pending invite is session state only.