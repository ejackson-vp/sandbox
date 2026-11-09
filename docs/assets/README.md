# Assets

Images referenced by the top-level README and the documentation index.

| File | Used by | Regenerate with |
| --- | --- | --- |
| `architecture.svg` | README, `docs/architecture.md` | edit by hand; render with Chrome/Inkscape to check |
| `social-preview.png` | GitHub repository settings (social preview) | `make assets` |
| `demo.gif` | README (optional) | `make demo-gif` (needs a live cluster + [VHS](https://github.com/charmbracelet/vhs)) |

`architecture.svg` carries its own light and dark palettes through a
`prefers-color-scheme` media query, so one file works in both GitHub themes. If
you edit the geometry, keep the two palettes in sync and re-render before
committing:

```bash
make assets          # renders social-preview.png from the SVG
```

`demo.tape` is the source for the terminal recording. It drives `make
demo-session` against a local kind cluster, so the GIF shows a real session
rather than a mock-up. Do not commit a recording made against a modified script.
