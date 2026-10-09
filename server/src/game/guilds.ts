// @aetherfall/gameplay — guilds: create/join/roles.
// In-memory store; the persistence layer can snapshot via toJSON()/fromJSON().

export type GuildRole = 'leader' | 'officer' | 'member';

export type Guild = {
  id: number;
  name: string;
  createdAt: number;
  members: Map<number, GuildRole>;
};

export type GuildJson = {
  id: number;
  name: string;
  createdAt: number;
  members: [number, GuildRole][];
};

const MAX_NAME = 24;
const MAX_MEMBERS = 50;

export class GuildStore {
  private next = 1;
  private guilds = new Map<number, Guild>();
  private playerGuild = new Map<number, number>(); // playerId -> guildId
  private names = new Set<string>(); // lowercase names for uniqueness

  count(): number {
    return this.guilds.size;
  }

  get(gid: number): Guild | undefined {
    return this.guilds.get(gid);
  }

  guildOf(playerId: number): Guild | undefined {
    const gid = this.playerGuild.get(playerId);
    return gid === undefined ? undefined : this.guilds.get(gid);
  }

  create(name: string, leaderId: number, now = Date.now()): Guild {
    const clean = name.trim().slice(0, MAX_NAME);
    if (clean.length < 3) throw new Error('guild name too short (min 3)');
    if (this.playerGuild.has(leaderId)) throw new Error('already in a guild');
    if (this.names.has(clean.toLowerCase())) throw new Error('guild name taken');
    const g: Guild = {
      id: this.next++,
      name: clean,
      createdAt: now,
      members: new Map([[leaderId, 'leader']]),
    };
    this.guilds.set(g.id, g);
    this.playerGuild.set(leaderId, g.id);
    this.names.add(clean.toLowerCase());
    return g;
  }

  join(gid: number, playerId: number): Guild {
    const g = this.guilds.get(gid);
    if (!g) throw new Error('no such guild');
    if (this.playerGuild.has(playerId)) throw new Error('already in a guild');
    if (g.members.size >= MAX_MEMBERS) throw new Error('guild full');
    g.members.set(playerId, 'member');
    this.playerGuild.set(playerId, gid);
    return g;
  }

  leave(playerId: number): void {
    const gid = this.playerGuild.get(playerId);
    if (gid === undefined) throw new Error('not in a guild');
    const g = this.guilds.get(gid);
    if (!g) {
      this.playerGuild.delete(playerId);
      throw new Error('not in a guild');
    }
    const role = g.members.get(playerId);
    g.members.delete(playerId);
    this.playerGuild.delete(playerId);
    if (role === 'leader') {
      // Promote oldest officer, else oldest member; disband if empty.
      let next: number | null = null;
      for (const [pid, r] of g.members) {
        if (r === 'officer') {
          next = pid;
          break;
        }
        if (next === null) next = pid;
      }
      if (next === null) {
        this.guilds.delete(gid);
        this.names.delete(g.name.toLowerCase());
      } else {
        g.members.set(next, 'leader');
      }
    }
  }

  /** Leader-only role change. Leader cannot demote themselves without leaving. */
  setRole(gid: number, actorId: number, targetId: number, role: GuildRole): void {
    const g = this.guilds.get(gid);
    if (!g) throw new Error('no such guild');
    if (g.members.get(actorId) !== 'leader') throw new Error('only leader can set roles');
    if (!g.members.has(targetId)) throw new Error('target not in guild');
    if (targetId === actorId) throw new Error('leader cannot change own role (leave instead)');
    if (role === 'leader') {
      g.members.set(actorId, 'officer');
      g.members.set(targetId, 'leader');
    } else {
      g.members.set(targetId, role);
    }
  }

  /** Leader-only kick. */
  kick(gid: number, actorId: number, targetId: number): void {
    const g = this.guilds.get(gid);
    if (!g) throw new Error('no such guild');
    if (g.members.get(actorId) !== 'leader') throw new Error('only leader can kick');
    if (targetId === actorId) throw new Error('cannot kick yourself');
    if (!g.members.has(targetId)) throw new Error('target not in guild');
    g.members.delete(targetId);
    this.playerGuild.delete(targetId);
  }

  disband(gid: number, actorId: number): void {
    const g = this.guilds.get(gid);
    if (!g) throw new Error('no such guild');
    if (g.members.get(actorId) !== 'leader') throw new Error('only leader can disband');
    for (const pid of g.members.keys()) this.playerGuild.delete(pid);
    this.guilds.delete(gid);
    this.names.delete(g.name.toLowerCase());
  }

  membersOf(gid: number): [number, GuildRole][] {
    const g = this.guilds.get(gid);
    return g ? [...g.members.entries()] : [];
  }

  toJSON(): GuildJson[] {
    return [...this.guilds.values()].map((g) => ({
      id: g.id,
      name: g.name,
      createdAt: g.createdAt,
      members: [...g.members.entries()],
    }));
  }

  fromJSON(data: GuildJson[]): void {
    this.guilds.clear();
    this.playerGuild.clear();
    this.names.clear();
    let hi = 0;
    for (const j of data) {
      const g: Guild = {
        id: j.id,
        name: j.name,
        createdAt: j.createdAt,
        members: new Map(j.members),
      };
      this.guilds.set(g.id, g);
      this.names.add(g.name.toLowerCase());
      for (const [pid] of g.members) this.playerGuild.set(pid, g.id);
      hi = Math.max(hi, g.id);
    }
    this.next = hi + 1;
  }
}
