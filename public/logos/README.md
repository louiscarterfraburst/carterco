# Client / employer logos

Drop logo files here as `logo-1.svg`, `logo-2.svg`, … `logo-7.svg`.

- **Format**: SVG strongly preferred (vector, scales). PNG with transparency works but rename references in `src/app/page.tsx` if you switch.
- **Color**: Doesn't matter — the marquee applies `filter: brightness(0) invert(1)` so every logo renders as cream/white. Stick to monochrome SVGs without gradients for the cleanest result.
- **Height**: ~80–120px source height is fine; CSS scales them to 32px / 40px (mobile / desktop).
- **Width**: Variable. Wider logos take more horizontal space in the marquee — that's intentional.

## Adding / replacing logos

Edit the `logoFiles` array in `src/app/page.tsx`. Each entry is `{ file, sizeClass?, preserveColor? }`:

- `file` — filename in this directory (`logo-foo.svg` or `.png`).
- `sizeClass` (optional) — Tailwind height utility for that logo. Default is `h-8 sm:h-10`. Stacked / square logos usually need `h-14 sm:h-16` or `h-16 sm:h-20` to balance against wordmarks. Goal: equal *visual area* across the row, not equal pixel height.
- `preserveColor` (optional) — by default the marquee applies `filter: brightness(0) invert(1)` so any logo renders as cream/white. Multi-color marks where flattening would destroy detail (e.g. a circular logo with text + silhouette + colored fill) should set `preserveColor: true` to render in original colors.
