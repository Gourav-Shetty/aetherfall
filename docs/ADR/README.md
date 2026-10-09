# Architecture Decision Records

Short, numbered, dated. One file per decision. Each record is written once and
amended by writing a *new* record plus a note in the old one — records are not
rewritten to look prescient.

**Format** (identical in all five):

```markdown
# ADR-NNNN: <decision as a sentence>

- Status: accepted | superseded by ADR-NNNN
- Date: YYYY-MM-DD
- Context: <the forces in play, with numbers where numbers exist>

## Decision

## Alternatives considered

## Consequences
```

| # | Decision | Status |
|---|---|---|
| [0001](0001-authoritative-vs-p2p.md) | Authoritative server vs peer-to-peer | accepted |
| [0002](0002-sqlite-dev-postgres-prod.md) | SQLite for dev, Postgres-ready schema for prod | accepted |
| [0003](0003-interest-radius-40m.md) | Interest radius 40m | accepted |
| [0004](0004-binary-protocol-v2.md) | Binary protocol v2 negotiated over the v1 JSON handshake | accepted |
| [0005](0005-pure-systems-layer.md) | Gameplay systems as pure functions, integrated by a thin adapter | accepted |

Two decisions are worth reading before the rest, because most of the repo is a
consequence of them:

- **0001** fixes the trust model: clients send intents, the server owns state.
  That is why anti-cheat is three cheap checks instead of a distributed
  anti-tamper scheme, and why replays are just recorded snapshots.
- **0005** fixes how rules are written: pure state-in/state-out functions behind
  a thin adapter, so the 20Hz loop stays readable and every rule is testable
  without doubles.

Measured consequences of these choices live in [`../BENCHMARKS.md`](../BENCHMARKS.md);
the implementation deep-dive is in [`../ARCHITECTURE.md`](../ARCHITECTURE.md).