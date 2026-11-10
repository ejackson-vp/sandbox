# sandbox site

A dependency-free single page and an agent-readable `llms.txt`. No build step, no
API calls, no cookies, no analytics. Open it, or serve the directory.

## Preview locally

```bash
cd site
python3 -m http.server 8000
```

Then open <http://localhost:8000>. `llms.txt` is served at
<http://localhost:8000/llms.txt>.

Any static server works. The directory is the site root, so keep `llms.txt` next
to `index.html` if you deploy it.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The page: intro, lifecycle, interfaces, pricing, agent handoff, honest scope. |
| `styles.css` | Tokens, light and dark mode, layout, small animations. |
| `main.js` | Copy buttons, scroll reveals, terminal replay. The page works without it. |
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
