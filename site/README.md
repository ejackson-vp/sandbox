# sandbox site

A dependency-free single page and an agent-readable `llms.txt`. No build step, no
cookies, no analytics. Open it, or serve the directory.

It is published at **<https://throwbox.dev>**. The hosted API it describes is
**<https://api.throwbox.dev>**, a Cloudflare Tunnel to the `api` Service; see
[`deploy/kubernetes/cloudflared/`](../../deploy/kubernetes/cloudflared/README.md).

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
| `index.html` | The page: intro, lifecycle, interfaces, pricing, agent handoff, honest scope, rules. |
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
  `docs/production-readiness.md` rather than restating everything.
- **Do not restate prices.** The page links `GET /v1/pricing` instead, because a
  static page cannot stay in step with configuration and a stale price is worse
  than no price.
- Status is **beta**. Do not reintroduce "alpha", "not a hosted service", or
  "mock or testnet payments": those were true before the public host existed.
- Isolation between sessions is **unverified** on the hosted deployment. Do not
  add a sentence that claims it, and do not describe the service as attested,
  confidential, provider-blind, or covered by an SLA.
- The page sets no cookies and runs no analytics. `main.js` makes two optional
  reads from `api.github.com` and `raw.githubusercontent.com` for the release
  latency numbers and the repo vitals; both fail silently and neither sends
  anything about the visitor. Do not add a third.
