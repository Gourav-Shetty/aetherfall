// AETHERFALL AI — behavior trees (selector / sequence / condition / action).
// Pure, dependency-free, testable. NPC tick (npc.ts) builds one BT per
// minion and runs it every AI tick; the blackboard carries perceptions.

export type BTStatus = 'success' | 'failure' | 'running';

/** Shared scratch space for one tick. Conditions read, actions write. */
export class Blackboard {
  private data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  set(key: string, value: unknown): void {
    this.data.set(key, value);
  }
  has(key: string): boolean {
    return this.data.has(key);
  }
  delete(key: string): void {
    this.data.delete(key);
  }
  clear(): void {
    this.data.clear();
  }
}

export interface BTNode {
  readonly name: string;
  tick(bb: Blackboard): BTStatus;
  reset(): void;
}

/** Leaf that runs a function. Return 'running' for multi-tick actions. */
export class ActionNode implements BTNode {
  readonly name: string;
  private fn: (bb: Blackboard) => BTStatus;
  constructor(name: string, fn: (bb: Blackboard) => BTStatus) {
    this.name = name;
    this.fn = fn;
  }
  tick(bb: Blackboard): BTStatus {
    return this.fn(bb);
  }
  reset(): void {}
}

/** Leaf that checks a predicate. Never 'running'. */
export class ConditionNode implements BTNode {
  readonly name: string;
  private pred: (bb: Blackboard) => boolean;
  constructor(name: string, pred: (bb: Blackboard) => boolean) {
    this.name = name;
    this.pred = pred;
  }
  tick(bb: Blackboard): BTStatus {
    return this.pred(bb) ? 'success' : 'failure';
  }
  reset(): void {}
}

/**
 * Ticks children in order. Fails (or keeps running) on the first
 * non-success child; succeeds when all succeed. Resumes a 'running'
 * child instead of restarting (index persists until reset).
 */
export class SequenceNode implements BTNode {
  readonly name: string;
  private children: BTNode[];
  private current = 0;
  constructor(name: string, children: BTNode[]) {
    this.name = name;
    this.children = children;
  }
  tick(bb: Blackboard): BTStatus {
    while (this.current < this.children.length) {
      const s = this.children[this.current].tick(bb);
      if (s === 'failure') {
        this.current = 0;
        return 'failure';
      }
      if (s === 'running') return 'running';
      this.current++;
    }
    this.current = 0;
    return 'success';
  }
  reset(): void {
    this.current = 0;
    for (const c of this.children) c.reset();
  }
}

/**
 * Tries children in order. Returns the first 'success' (or 'running');
 * fails only when every child fails. Resumes a 'running' child.
 */
export class SelectorNode implements BTNode {
  readonly name: string;
  private children: BTNode[];
  private current = 0;
  constructor(name: string, children: BTNode[]) {
    this.name = name;
    this.children = children;
  }
  tick(bb: Blackboard): BTStatus {
    while (this.current < this.children.length) {
      const s = this.children[this.current].tick(bb);
      if (s === 'success') {
        this.current = 0;
        return 'success';
      }
      if (s === 'running') return 'running';
      this.current++;
    }
    this.current = 0;
    return 'failure';
  }
  reset(): void {
    this.current = 0;
    for (const c of this.children) c.reset();
  }
}

/** Runs child, flips success <-> failure ('running' passes through). */
export class InverterNode implements BTNode {
  readonly name: string;
  private child: BTNode;
  constructor(name: string, child: BTNode) {
    this.name = name;
    this.child = child;
  }
  tick(bb: Blackboard): BTStatus {
    const s = this.child.tick(bb);
    if (s === 'running') return 'running';
    return s === 'success' ? 'failure' : 'success';
  }
  reset(): void {
    this.child.reset();
  }
}

// --- factories (concise tree construction) ---

export function action(
  name: string,
  fn: (bb: Blackboard) => BTStatus,
): BTNode {
  return new ActionNode(name, fn);
}

export function condition(
  name: string,
  pred: (bb: Blackboard) => boolean,
): BTNode {
  return new ConditionNode(name, pred);
}

export function sequence(name: string, ...children: BTNode[]): BTNode {
  return new SequenceNode(name, children);
}

export function selector(name: string, ...children: BTNode[]): BTNode {
  return new SelectorNode(name, children);
}

export function inverter(name: string, child: BTNode): BTNode {
  return new InverterNode(name, child);
}
