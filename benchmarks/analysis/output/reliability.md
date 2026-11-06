# Reliability

### final-reliability

| Scenario | ok | notes |
|---|---:|---|
| concurrent_create_20 | True | created=20 errors=[] |
| repeated_exec_100 | True | failures=0 p50_first=6.4ms p50_last=5.7ms drift=-0.7128749999992579ms |
| expiry_during_exec | True | pod gone 5.85s after lease start; exec returned |
| controller_restart_under_load | False | recovery 120.29s, exec errors during outage 377, probe after=false |
| relay_restart | False | exec after restart: session_not_usable; session state before destroy: FAILED |
| api_restart_inflight | False | in-flight created=10 errors=0; api back=false; new create=true |
| cancellation | True | cancelled=true, session usable after=true |
| client_disconnect | True | result recovered by request id |
| pod_killed_while_ready | True | state after pod kill: FAILED (waited 60s) |
| orphans | | 0 |
| orphan_check | True | 0 sandbox pod(s) remain |
