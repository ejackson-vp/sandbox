# Density

### baseline-density-cpu

Mode: `cpu`, spec: `{"tier": "custom", "durationSeconds": 240, "cpuMillis": 500, "memoryMiB": 512, "diskMiB": 256}`

| N | ready | failed | anon/sandbox p50 | anon p95 | node mem | CPU % (quiet) | ready p50 | teardown p50 | ops/s | pods left |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 0 | 8.4 MiB | 8.4 MiB | 1143 MiB | 4.8 | 1.34s | 520.9ms | 4.7 | 0 |
| 5 | 5 | 0 | 8.3 MiB | 8.4 MiB | 1202 MiB | 4.3 | 1.52s | 522.6ms | 20.9 | 0 |
| 10 | 10 | 0 | 8.4 MiB | 8.5 MiB | 1286 MiB | 5.5 | 1.41s | 782.1ms | 40.3 | 0 |

### baseline-density-idle

Mode: `idle`, spec: `{"tier": "custom", "durationSeconds": 240, "cpuMillis": 500, "memoryMiB": 512, "diskMiB": 256}`

| N | ready | failed | anon/sandbox p50 | anon p95 | node mem | CPU % (quiet) | ready p50 | teardown p50 | ops/s | pods left |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 0 | 8.4 MiB | 8.4 MiB | 1169 MiB | 3.8 | 2.03s | 518.4ms |  | 0 |
| 5 | 5 | 0 | 8.4 MiB | 8.4 MiB | 1229 MiB | 5.1 | 1.41s | 522.0ms |  | 0 |
| 10 | 10 | 0 | 8.3 MiB | 8.4 MiB | 1291 MiB | 6.2 | 1.49s | 555.1ms |  | 0 |
| 25 | 10 | 15 | 8.3 MiB | 8.5 MiB | 1277 MiB | 3.1 | 2.03s | 521.3ms |  | 0 |

Notes:
- 15 session(s) were not created (rate limit or API error)

### baseline-density-idle-25

Mode: `idle`, spec: `{"tier": "custom", "durationSeconds": 240, "cpuMillis": 500, "memoryMiB": 512, "diskMiB": 256}`

| N | ready | failed | anon/sandbox p50 | anon p95 | node mem | CPU % (quiet) | ready p50 | teardown p50 | ops/s | pods left |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 25 | 15 | 10 | 8.4 MiB | 8.6 MiB | 1370 MiB | 9.9 | 1.69s | 524.5ms |  | 0 |

Notes:
- create error codes: ["rate_limited"]
- 10 session(s) were not created (rate limit or API error)

### baseline-density-idle-50

Mode: `idle`, spec: `{"tier": "custom", "durationSeconds": 240, "cpuMillis": 500, "memoryMiB": 512, "diskMiB": 256}`

| N | ready | failed | anon/sandbox p50 | anon p95 | node mem | CPU % (quiet) | ready p50 | teardown p50 | ops/s | pods left |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 50 | 10 | 40 | 8.3 MiB | 8.4 MiB | 1291 MiB | 7.5 | 2.28s | 521.5ms |  | 0 |

Notes:
- create error codes: ["rate_limited"]
- 40 session(s) were not created (rate limit or API error)

### baseline-density-mixed

Mode: `mixed`, spec: `{"tier": "custom", "durationSeconds": 240, "cpuMillis": 500, "memoryMiB": 512, "diskMiB": 256}`

| N | ready | failed | anon/sandbox p50 | anon p95 | node mem | CPU % (quiet) | ready p50 | teardown p50 | ops/s | pods left |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 0 | 8.5 MiB | 8.5 MiB | 1144 MiB | 4.7 | 1.57s | 521.3ms | 4.5 | 0 |
| 5 | 5 | 0 | 8.4 MiB | 8.6 MiB | 1208 MiB | 6.6 | 1.56s | 518.1ms | 27.1 | 0 |
| 10 | 10 | 0 | 8.4 MiB | 8.5 MiB | 1278 MiB | 3.9 | 1.53s | 779.9ms | 40.8 | 0 |

### baseline-idle-cpu

Mode: `idle`, spec: `{"tier": "custom", "durationSeconds": 240, "cpuMillis": 500, "memoryMiB": 512, "diskMiB": 256}`

| N | ready | failed | anon/sandbox p50 | anon p95 | node mem | CPU % (quiet) | ready p50 | teardown p50 | ops/s | pods left |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 10 | 0 | 8.3 MiB | 8.4 MiB | 1294 MiB | 5.8 | 1.80s | 525.1ms |  | 0 |

### final-density-cpu-25

Mode: `cpu`, spec: `{"tier": "custom", "durationSeconds": 240, "cpuMillis": 500, "memoryMiB": 512, "diskMiB": 256}`

| N | ready | failed | anon/sandbox p50 | anon p95 | node mem | CPU % (quiet) | ready p50 | teardown p50 | ops/s | pods left |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 25 | 25 | 0 | 8.4 MiB | 8.5 MiB | 1520 MiB | 6.6 | 2.45s | 266.0ms | 69.2 | 0 |

### final-density-idle-25

Mode: `idle`, spec: `{"tier": "custom", "durationSeconds": 240, "cpuMillis": 500, "memoryMiB": 512, "diskMiB": 256}`

| N | ready | failed | anon/sandbox p50 | anon p95 | node mem | CPU % (quiet) | ready p50 | teardown p50 | ops/s | pods left |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 25 | 25 | 0 | 8.4 MiB | 8.5 MiB | 1539 MiB | 5.9 | 2.67s | 230.7ms |  | 0 |

### final-density-idle-50

Mode: `idle`, spec: `{"tier": "custom", "durationSeconds": 240, "cpuMillis": 500, "memoryMiB": 512, "diskMiB": 256}`

| N | ready | failed | anon/sandbox p50 | anon p95 | node mem | CPU % (quiet) | ready p50 | teardown p50 | ops/s | pods left |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 50 | 50 | 0 | 8.3 MiB | 8.5 MiB | 1894 MiB | 8.7 | 4.61s | 341.6ms |  | 0 |

### final-density-mixed-25

Mode: `mixed`, spec: `{"tier": "custom", "durationSeconds": 240, "cpuMillis": 500, "memoryMiB": 512, "diskMiB": 256}`

| N | ready | failed | anon/sandbox p50 | anon p95 | node mem | CPU % (quiet) | ready p50 | teardown p50 | ops/s | pods left |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 25 | 25 | 0 | 8.3 MiB | 8.6 MiB | 1531 MiB | 5.1 | 12.44s | 322.6ms | 82.6 | 0 |

### load-density-idle-25

Mode: `idle`, spec: `{"tier": "custom", "durationSeconds": 240, "cpuMillis": 500, "memoryMiB": 512, "diskMiB": 256}`

| N | ready | failed | anon/sandbox p50 | anon p95 | node mem | CPU % (quiet) | ready p50 | teardown p50 | ops/s | pods left |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 25 | 23 | 2 | 8.3 MiB | 8.4 MiB | 1530 MiB | 5.1 | 2.35s | 328.3ms |  | 0 |

Notes:
- 2 session(s) did not become ready

### load-density-mixed-25

Mode: `mixed`, spec: `{"tier": "custom", "durationSeconds": 240, "cpuMillis": 500, "memoryMiB": 512, "diskMiB": 256}`

| N | ready | failed | anon/sandbox p50 | anon p95 | node mem | CPU % (quiet) | ready p50 | teardown p50 | ops/s | pods left |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 25 | 22 | 3 | 8.3 MiB | 8.4 MiB | 1548 MiB | 51.2 | 12.23s | 327.6ms | 21.0 | 0 |

Notes:
- 3 session(s) did not become ready
