# Browser automation

Playwright probe for the stock guest image.

```bash
npx tsx examples/browser-automation/workload.ts
```

Expected result on the stock image: Playwright installs, but Chromium is absent
and launch fails with `Executable doesn't exist`. A dedicated pinned browser
image is required. No pod security controls or browser sandbox flags are
weakened here.
