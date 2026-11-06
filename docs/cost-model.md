# Unit economics

Model: `benchmarks/analysis/cost_model.py`; inputs: `benchmarks/scenarios/cost-model.json`;
outputs: `benchmarks/results/cost-model/` (`tiers.csv`, `scenarios.csv`, `model.json`).

All numbers below are **modelled**, not billed. Prices marked `verified: true`
were read from the AWS public price list on 2026-11-05; everything else is an
editable assumption and is labelled as such.

## 1. Inputs

| Input | Value | Status |
|---|---|---|
| Worker | AWS m7g.4xlarge, 16 vCPU / 64 GiB, us-east-1 Linux on-demand | **verified**, $0.6528/hr |
| Alternative | AWS c7g.4xlarge, 16 vCPU / 32 GiB | **verified**, $0.58/hr |
| Internet egress | $0.09/GB (first paid tier) | assumption, not re-verified |
| Block storage | $0.08/GB-month (gp3) | assumption, not re-verified (ordinary sessions use memory emptyDir; suspendable sessions use a PVC) |
| Managed control plane | $0.10/hr | assumption |
| Load balancer | $0.0225/hr (base, no LCU) | assumption |
| Observability | $15/node-month | assumption |
| Payment settlement | $0.0005/session | assumption (mock mode: $0) |
| Headroom | 20% | assumption |
| Provisioning + teardown per session | 3.1 s | measured (~2.2 s ready + ~0.6 s teardown + margin) |
| Failure rate | 2% | assumption |
| Average egress per session | 10 MiB | assumption (measured pip install ≈ 6 MiB) |

## 2. Capacity per worker

Kubernetes schedules on requests; the controller sets CPU request = limit/4 and
memory request = limit/4. "Safe" capacity is bounded by memory **limits**
(no overcommit).

| Tier | Duration | CPU / memory request | CPU / memory limit | Safe sessions/worker | Scheduler-request sessions |
|---|---|---:|---:|---:|---:|
| short | 1 min | 125 m / 128 MiB | 500 m / 512 MiB | 102 | 102 |
| standard | 5 min | 250 m / 256 MiB | 1 vCPU / 1 GiB | 51 | 51 |
| extended | 15 min | 500 m / 512 MiB | 2 vCPU / 2 GiB | 25 | 25 |
| long | 30 min | 500 m / 1 GiB | 2 vCPU / 4 GiB | 12 | 12 |

CPU is the binding constraint for the short tier (16 vCPU × 0.8 / 0.125 = 102);
memory limits bind the longer tiers. The `requests` column in `tiers.csv` can be
higher than the safe number and would allow memory overcommit.

## 3. Cost and margin per session

Cost = (worker + shared) per minute of reserved capacity × (lease + 3.1 s) ×
(1 + failure rate) + egress + payment.

| Tier | Cost / sandbox-minute | Cost / session | Margin @ $0.01/min | @ $0.02/min | @ $0.05/min |
|---|---:|---:|---:|---:|---:|
| short (1 min) | $0.00013 | $0.0015 | 84.8% | 92.4% | 97.0% |
| standard (5 min) | $0.00026 | $0.0027 | 94.6% | 97.3% | 98.9% |
| extended (15 min) | $0.00053 | $0.0095 | 93.7% | 96.8% | 98.7% |
| long (30 min) | $0.00111 | $0.0353 | 88.2% | 94.1% | 97.6% |

At $0.01/min the short tier is the weakest because the fixed per-session costs
(payment + egress, ~$0.0014) are 14% of a $0.01 session.

## 4. Break-even depends on peak concurrency, not average usage

Fixed cost is set by the *peak* you must serve; revenue is set by total sessions.
Short-lived sandboxes are bursty, so this is the dominant business risk.

Standard tier, $0.02/min, 5-minute sessions:

| Sessions/month | Peak concurrency | Workers | Revenue | Fixed cost | Gross profit | Utilization |
|---:|---:|---:|---:|---:|---:|---:|
| 10,000 | 10 | 1 | $1,000 | $581 | **+$406** | 2.2% |
| 10,000 | 200 | 4 | $1,000 | $2,323 | **−$1,336** | 0.6% |
| 100,000 | 200 | 4 | $10,000 | $2,323 | +$7,539 | 5.6% |
| 1,000,000 | 10 | 1 | $100,000 | $581 | +$98,040 | 224% (infeasible) |
| 1,000,000 | 200 | 4 | $100,000 | $2,323 | +$96,298 | 56.0% |

The infeasible row is intentional: 1M 5-minute sessions need 5M sandbox-minutes,
which one worker (51 × 60 × 730 = 2.2M minutes) cannot supply. The model flags
`capacityFeasible=false`.

Break-even utilization at $0.02/min and one worker is ~2–10% for the standard
tier depending on peak; at $0.01/min it doubles. In other words, **the margin is
comfortable once the fleet is even lightly utilized, and negative when peak
capacity is over-provisioned for low volume**.

## 5. What is not in the model

- Engineering, support, compliance, abuse handling, sales.
- Payment losses/fraud and on-chain settlement volatility (mock mode is free).
- Idle capacity during demand troughs below the peak assumption.
- Kata/VM overhead (unknown; would reduce sessions per worker and add ~150–300 MiB
  per VM if measured).
- Taxes, currency, region differences, committed-use discounts.

## 6. Interpretation

At the measured resource footprint (≈9 MiB idle anonymous memory per sandbox),
compute is extremely cheap per session. The economics are dominated by:

1. **Peak-to-average ratio** of demand (provisioning for peak),
2. **Per-session fixed costs** (payment + egress) for the 1-minute tier,
3. **How long leases are sold versus used** — the model charges reserved time,
   which is what the infrastructure pays for.

A commercially credible version needs either high session volume per unit of peak
capacity, or a provisioning model that scales to zero faster than node-level
autoscaling (warm pools or a denser runtime) — the latter must be justified by a
measured cold-start problem, which is ~1.5–1.8 s here, not tens of seconds.
