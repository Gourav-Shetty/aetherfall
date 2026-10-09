// @aetherfall/server — append-only audit log.
// Events: joins, kicks, wall changes, redirects (+ queue). One JSON object
// per line in ./data/audit.log (AUDIT_PATH overrides). Best-effort: never
// throws — audit failure must not break the game loop. Rotates to
// audit.log.1 past AUDIT_MAX_BYTES (default 1MB) on every write.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type AuditEvent =
  | 'join'
  | 'kick'
  | 'wall-change'
  | 'wall-rejected'
  | 'redirect'
  | 'queue';

export type AuditRecord = {
  at: string;
  event: AuditEvent;
  [k: string]: unknown;
};

/** Audit file path: AUDIT_PATH > cwd/data/audit.log. */
export function auditPath(): string {
  if (process.env.AUDIT_PATH) return resolve(process.env.AUDIT_PATH);
  return resolve(process.cwd(), 'data/audit.log');
}

/** Max audit.log bytes before rotateAuditIfNeeded() rotates (default 1MB). */
export const AUDIT_MAX_BYTES = Number(process.env.AUDIT_MAX_BYTES ?? 1_000_000);

/** Append one audit record. Never throws. Returns true when written. */
export function audit(event: AuditEvent, details: Record<string, unknown> = {}): boolean {
  try {
    const path = auditPath();
    mkdirSync(dirname(path), { recursive: true });
    // Rotate on write so the cap is enforced by the module itself: no caller
    // (server loop, cron, sidecar) can forget it and grow an unbounded log.
    rotateAuditIfNeeded();
    const rec: AuditRecord = { at: new Date().toISOString(), event, ...details };
    let line = '';
    try {
      line = JSON.stringify(rec) + '\n';
    } catch {
      line = JSON.stringify({ at: rec.at, event, unserializable: true }) + '\n';
    }
    appendFileSync(path, line, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Rotate the audit log when it exceeds maxBytes: `audit.log` ->
 * `audit.log.1` (overwriting the previous rotation), fresh file created.
 * Returns true when a rotation happened. Never throws. Test stub covers
 * the rotation path without needing a 1MB fixture (pass tiny maxBytes).
 */
export function rotateAuditIfNeeded(maxBytes: number = AUDIT_MAX_BYTES): boolean {
  try {
    const path = auditPath();
    if (!existsSync(path)) return false;
    const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : AUDIT_MAX_BYTES;
    const size = statSync(path).size;
    if (size <= limit) return false;
    const rotated = `${path}.1`;
    try {
      renameSync(path, rotated);
    } catch {
      return false;
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '', 'utf8');
    } catch {
      /* rotated file still holds history */
    }
    return true;
  } catch {
    return false;
  }
}

/** Convenience wrappers so call sites read as intent. */
export const auditJoin = (details: Record<string, unknown> = {}): boolean => audit('join', details);
export const auditKick = (details: Record<string, unknown> = {}): boolean => audit('kick', details);
export const auditWallChange = (details: Record<string, unknown> = {}): boolean => audit('wall-change', details);
export const auditWallRejected = (details: Record<string, unknown> = {}): boolean => audit('wall-rejected', details);
export const auditRedirect = (details: Record<string, unknown> = {}): boolean => audit('redirect', details);
export const auditQueue = (details: Record<string, unknown> = {}): boolean => audit('queue', details);
