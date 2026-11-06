# Startup latency

### 2026-11-06T02-09-46-383Z-173ea61

Samples: 3 total, 3 ok, 0 failed. Errors: []

| Stage | n | p50 | p90 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|
| create (payment+entitlement) | 3 | 20.2ms | 55.7ms | 55.7ms | 55.7ms | 55.7ms |
| ready (client observed) | 3 | 1.55s | 2.32s | 2.32s | 2.32s | 2.32s |
| ready (server entitlement→ready) | 3 | 1.32s | 2.21s | 2.21s | 2.21s | 2.21s |
| provision (controller) | 3 | 1.24s | 2.00s | 2.00s | 2.00s | 2.00s |
| pod object created | 0 | n/a | n/a | n/a | n/a | n/a |
| scheduled→guest hello | 0 | n/a | n/a | n/a | n/a | n/a |
| hello→ready (controller tick) | 3 | 131.0ms | 133.0ms | 133.0ms | 133.0ms | 133.0ms |
| ready→client observed | 3 | 230.9ms | 236.3ms | 236.3ms | 236.3ms | 236.3ms |
| first exec | 3 | 9.4ms | 17.2ms | 17.2ms | 17.2ms | 17.2ms |
| destroy (client) | 3 | 518.4ms | 521.9ms | 521.9ms | 521.9ms | 521.9ms |
| pod gone after destroy | 3 | 50.0ms | 56.0ms | 56.0ms | 56.0ms | 56.0ms |

> Sample count is below 20: p99 is not statistically meaningful.

### 2026-11-06T02-10-53-436Z-173ea61

Samples: 2 total, 2 ok, 0 failed. Errors: []

| Stage | n | p50 | p90 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|
| create (payment+entitlement) | 2 | 20.9ms | 58.8ms | 58.8ms | 58.8ms | 58.8ms |
| ready (client observed) | 2 | 1.81s | 2.36s | 2.36s | 2.36s | 2.36s |
| ready (server entitlement→ready) | 2 | 1.67s | 2.27s | 2.27s | 2.27s | 2.27s |
| provision (controller) | 2 | 1.49s | 1.99s | 1.99s | 1.99s | 1.99s |
| pod object created | 2 | 203.1ms | 332.4ms | 332.4ms | 332.4ms | 332.4ms |
| scheduled→guest hello | 2 | 1.28s | 1.77s | 1.77s | 1.77s | 1.77s |
| hello→ready (controller tick) | 2 | 192.0ms | 202.0ms | 202.0ms | 202.0ms | 202.0ms |
| ready→client observed | 2 | 96.2ms | 138.7ms | 138.7ms | 138.7ms | 138.7ms |
| first exec | 2 | 12.8ms | 15.7ms | 15.7ms | 15.7ms | 15.7ms |
| destroy (client) | 2 | 522.9ms | 524.3ms | 524.3ms | 524.3ms | 524.3ms |
| pod gone after destroy | 2 | 59.0ms | 60.0ms | 60.0ms | 60.0ms | 60.0ms |

> Sample count is below 20: p99 is not statistically meaningful.

### baseline-startup-warm-100

Samples: 100 total, 100 ok, 0 failed. Errors: []

| Stage | n | p50 | p90 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|
| create (payment+entitlement) | 100 | 18.1ms | 21.4ms | 21.8ms | 24.1ms | 53.3ms |
| ready (client observed) | 100 | 1.80s | 1.82s | 1.82s | 2.37s | 2.57s |
| ready (server entitlement→ready) | 99 | 1.61s | 1.70s | 1.73s | 2.50s | 2.50s |
| provision (controller) | 99 | 1.49s | 1.50s | 1.50s | 2.24s | 2.24s |
| pod object created | 100 | 161.5ms | 261.6ms | 280.6ms | 291.4ms | 296.8ms |
| scheduled→guest hello | 99 | 1.32s | 1.40s | 1.44s | 2.20s | 2.20s |
| hello→ready (controller tick) | 99 | 139.0ms | 223.0ms | 235.0ms | 249.0ms | 249.0ms |
| ready→client observed | 99 | 153.3ms | 246.4ms | 259.3ms | 265.2ms | 265.2ms |
| first exec | 100 | 10.6ms | 12.6ms | 13.1ms | 14.5ms | 14.7ms |
| destroy (client) | 100 | 518.2ms | 522.8ms | 525.0ms | 591.2ms | 780.2ms |
| pod gone after destroy | 100 | 62.0ms | 80.0ms | 93.0ms | 125.0ms | 138.0ms |

### optimized-startup-warm-100

Samples: 100 total, 100 ok, 0 failed. Errors: []

| Stage | n | p50 | p90 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|
| create (payment+entitlement) | 100 | 18.4ms | 21.3ms | 22.8ms | 37.4ms | 133.3ms |
| ready (client observed) | 100 | 2.10s | 2.12s | 2.12s | 2.13s | 2.14s |
| ready (server entitlement→ready) | 99 | 1.92s | 2.02s | 2.04s | 2.06s | 2.06s |
| provision (controller) | 99 | 1.89s | 1.99s | 2.02s | 2.04s | 2.04s |
| pod object created | 100 | 32.6ms | 36.0ms | 37.4ms | 52.0ms | 162.1ms |
| scheduled→guest hello | 99 | 1.76s | 1.79s | 1.79s | 1.81s | 1.81s |
| hello→ready (controller tick) | 99 | 136.0ms | 221.0ms | 239.0ms | 252.0ms | 252.0ms |
| ready→client observed | 99 | 103.4ms | 188.4ms | 205.9ms | 213.2ms | 213.2ms |
| first exec | 100 | 9.7ms | 11.7ms | 11.9ms | 12.7ms | 14.6ms |
| destroy (client) | 100 | 112.5ms | 114.7ms | 116.1ms | 321.6ms | 323.3ms |
| pod gone after destroy | 100 | 68.0ms | 75.0ms | 76.0ms | 79.0ms | 79.0ms |
