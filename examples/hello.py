# A benign sample workload. Runs inside the sandbox as an unprivileged user.
import os
import socket
import sys

print("Hello from the sandbox!")
print(f"user={os.getuid()} cwd={os.getcwd()}")
print(f"hostname={socket.gethostname()}")

# The sandbox has no usable resolver (dnsPolicy=None + black-hole loopback).
try:
    with open("/etc/resolv.conf") as f:
        servers = [l.split()[1] for l in f if l.startswith("nameserver")]
    print(f"dns: nameservers={servers} (no resolver behind them)")
except OSError:
    print("dns: unresolvable")

# No route to the Kubernetes API service either way.
try:
    socket.create_connection(("10.96.0.1", 443), timeout=1).close()
    print("cluster api: reachable (unexpected)")
except Exception as exc:
    print(f"cluster api: blocked ({type(exc).__name__})")

print("py=" + sys.version.split()[0], file=sys.stderr)
