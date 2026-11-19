# syndicord artwork

The mark combines a feed signal with a message bubble. It uses teal
(`#0F9D92`), deep ink (`#102A33`), and pale mint (`#F6FCFA`). It is original
project artwork, not a Cloudflare or Discord logo.

| File                 | Use                                                           |
| -------------------- | ------------------------------------------------------------- |
| `syndicord.svg`      | Editable, font-independent mark with a transparent background |
| `syndicord.png`      | Transparent 256 × 256 raster export                           |
| `social-preview.svg` | Editable 1280 × 640 conceptual feed-to-chat artwork           |
| `social-preview.png` | Opaque social preview for repository links                    |

The social artwork is an illustration, not a product screenshot. Its text
uses Arial, with Helvetica and sans-serif fallbacks. Font availability can
change text rendering when exporting the SVG; the committed PNG is the
intended upload image. The mark itself contains no text or external assets
and works on light and dark backgrounds.

## Export

Use an already installed Chromium or Google Chrome browser. From the
repository root, set `CHROMIUM_BIN` to its executable and run:

```sh
CHROMIUM_BIN=chromium node assets/render.mjs
```

The renderer creates an isolated browser profile in the ignored
`.cloudflare/artwork-render/` directory, renders the SVG sources, and writes
only the two PNG exports. It does not install a browser or contact a hosted
service. Browser and system-font versions can affect rasterization; use the
committed PNG files when an exact upload image is needed.

Check the resulting PNG dimensions, transparency, text placement, and
contrast after changing the sources. The social preview is 1280 × 640 pixels
and must remain under 1 MB for GitHub uploads.

The artwork uses the repository's [MIT license](../LICENSE).
