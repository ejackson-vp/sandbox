# throwbox site

A dependency-free single page and an agent-readable `llms.txt`. No build step, no
cookies, no analytics. Open it, or serve the directory.

## Live numbers

The page reads public sources at runtime, unauthenticated, both cached in
`localStorage` for 30 minutes:

- the latest release tag, then `docs/perf/latency.json` at that tag, for the hero
  figures and the note under them
- the repo, newest commit on `main`, last workflow run and contributor count,
  for the vitals line above the footer

Neither is required. If JavaScript is off, or GitHub rate limits the visitor,
the values baked into `index.html` stand in.

`docs/perf/latency.json` is the single place the hero numbers come from. Update
it from `docs/performance-cluster.md` before tagging a release; the page picks
up the new figures on the next load, with no deploy.

## Preview locally

```bash
cd site
node serve.mjs
```

Then open <http://127.0.0.1:4173>. `llms.txt` is served at
<http://127.0.0.1:4173/llms.txt>, and `/latency.json` is mapped to
`docs/perf/latency.json` so a local preview shows the file under review. Any
static server works, but without the mapping the page falls back to the copy on
GitHub.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The page: intro, lifecycle, interfaces, pricing, agent handoff, honest scope. |
| `styles.css` | Tokens, light and dark mode, layout, small animations. |
| `main.js` | Copy buttons, scroll reveals, the two live reads. The page works without it. |
| `llms.txt` | Agent instructions: install, run, HTTP flow, limits, error codes, rules. |
| `serve.mjs` | Zero-dependency dev server. Not part of the deploy. |
| `assets/logo-mark.svg` | The bracket mark from `docs/assets/`. |

## Editing

- Copy lives directly in `index.html`. There is no content pipeline.
- Colours and spacing are CSS custom properties at the top of `styles.css`.
- If the API surface changes, update `llms.txt` in the same change. It is the
  part agents read.
- Keep numeric claims tied to a doc. The page points at
  `docs/performance-cluster.md`, `docs/security-guarantees.md` and
  `docs/production-readiness.md` rather than restating everything.
- `main.js` resolves `{origin}` and `{api}` in code blocks and copy buttons.
  `apiBase` is `https://api.<root>` when the page is served from a root domain,
  and falls back to the page origin on localhost, a bare IP or a two-level host.
