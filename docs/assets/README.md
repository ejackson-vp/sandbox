# Assets

Images referenced by the top-level README and the documentation index.

| File | Used by | Regenerate with |
| --- | --- | --- |
| `logo.svg` | README header | edit by hand; render with Chrome/Inkscape to check |
| `logo-mark.svg` | icon/favicon uses | edit by hand |
| `architecture.svg` | README, `docs/architecture.md` | edit by hand; render with Chrome/Inkscape to check |
| `social-preview.png` | GitHub repository settings (social preview) | `make assets` |
| `demo.gif` | README | `make demo-gif` (needs a live cluster + [VHS](https://github.com/charmbracelet/vhs)) |

`logo.svg`, `logo-mark.svg` and `architecture.svg` carry their own light and dark
palettes through a `prefers-color-scheme` media query, so one file works in both
GitHub themes. If you edit the geometry, keep the two palettes in sync and
re-render before committing:

```bash
make assets          # renders social-preview.png from the SVG
```

`demo.tape` is the source for the terminal recording. It runs
`scripts/demo-session.sh`, the same script `make demo-session` invokes, against a
local kind cluster, so the GIF shows a real session rather than a mock-up. Keep
the recording unedited: if a step changes, re-record rather than cutting frames.
