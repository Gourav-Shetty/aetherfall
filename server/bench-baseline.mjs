// Baseline bench: simulate the 20Hz tick hot path with N bots (no sockets).
import { Sim } from '@aetherfall/server/dist/sim.js';
import { InterestTracker } from '@aetherfall/server/dist/interest.js';
import { createGameState, ensurePlayer, setPlayerPos, tickGameplay } from '@aetherfall/server/dist/game/index.js';
import { unifiedMobSnapshot } from '@aetherfall/server/dist/game/mobs.js';
import { NPCManager } from '@aetherfall/server/dist/ai/npc.js';

const N = Number(process.argv[2] ?? 300);
const TICKS = Number(process.argv[3] ?? 200);

const sim = new Sim();
const game = createGameState(1337);
const interest = new InterestTracker();
const npcs = new NPCManager();
let rngState = 42;
const rnd = () => (rngState = (rngState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let i = 1; i <= N; i++) {
  const x = rnd() * 100; const y = rnd() * 100;
  sim.addPlayer(i, `bot${i}`, x, y);
  ensurePlayer(game, i, `bot${i}`, x, y);
  sim.setVelocity(i, (rnd() - 0.5) * 8, (rnd() - 0.5) * 8, 1);
}
const dt = 1 / 20;
// warmup: spawn chunks
for (let t = 0; t < 5; t++) {
  sim.step(dt);
  for (const p of sim.players.values()) setPlayerPos(game, p.id, p.x, p.y);
  tickGameplay(game, Date.now());
}
console.log(`mobs alive: ${game.spawner.mobCount()}, npc: ${npcs.npcCount()}`);

const sec = { sim: [], game: [], npc: [], snap: [], str: [] };
const snapEvery = 2;
for (let t = 0; t < TICKS; t++) {
  let a = performance.now();
  sim.step(dt);
  sec.sim.push(performance.now() - a);
  a = performance.now();
  for (const p of sim.players.values()) setPlayerPos(game, p.id, p.x, p.y);
  const evts = tickGameplay(game, Date.now());
  void evts;
  sec.game.push(performance.now() - a);
  if (sim.tick % snapEvery === 0) {
    a = performance.now();
    const views = [...sim.players.values()].map((p) => ({ id: p.id, x: p.x, y: p.y, hp: p.hp }));
    npcs.tick(0.1, views);
    const full = sim.snapshot().concat(unifiedMobSnapshot(game.spawner, npcs));
    sec.npc.push(performance.now() - a);
    a = performance.now();
    let bytes = 0;
    for (const [id] of sim.players) {
      const p = sim.players.get(id);
      const { visible, removed } = interest.update(id, { x: p.x, y: p.y }, full);
      const s = JSON.stringify({ t: 'snapshot', tick: sim.tick, entities: visible, removed });
      bytes += s.length;
    }
    sec.snap.push(performance.now() - a);
    void bytes;
  }
}
const stats = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  return `avg=${avg.toFixed(2)} p50=${s[Math.floor(s.length * 0.5)].toFixed(2)} p95=${s[Math.floor(s.length * 0.95)].toFixed(2)} max=${s[s.length - 1].toFixed(2)}`;
};
console.log(`N=${N} ticks=${TICKS}`);
console.log(`sim     ${stats(sec.sim)}`);
console.log(`game    ${stats(sec.game)}`);
console.log(`npc+snapbuild ${stats(sec.npc)}`);
console.log(`interest+stringify(all players) ${stats(sec.snap)}`);
