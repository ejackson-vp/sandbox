# Workloads

### final-workloads

- W1 hello: p50 12.7ms, p95 18.8ms, failures 0
- W2 compute (1 session): p50 273.2ms, p95 287.6ms, n=8
- W2 compute (5 concurrent): p50 220.3ms, p95 244.3ms, n=5
- W3 filesystem: upload 9.0ms (0.06 MiB/s), download 8.1ms (0.07 MiB/s), 0.00 MiB
- W4 pip install through proxy: p50 2.94s, n=3, error=None
- W5 reuse exec: p50 6.2ms; fresh session ready+exec p50 1.92s
- W6 expiry: pod gone 2.16s after lease end; state EXPIRED; cancelled=True
