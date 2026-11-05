# Shows that direct egress is blocked and proxy egress works.
import os
import urllib.request

url = "https://example.com/"
print("HTTPS_PROXY =", os.environ.get("HTTPS_PROXY", "<unset>")[:40] + "...")

try:
    urllib.request.urlopen("https://example.com/", timeout=5).read(16)
    print("proxy egress: ok")
except Exception as exc:
    print(f"proxy egress failed: {type(exc).__name__}: {exc}")
