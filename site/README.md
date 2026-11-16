# sandbox site

A dependency-free single page and an agent-readable `llms.txt`. No build step, no
cookies, no analytics. Open it, or serve the directory.

It is published at **<https://throwbox.dev>**. The hosted API it describes is
**<https://api.throwbox.dev>**, a Cloudflare Tunnel to the `api` Service; see
[`deploy/kubernetes/cloudflared/`](../deploy/kubernetes/cloudflared/README.md).

## Preview locally

```bash
cd site
python3 -m http.server 8000
```

Then open <http://localhost:8000>. `llms.txt` is served at
<http://localhost:8000/llms.txt>.

Any static server works. The directory is the site root, so keep `llms.txt` next
to `index.html` if you deploy it.

## Deploy

Cloudflare Pages, connected to this repository:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Build command | *(none)* |
| Build output directory | `site` |
| Environment variables | *(none)* |

There is no build step, so a push to `main` publishes the directory as-is. Enough
for a preview without the dashboard:

```bash
npx wrangler pages deploy site --project-name throwbox
```

That needs a Cloudflare API token on your machine. It is an operator credential,
not a repository secret, and nothing here reads it.

`throwbox.dev` is the Pages project's custom domain; `api.throwbox.dev` is a
proxied CNAME to the tunnel and must **not** point at Pages. No GitHub Actions
workflow deploys this site: a Pages workflow would need either a Cloudflare token
stored as a repository secret or unpinned third-party actions, and the Cloudflare
git integration already does the same job with neither.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The page: intro, lifecycle, interfaces, pricing, agent handoff, honest scope, accepted risks, rules. |
| `styles.css` | Tokens, light and dark mode, layout, small animations. |
| `main.js` | Copy buttons, scroll reveals, optional repo numbers. The page works without it. |
| `llms.txt` | Agent instructions: install, run, HTTP flow, limits, error codes, rules. |
| `assets/logo-mark.svg` | The bracket mark from `docs/assets/`. |

## Editing

- Copy lives directly in `index.html`. There is no content pipeline.
- Colours and spacing are CSS custom properties at the top of `styles.css`.
- If the API surface changes, update `llms.txt` in the same change. It is the
  part agents read.
- Keep numeric claims tied to a doc. The page points at
  `docs/performance-cluster.md`, `docs/security-guarantees.md` and
  `docs/production-readiness.md` rather than restating everything. Every limit on
  the page comes from `deploy/kubernetes/03-config.yaml` or
  `shared/src/protocol/`; every tier figure comes from `shared/src/tiers.ts`.
- **Do not restate prices.** The page links `GET /v1/pricing` instead, because a
  static page cannot stay in step with configuration and a stale price is worse
  than no price.
- Status is **beta**, run by **one operator** in **one region**, on **one
  control-plane node** and **one Postgres primary**. Do not reintroduce "alpha",
  "not a hosted service", or "mock or testnet payments": those were true before
  the public host existed. Every one of those facts has to still be true on the
  day the page goes live; `docs/launch.md` step 4 says so.
- Sessions are **ephemeral**. There is no suspend, no resume and no checkpoint
  endpoint offered on the hosted beta. Checkpoint storage in this repository is
  plaintext, which is why. Do not add copy that sells one.
- Isolation is a **Kata microVM**. The accurate form is: the boundary properties the
  suite tests are verified at the recorded `control`/`guest` digests
  (`docs/isolation-evidence.md`), no escape attempt has been made, and there is no
  hardware root of trust. Do not claim "verified isolation" on its own, and never
  claim hardware attestation, encrypted checkpoints, an SLA or a second region.
  Do not describe the service as attested, confidential or provider-blind.
- The security review is by the author of the code. If the page says the review
  exists, it says who wrote it.
- Money: real USDC on Base, one charge per session through the Coinbase CDP
  facilitator, no accounts and no stored balance, free access by invitation. The
  refund policy matches `controller/src/refunds.ts`: full refund when a session
  never reaches ready or a relay failure ends it; no refund for destroy or
  expiry after ready; queued, not instant.
- The page sets no cookies and runs no analytics. `main.js` makes two optional
  reads from `api.github.com` and `raw.githubusercontent.com` for the release
  latency numbers and the repo vitals; both fail silently and neither sends
  anything about the visitor. Do not add a third.
