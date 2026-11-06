# Cost model output

Worker: AWS m7g.4xlarge (16 vCPU, 64 GiB) Linux on-demand, us-east-1 — $0.6528/hr (verified=True).
Shared infrastructure: $0.1431/hr per worker (assumptions, see cost-model.json).

| Tier | Duration | Safe capacity/worker | Cost/min | Cost/session | $0.01/min margin | $0.02/min | $0.05/min |
|---|---:|---:|---:|---:|---:|---:|---:|
| short | 1m | 102 | $0.00013 | $0.0015 | 84.8% | 92.4% | 97.0% |
| standard | 5m | 51 | $0.00026 | $0.0027 | 94.6% | 97.3% | 98.9% |
| extended | 15m | 25 | $0.00053 | $0.0095 | 93.7% | 96.8% | 98.7% |
| long | 30m | 12 | $0.00111 | $0.0353 | 88.2% | 94.1% | 97.6% |

> Safe capacity is bounded by memory *limits* (no overcommit). `tiers.csv` also has the
> scheduler-request capacity, which is higher but allows memory overcommit.
