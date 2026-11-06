"""Deterministic, bounded CPU workload used to compare scheduling effects."""
import time

start = time.perf_counter()
total = 0
for i in range(2_000_000):
    total = (total + i * i) % 1_000_000_007
elapsed_ms = (time.perf_counter() - start) * 1000
print(f"checksum={total} compute_ms={elapsed_ms:.1f}")
