#!/usr/bin/env python3
"""Analyze benchmark result directories and emit markdown + CSV.

Stdlib only. Percentiles use nearest-rank, matching the TypeScript harness.

Usage:
  python3 benchmarks/analysis/analyze.py --results benchmarks/results
  python3 benchmarks/analysis/analyze.py --results benchmarks/results --latest
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path
from typing import Any, Iterable


def pct(values: list[float], q: float) -> float | None:
    data = sorted(v for v in values if v is not None and math.isfinite(v))
    if not data:
        return None
    rank = math.ceil(q * len(data)) - 1
    return data[min(len(data) - 1, max(0, rank))]


def summarize(values: Iterable[float | None]) -> dict[str, Any] | None:
    data = sorted(v for v in values if v is not None and math.isfinite(v))
    if not data:
        return None
    mean = sum(data) / len(data)
    var = sum((x - mean) ** 2 for x in data) / (len(data) - 1) if len(data) > 1 else 0.0
    return {
        "count": len(data),
        "min": data[0],
        "mean": mean,
        "p50": pct(data, 0.5),
        "p90": pct(data, 0.9),
        "p95": pct(data, 0.95),
        "p99": pct(data, 0.99),
        "max": data[-1],
        "stdev": math.sqrt(var),
    }


def ms(v: float | None) -> str:
    if v is None:
        return "n/a"
    return f"{v/1000:.2f}s" if v >= 1000 else f"{v:.1f}ms"


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text().splitlines():
        if line.strip():
            out.append(json.loads(line))
    return out


def load_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    return json.loads(path.read_text())


def find_runs(root: Path, latest_only: bool) -> list[Path]:
    runs = sorted([p for p in root.iterdir() if p.is_dir() and (p / "environment.json").exists()])
    return runs[-1:] if latest_only and runs else runs


def startup_section(run: Path) -> str:
    rows = load_jsonl(run / "startup.jsonl")
    if not rows:
        return ""
    ok = [r for r in rows if r.get("ok")]
    fields = {
        "create (payment+entitlement)": lambda r: r.get("createMs"),
        "ready (client observed)": lambda r: r.get("readyObservedMs"),
        "ready (server entitlement→ready)": lambda r: (r.get("derived") or {}).get("serverReadyMs"),
        "provision (controller)": lambda r: (r.get("derived") or {}).get("serverProvisionMs"),
        "pod object created": lambda r: (r.get("stages") or {}).get("podAddedMs"),
        "scheduled→guest hello": lambda r: (
            (r.get("stages") or {}).get("guestHelloMs") - (r.get("stages") or {}).get("scheduledMs")
            if (r.get("stages") or {}).get("guestHelloMs") is not None
            and (r.get("stages") or {}).get("scheduledMs") is not None
            else None
        ),
        "hello→ready (controller tick)": lambda r: (r.get("derived") or {}).get("helloToReadyMs"),
        "ready→client observed": lambda r: (r.get("derived") or {}).get("readyToClientObservedMs"),
        "first exec": lambda r: r.get("firstExecMs"),
        "destroy (client)": lambda r: r.get("destroyMs"),
        "pod gone after destroy": lambda r: r.get("podGoneMs"),
    }
    lines = [
        f"### {run.name}",
        "",
        f"Samples: {len(rows)} total, {len(ok)} ok, {len(rows)-len(ok)} failed. "
        f"Errors: {sorted({r.get('errorCode') for r in rows if not r.get('ok')})}",
        "",
        "| Stage | n | p50 | p90 | p95 | p99 | max |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for name, get in fields.items():
        s = summarize(get(r) for r in ok)
        if not s:
            lines.append(f"| {name} | 0 | n/a | n/a | n/a | n/a | n/a |")
            continue
        lines.append(
            f"| {name} | {s['count']} | {ms(s['p50'])} | {ms(s['p90'])} | {ms(s['p95'])} | {ms(s['p99'])} | {ms(s['max'])} |"
        )
    lines.append("")
    if len(ok) < 20:
        lines.append("> Sample count is below 20: p99 is not statistically meaningful.")
        lines.append("")
    return "\n".join(lines)


def density_section(run: Path) -> str:
    summary = load_json(run / "density.summary.json")
    if not summary:
        return ""
    levels = summary.get("levels", [])
    lines = [
        f"### {run.name}",
        "",
        f"Mode: `{summary.get('mode')}`, spec: `{json.dumps(summary.get('spec'))}`",
        "",
        "| N | ready | failed | anon/sandbox p50 | anon p95 | node mem | CPU % (quiet) | ready p50 | teardown p50 | ops/s | pods left |",
        "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for lv in levels:
        anon = lv.get("anonBytes") or {}
        ready = lv.get("readyMs") or {}
        td = lv.get("teardownMs") or {}
        phase = lv.get("phase") or {}
        lines.append(
            "| {n} | {ready} | {failed} | {a50} | {a95} | {node} | {cpu:.1f} | {r50} | {t50} | {ops} | {pods} |".format(
                n=lv["level"],
                ready=lv["ready"],
                failed=lv["failed"],
                a50=f"{(anon.get('p50') or 0)/1024**2:.1f} MiB",
                a95=f"{(anon.get('p95') or 0)/1024**2:.1f} MiB",
                node=f"{(lv.get('nodeMemBytes') or 0)/1024**2:.0f} MiB",
                cpu=lv.get("nodeCpuPct") or 0,
                r50=ms(ready.get("p50")),
                t50=ms(td.get("p50")),
                ops=f"{phase.get('opsPerSecond'):.1f}" if phase.get("opsPerSecond") else "",
                pods=lv.get("podsAfter"),
            )
        )
    notes = [n for lv in levels for n in lv.get("notes", [])]
    if notes:
        lines += ["", "Notes:"] + [f"- {n}" for n in notes]
    lines.append("")
    return "\n".join(lines)


def workloads_section(run: Path) -> str:
    data = load_json(run / "workloads.summary.json")
    if not data:
        return ""
    lines = [f"### {run.name}", ""]
    w1 = data.get("w1_hello") or {}
    if w1.get("latency"):
        lines.append(f"- W1 hello: p50 {ms(w1['latency']['p50'])}, p95 {ms(w1['latency']['p95'])}, failures {w1.get('failures')}")
    for key, label in [("w2_compute_baseline", "W2 compute (1 session)"), ("w2_compute_concurrent5", "W2 compute (5 concurrent)")]:
        d = (data.get(key) or {}).get("latency")
        if d:
            lines.append(f"- {label}: p50 {ms(d['p50'])}, p95 {ms(d['p95'])}, n={d['count']}")
    w3 = data.get("w3_filesystem") or {}
    if w3:
        lines.append(
            f"- W3 filesystem: upload {ms(w3.get('uploadMs'))} ({w3.get('uploadMiBs', 0):.2f} MiB/s), "
            f"download {ms(w3.get('downloadMs'))} ({w3.get('downloadMiBs', 0):.2f} MiB/s), "
            f"{w3.get('downloadedBytes', 0)/1024**2:.2f} MiB"
        )
    w4 = data.get("w4_pip_install") or {}
    if w4:
        lat = w4.get("latency") or {}
        lines.append(f"- W4 pip install through proxy: p50 {ms(lat.get('p50'))}, n={w4.get('n')}, error={w4.get('error')}")
    w5 = data.get("w5_multi_command") or {}
    if w5:
        lines.append(
            f"- W5 reuse exec: p50 {ms((w5.get('reuseExec') or {}).get('p50'))}; "
            f"fresh session ready+exec p50 {ms((w5.get('freshTotal') or {}).get('p50'))}"
        )
    w6 = data.get("w6_expiry") or {}
    if w6:
        lines.append(
            f"- W6 expiry: pod gone {ms(w6.get('podGoneAfterLeaseMs'))} after lease end; "
            f"state {w6.get('finalState')}; cancelled={w6.get('commandCancelled')}"
        )
    lines.append("")
    return "\n".join(lines)


def reliability_section(run: Path) -> str:
    data = load_json(run / "reliability.summary.json")
    if not data:
        return ""
    lines = [f"### {run.name}", "", "| Scenario | ok | notes |", "|---|---:|---|"]
    for name, row in data.items():
        if isinstance(row, dict):
            lines.append(f"| {name} | {row.get('ok')} | {row.get('notes','')} |")
        else:
            lines.append(f"| {name} | | {row} |")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", default="benchmarks/results")
    ap.add_argument("--out", default="benchmarks/analysis/output")
    ap.add_argument("--latest", action="store_true", help="only the newest run per scenario")
    args = ap.parse_args()

    root = Path(args.results)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    runs = find_runs(root, args.latest)
    if not runs:
        print(f"no runs found in {root}")
        return 1

    startup = [s for s in (startup_section(r) for r in runs) if s]
    density = [s for s in (density_section(r) for r in runs) if s]
    workloads = [s for s in (workloads_section(r) for r in runs) if s]
    reliability = [s for s in (reliability_section(r) for r in runs) if s]

    (out / "startup.md").write_text("# Startup latency\n\n" + "\n".join(startup))
    (out / "density.md").write_text("# Density\n\n" + "\n".join(density))
    (out / "workloads.md").write_text("# Workloads\n\n" + "\n".join(workloads))
    (out / "reliability.md").write_text("# Reliability\n\n" + "\n".join(reliability))

    # Machine-readable aggregate of the newest run of each scenario.
    aggregate: dict[str, Any] = {"runs": [r.name for r in runs]}
    for r in runs:
        for name in ("startup", "density", "workloads", "reliability"):
            summary = load_json(r / f"{name}.summary.json")
            if summary:
                aggregate[name] = summary
    (out / "summary.json").write_text(json.dumps(aggregate, indent=2, default=str))

    print(f"analyzed {len(runs)} run(s) -> {out}")
    for name in ("startup", "density", "workloads", "reliability"):
        text = (out / f"{name}.md").read_text()
        print(f"  {name}.md ({len(text.splitlines())} lines)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
