Ad-hoc diagnostics used during the benchmark investigation. Not part of the
scored scenario suite.

- `fault-probe.ts <n>`: creates n sessions, verifies readiness, runs execs, and
  dumps pod status + guest logs for the first failures. This is how the
  node-wide `RLIMIT_NPROC` bug was found.
- `restart-probe.ts`: clean (no-load) restart recovery measurements for the
  controller, relay and API.
