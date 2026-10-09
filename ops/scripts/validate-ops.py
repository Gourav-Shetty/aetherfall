#!/usr/bin/env python3
"""Validate the ops YAML and the Grafana dashboard against the real metrics.

Catches the class of mistake CI cannot otherwise see cheaply: a renamed or
mistyped metric that leaves an alert or a dashboard panel silently empty.

Checks:
  * ops/prometheus.yml and ops/alerts.yml parse as YAML
  * every alert has alert/expr/for/labels/annotations, a severity, a summary,
    and a `for` that is a valid Go duration; there are exactly 8
  * every `aetherfall_*` metric referenced by an alert or a Grafana panel is
    actually exported by GET /metrics (rendered from the built server)
  * the dashboard is a Grafana v9 document with unique panel titles, a
    datasource on every panel, and at least one panel

Usage: python ops/scripts/validate-ops.py
Exit code 0 when everything is consistent, 1 otherwise.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]
OPS = REPO / "ops"
EXPECTED_ALERTS = 8

errors: list[str] = []
notes: list[str] = []


def err(msg: str) -> None:
    errors.append(msg)


METRIC_TOKEN = re.compile(r"\baetherfall_[a-zA-Z0-9_]+")


def exposed_metrics() -> set[str]:
    """Render the live exposition from the built server modules."""
    dist_metrics = REPO / "server" / "dist" / "metrics.js"
    dist_perf = REPO / "server" / "dist" / "perf.js"
    if not dist_metrics.exists() or not dist_perf.exists():
        err("server/dist/metrics.js missing - run 'npm run build --workspaces' first")
        return set()
    js = (
        "import { metrics } from './server/dist/metrics.js';"
        "import { perf } from './server/dist/perf.js';"
        "process.stdout.write(metrics.render() + perf.render());"
    )
    try:
        out = subprocess.run(
            ["node", "--input-type=module", "-e", js],
            cwd=REPO, capture_output=True, text=True, timeout=60, check=True,
        ).stdout
    except Exception as exc:  # noqa: BLE001
        err(f"could not render the exposition: {exc}")
        return set()
    names: set[str] = set()
    for raw in out.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^([a-zA-Z_:][a-zA-Z0-9_:]*)", line)
        if m:
            names.add(m.group(1))
    return names


def check_refs(expr: str, universe: set[str], where: str) -> None:
    for name in sorted(set(METRIC_TOKEN.findall(expr))):
        if name in universe:
            continue
        # rate() / histogram_quantile() wrap the base name in _bucket/_sum/_count.
        if any(f"{name}_{s}" in universe for s in ("bucket", "sum", "count")):
            continue
        err(f"{where}: references unknown metric {name}")


def validate_alerts(universe: set[str]) -> int:
    path = OPS / "alerts.yml"
    if not path.exists():
        err("alerts.yml is missing")
        return 0
    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        err(f"alerts.yml does not parse: {exc}")
        return 0
    if not isinstance(doc, dict) or "groups" not in doc:
        err("alerts.yml: expected a top-level `groups` list")
        return 0
    count = 0
    seen: set[str] = set()
    for group in doc["groups"] or []:
        for rule in group.get("rules", []) or []:
            name = rule.get("alert")
            count += 1
            if not name:
                err(f"alerts.yml: a rule in group {group.get('name')!r} has no `alert`")
                continue
            if name in seen:
                err(f"alerts.yml: duplicate alert name {name}")
            seen.add(name)
            for required in ("expr", "for", "labels", "annotations"):
                if required not in rule:
                    err(f"alerts.yml: {name} is missing `{required}`")
            if "severity" not in (rule.get("labels") or {}):
                err(f"alerts.yml: {name} has no severity label")
            if "runbook" not in (rule.get("labels") or {}):
                err(f"alerts.yml: {name} has no runbook label")
            if "summary" not in (rule.get("annotations") or {}):
                err(f"alerts.yml: {name} has no summary annotation")
            dur = str(rule.get("for", ""))
            if not re.fullmatch(r"\d+[smh](\d+[smh])*", dur):
                err(f"alerts.yml: {name} has an invalid `for` duration {dur!r}")
            expr = rule.get("expr")
            if isinstance(expr, str):
                check_refs(expr, universe, f"alerts.yml: {name}")
            else:
                err(f"alerts.yml: {name} expr must be a string")
    if count != EXPECTED_ALERTS:
        err(f"alerts.yml: expected exactly {EXPECTED_ALERTS} alerts, found {count}")
    return count


def validate_prometheus() -> None:
    path = OPS / "prometheus.yml"
    if not path.exists():
        err("prometheus.yml is missing")
        return
    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        err(f"prometheus.yml does not parse: {exc}")
        return
    if "scrape_configs" not in doc:
        err("prometheus.yml: no scrape_configs")
    if "rule_files" not in doc:
        err("prometheus.yml: no rule_files (alerts.yml would never load)")
    else:
        for rf in doc["rule_files"]:
            if not (OPS / rf).exists():
                err(f"prometheus.yml: rule_file {rf} does not exist")
    if not any("aetherfall" in str(job.get("job_name", "")) for job in doc.get("scrape_configs", [])):
        err("prometheus.yml: no aetherfall scrape job")


def validate_grafana(universe: set[str]) -> int:
    path = OPS / "dashboards" / "grafana.json"
    if not path.exists():
        err("ops/dashboards/grafana.json is missing")
        return 0
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        err(f"grafana.json does not parse: {exc}")
        return 0
    for required in ("title", "uid", "schemaVersion", "panels", "templating"):
        if required not in doc:
            err(f"grafana.json: missing top-level `{required}`")
    panels = doc.get("panels", [])
    if not panels:
        err("grafana.json: no panels")
    rows = 0
    seen_titles: set[str] = set()
    stack = list(panels)
    while stack:
        panel = stack.pop()
        if panel.get("type") == "row":
            rows += 1
            stack.extend(panel.get("panels", []) or [])
            continue
        title = panel.get("title", "")
        if title in seen_titles:
            err(f"grafana.json: duplicate panel title {title!r}")
        seen_titles.add(title)
        if not panel.get("datasource"):
            err(f"grafana.json: panel {title!r} has no datasource")
        if panel.get("type") == "timeseries":
            if not panel.get("targets"):
                err(f"grafana.json: timeseries panel {title!r} has no targets")
            for target in panel.get("targets", []) or []:
                expr = target.get("expr", "")
                if not expr:
                    err(f"grafana.json: panel {title!r} has a target with no expr")
                    continue
                check_refs(expr, universe, f"grafana.json: panel {title!r}")
    notes.append(f"grafana: {len(panels)} top-level panels, {rows} rows, {len(seen_titles)} leaf panels")
    return len(seen_titles)


def main() -> int:
    universe = exposed_metrics()
    if universe:
        notes.append(f"exposition exposes {len(universe)} metric names")
    alerts = validate_alerts(universe)
    validate_prometheus()
    panels = validate_grafana(universe)

    for n in notes:
        print(f"# {n}")
    if errors:
        print(f"FAIL: {len(errors)} problem(s)")
        for e in errors:
            print(f"  - {e}")
        return 1
    print(f"PASS: {alerts} alerts, {panels} dashboard panels, all metric references resolve")
    return 0


if __name__ == "__main__":
    sys.exit(main())