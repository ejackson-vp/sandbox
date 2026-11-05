# Used by `make demo-timeout`: the guest watchdog must terminate this and return
# an encrypted timeout result.
import time

print("starting a long loop", flush=True)
deadline = time.time() + 300
while time.time() < deadline:
    pass
print("should never be printed")
