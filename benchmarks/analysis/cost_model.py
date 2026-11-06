#!/usr/bin/env python3
"""Reproducible unit-economics model for the sandbox service.

Inputs live in benchmarks/scenarios/cost-model.json. Every price carries a
`source` and a `verified` flag; the report must not present unverified inputs as
measured facts.

Usage:
  python3 benchmarks/analysis/cost_model.py
  python3 benchmarks/analysis/cost_model.py --config benchmarks/scenarios/cost-model.json
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load(config_path: Path) -> dict:
    return json.loads(config_path.read_text())


def capacity_per_worker(tier: dict, cfg: dict) -> dict:
    worker = cfg["prices"]["worker"]
    sched = cfg["scheduling"]
    headroom = cfg["assumptions"]["headroom"]
    cpu_request_m = max(
        sched["minCpuRequestMillis"], math.floor(tier["cpuMillis"] / sched["cpuRequestDivisor"])
    )
    mem_request_mib = max(
        sched["minMemoryRequestMiB"], math.floor(tier["memoryMiB"] / sched["memoryRequestDivisor"])
    )
    usable_vcpu = worker["vcpu"] * (1 - headroom)
    usable_mib = worker["memoryGiB"] * 1024 * (1 - headroom)
    by_cpu = math.floor(usable_vcpu * 1000 / cpu_request_m)
    by_mem_requests = math.floor(usable_mib / mem_request_mib)
    by_mem_limits = math.floor(usable_mib / tier["memoryMiB"])
    by_pods = cfg["assumptions"]["maxPodsPerNode"]
    by_requests = min(by_cpu, by_mem_requests, by_pods)
    return {
        "cpuRequestMillis": cpu_request_m,
        "memoryRequestMiB": mem_request_mib,
        "capacityByRequests": by_requests,
        "capacityByLimits": min(by_cpu, by_mem_limits, by_pods),
        "bottleneck": "cpu" if by_cpu <= min(by_mem_requests, by_pods) else ("memory" if by_mem_requests <= by_pods else "pods"),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(ROOT / "benchmarks/scenarios/cost-model.json"))
    ap.add_argument("--out", default=str(ROOT / "benchmarks/results/cost-model"))
    args = ap.parse_args()
    cfg = load(Path(args.config))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    worker = cfg["prices"]["worker"]
    worker_hour = worker["usdPerHour"]
    shared_hour = (
        cfg["prices"]["controlPlaneUsdPerHour"]["value"]
        + cfg["prices"]["loadBalancerUsdPerHour"]["value"]
        + cfg["prices"]["observabilityUsdPerNodeMonth"]["value"] / (24 * 30.4)
    )
    hours_per_month = 24 * 30.4
    egress_per_gib = cfg["prices"]["egressUsdPerGb"]["value"]
    payment = cfg["prices"]["paymentUsdPerSession"]["value"]
    provisioning_min = (cfg["assumptions"]["provisioningSeconds"] + cfg["assumptions"]["teardownSeconds"]) / 60
    failure = cfg["assumptions"]["failureRate"]

    rows = []
    for name, tier in cfg["tiers"].items():
        cap = capacity_per_worker(tier, cfg)
        # Conservative: no memory overcommit. Optimistic: scheduler requests only.
        for mode, capacity in (("safe(limits)", cap["capacityByLimits"]), ("requests", cap["capacityByRequests"])):
            cost_per_min = (worker_hour + shared_hour) / (60 * capacity)
            duration_min = tier["durationSeconds"] / 60
            capacity_cost = cost_per_min * (duration_min + provisioning_min) * (1 + failure)
            egress_gib = cfg["assumptions"]["avgEgressMiBPerSession"] / 1024
            variable = egress_gib * egress_per_gib + payment
            total = capacity_cost + variable
            for price in cfg["assumptions"]["pricePerMinuteScenarios"]:
                revenue = price * duration_min
                margin = (revenue - total) / revenue if revenue > 0 else float("nan")
                rows.append(
                    {
                        "tier": name,
                        "capacityMode": mode,
                        "durationMinutes": round(duration_min, 3),
                        "cpuMillis": tier["cpuMillis"],
                        "memoryMiB": tier["memoryMiB"],
                        "sandboxesPerWorker": capacity,
                        "bottleneck": cap["bottleneck"],
                        "costPerSandboxMinuteUsd": round(cost_per_min, 6),
                        "capacityCostPerSessionUsd": round(capacity_cost, 6),
                        "egressAndPaymentUsd": round(variable, 6),
                        "costPerSessionUsd": round(total, 6),
                        "pricePerMinuteUsd": price,
                        "revenuePerSessionUsd": round(revenue, 6),
                        "grossMarginPct": round(margin * 100, 1),
                    }
                )

    # Break-even utilization and monthly gross profit.
    scenarios = []
    peaks = cfg["assumptions"].get("peakConcurrencyScenarios") or [cfg["assumptions"]["peakConcurrency"]]
    for usage in cfg["assumptions"]["usageScenarios"]:
        for peak in peaks:
            for tier_name, tier in cfg["tiers"].items():
                cap = capacity_per_worker(tier, cfg)
                capacity = cap["capacityByLimits"]
                workers = max(1, math.ceil(peak / capacity))
                fixed = workers * (worker_hour + shared_hour) * hours_per_month
                duration_min = tier["durationSeconds"] / 60
                variable = usage * (
                    cfg["assumptions"]["avgEgressMiBPerSession"] / 1024 * egress_per_gib + payment
                )
                for price in cfg["assumptions"]["pricePerMinuteScenarios"]:
                    revenue = usage * price * duration_min
                    profit = revenue - fixed - variable
                    sold_minutes = usage * duration_min
                    capacity_minutes = workers * capacity * 60 * hours_per_month
                    utilization = sold_minutes / capacity_minutes if capacity_minutes else 0
                    break_even_util = (
                        fixed / (price * capacity * 60 * hours_per_month) if price > 0 else float("nan")
                    )
                    scenarios.append(
                        {
                            "usageSessionsPerMonth": usage,
                            "tier": tier_name,
                            "pricePerMinuteUsd": price,
                            "peakConcurrency": peak,
                            "workersProvisioned": workers,
                            "capacityPerWorker": capacity,
                            "fixedCostUsd": round(fixed, 2),
                            "variableCostUsd": round(variable, 2),
                            "revenueUsd": round(revenue, 2),
                            "grossProfitUsd": round(profit, 2),
                            "grossMarginPct": round((profit / revenue) * 100, 1) if revenue else None,
                            "capacityUtilizationPct": round(utilization * 100, 1),
                            "breakEvenUtilizationPctAtThisPrice": round(break_even_util * 100, 1),
                            "capacityFeasible": utilization <= 1.0,
                        }
                    )

    with (out / "tiers.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    with (out / "scenarios.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(scenarios[0].keys()))
        w.writeheader()
        w.writerows(scenarios)

    summary = {
        "inputs": cfg["prices"],
        "assumptions": cfg["assumptions"],
        "workerHourlyUsd": worker_hour,
        "sharedHourlyPerWorkerUsd": round(shared_hour, 4),
        "tiers": rows,
        "scenarios": scenarios,
        "generatedAt": __import__("datetime").datetime.now(__import__("datetime").UTC).isoformat(),
    }
    (out / "model.json").write_text(json.dumps(summary, indent=2))

    # Markdown summary (safe tier only, one price per row).
    lines = [
        "# Cost model output",
        "",
        f"Worker: {worker['name']} — ${worker_hour:.4f}/hr (verified={worker['verified']}).",
        f"Shared infrastructure: ${shared_hour:.4f}/hr per worker (assumptions, see cost-model.json).",
        "",
        "| Tier | Duration | Safe capacity/worker | Cost/min | Cost/session | $0.01/min margin | $0.02/min | $0.05/min |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for tier_name, tier in cfg["tiers"].items():
        cap = capacity_per_worker(tier, cfg)
        safe = next(r for r in rows if r["tier"] == tier_name and r["capacityMode"] == "safe(limits)")
        margins = {r["pricePerMinuteUsd"]: r["grossMarginPct"] for r in rows if r["tier"] == tier_name and r["capacityMode"] == "safe(limits)"}
        lines.append(
            f"| {tier_name} | {tier['durationSeconds']//60}m | {cap['capacityByLimits']} | "
            f"${safe['costPerSandboxMinuteUsd']:.5f} | ${safe['costPerSessionUsd']:.4f} | "
            f"{margins.get(0.01)}% | {margins.get(0.02)}% | {margins.get(0.05)}% |"
        )
    lines += [
        "",
        "> Safe capacity is bounded by memory *limits* (no overcommit). `tiers.csv` also has the",
        "> scheduler-request capacity, which is higher but allows memory overcommit.",
        "",
    ]
    (out / "summary.md").write_text("\n".join(lines))
    print("\n".join(lines))
    print(f"wrote {out}/tiers.csv, scenarios.csv, model.json, summary.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
