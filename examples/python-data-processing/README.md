# Python data processing

Creates a 5-minute sandbox, uploads 100k deterministic rows, installs pandas
into `/workspace/.deps`, runs grouping/filtering, downloads and verifies both
artifacts.

```bash
npx tsx examples/python-data-processing/workload.ts
npx tsx examples/python-data-processing/reuse.ts   # fresh vs reuse vs suspend
```

Requires `make up` and mock/local configuration. The input is synthetic.
