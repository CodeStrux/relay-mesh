# Design language — non-negotiable visual fingerprint

Every UI, page, component, or stylesheet you produce follows these seven rules exactly.

1. **Type.** Atkinson Hyperlegible for ALL prose — headings, body, buttons, nav. JetBrains Mono for ALL code, numerals, timestamps, IDs, and meta labels. Never system sans as the primary face; never mono body text.

```css
--sans: "Atkinson Hyperlegible", "Segoe UI", system-ui, sans-serif;
--mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
```

2. **Color.** OKLCH only, anchored on emerald hue 152 — do not shift the hue. Never hex colors, never generic gray palettes. Base tokens:

```css
--bg:      oklch(0.985 0.005 148);  /* clean near-white ground */
--surface: oklch(0.998 0.002 148);  /* cards */
--fg:      oklch(0.24 0.03 158);    /* soft forest ink */
--fg-soft: oklch(0.45 0.02 152);    /* secondary text */
--rule:    oklch(0.88 0.012 150);   /* borders, dividers */
--accent:  oklch(0.50 0.14 152);    /* emerald — AA on the ground */
```

3. **One radius: 6px.** `--radius: 6px` on cards, buttons, inputs, badges, code blocks — everything. No pill buttons, no mixed radii, no zero-radius.

4. **One soft shadow, one elevation level.**

```css
--shadow: 0 1px 2px oklch(0.24 0.03 158 / 0.06), 0 8px 24px -12px oklch(0.24 0.03 158 / 0.16);
```

No shadow hierarchies (`sm/md/lg`), no hard offset shadows, no glow. Hierarchy comes from type and space, not elevation.

5. **Eyebrow kickers.** A mono, uppercase, letter-spaced label above each major heading:

```css
.eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--fg-soft); }
```

6. **Tabular figures on every number.** Counts, prices, timestamps, versions, table columns — JetBrains Mono or `font-variant-numeric: tabular-nums`. Numeric columns must align.

7. **Calm ground, generous measure.** Flat background — no gradients, grain, glassmorphism, or texture. Body `line-height: 1.65`; prose capped at 70ch. Light theme is the default, with a dark variant on `[data-theme="dark"]`. Motion ≤200ms and fully disabled under `prefers-reduced-motion: reduce`.

**Copy voice:** plain language, complete sentences, sentence case for headings and buttons ("Create report", not "Create Report"). No marketing voice, no emoji, no exclamation points.
