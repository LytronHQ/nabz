# nabz — Design System ("Blueprint")

The finalized visual identity for nabz. Implement it as a **central, token-driven
design system** — define the tokens once, and have every page/component inherit them. Do
NOT hardcode colors, spacing, or fonts per-page. Both **light and dark** themes flow from
the same token names (only the values differ), and the accent-color picker must keep
working on top of this.

This is the concrete spec for the redesign epic **#197** (which supersedes the v4
"soft-card" redesign #178) and must stay compatible with the responsive epic **#189**. The
landing page design is already approved — keep it consistent with these tokens but don't
regress its approved look.

---

## 1. Identity in one line

"Blueprint": a precise engineering-drawing feel — hairline borders, dashed row
separators, tight corners, **no shadows, no glow**. Calm, exact, trustworthy, and
**compact/dense** (information-rich, not airy). The brand color is a deep navy-teal
petrol; green and red are reserved strictly for monitor status.

---

## Logo & mark

The mark is a single **uptime-pulse line** — a heartbeat/EKG stroke reading left→right
(`M3 12h4l2.5-7 5 14 2.5-7H21` in a 24×24 box): the product's core question — _is it up?_ —
in one glyph. It renders two ways, from the same path:

- **In-app** (sidebar, top bar, sign-in/up): the white pulse stroke on a **petrol**
  (`--brand`, `#123b40`) rounded square — the `.mark` element.
- **Standalone icon** (favicon, app icon, OG): the same, self-contained in
  [`app/static/favicon.svg`](../app/static/favicon.svg) — a petrol rounded square + white
  pulse. It reads at 16px and on both light and dark browser tabs (the petrol ground carries
  it, so no theme variant is needed).

The wordmark is **`nabz`** — **always lowercase** (never "Nabz" or "NABZ"), including at the
start of a sentence, in page titles, and in alert subjects — in the body face (Inter,
semibold), never restyled or recolored. **Lowercase is a locked rule.** The tagline is
**"The pulse of your infrastructure"** (used in the hero + the OG image; `nabz` = Persian for
_pulse_, which is exactly what the mark already draws). Reserved status green/red never appear
in the mark.

The Open Graph image is generated from the same pulse path + the self-hosted Inter font by
[`app/scripts/gen-assets.mjs`](../app/scripts/gen-assets.mjs) (headless chromium via Playwright) —
run `cd app && node scripts/gen-assets.mjs` to regenerate **`og-image.png`** (1200×630 — mark +
wordmark + tagline on petrol). The square icons — `favicon.png` (256), `apple-touch-icon.png`
(180, full-bleed), `icon-192/512.png` (web manifest) — are the **mark alone** and are kept
byte-identical; regenerate them by hand only if the mark itself changes.

---

## 2. Color tokens

Semantic names, not literal — components reference `--surface-1`, never `#fff`. Each has a
light and a dark value.

### Brand / accent
| Token | Light | Dark | Notes |
|---|---|---|---|
| `--brand` | `#123b40` | `#3f9d97` | Petrol navy-teal. In dark it must be **lighter** than the bg or it disappears — brightened petrol. |
| `--brand-contrast` | `#ffffff` | `#0d1f22` | Text/icon color on top of a `--brand`-filled surface. |
| `--brand-muted` | `#5c7275` | `#7fa3a6` | Muted brand-tinted text (labels, secondary). |
| `--brand-wash` | `#eef4f4` | `#16302f` | Very subtle brand-tinted fill (selected chips, hover). |

The accent-color picker overrides `--brand` (and derives contrast/muted/wash from it).
Petrol `#123b40` is just the default accent.

### Status (RESERVED — never used as brand, never overridden by the accent picker)
| Token | Light | Dark |
|---|---|---|
| `--status-up` | `#2f8659` | `#4ade80` |
| `--status-up-wash` | `#e3f3ea` | `#14301f` |
| `--status-down` | `#c0453f` | `#f0653f` |
| `--status-down-wash` | `#f7e6e5` | `#3a1613` |
| `--status-paused` | `#7c818b` | `#8a8f99` |
| `--status-pending` | `#b08900` | `#e0b429` |

Brighter in dark so they read on a dark surface. **Locked** — the accent picker must not
touch them; up/down meaning must stay stable.

### Surfaces & structure
| Token | Light | Dark |
|---|---|---|
| `--bg` (page) | `#ecf0f1` | `#0f1719` |
| `--surface-1` (cards) | `#ffffff` | `#16211f` |
| `--surface-2` (subtle fill: feature cells, header strips) | `#f6fafa` | `#1b2725` |
| `--border` (hairline) | `#cdd8d9` | `#2b3a38` |
| `--border-dashed` (row separators) | `#dce4e5` | `#243230` |
| `--border-inner` (faint) | `#e3e9ea` | `#20302d` |

### Text
| Token | Light | Dark |
|---|---|---|
| `--text-primary` | `#123b40` headings / `#1f3a3d` body | `#e6efee` |
| `--text-secondary` | `#556a6d` | `#a8bbb9` |
| `--text-muted` | `#8a9a9c` | `#6f8583` |
| `--text-faint` (placeholders, disabled) | `#a0adae` | `#566a68` |

**Dark-theme rules (not just inverted colors):**
- `--brand` is *brightened* in dark (petrol → `#3f9d97`) so it stays visible.
- The one **filled brand stat card** (e.g. Latency p50): in light it's a dark petrol card
  with white text that "pops" against the light page. In dark, a dark card no longer pops —
  so render it as `--surface-1` with a `--brand` value + a `--brand` left-accent / top-border
  instead of a full fill. Keep the emphasis, flip the mechanism.
- Status colors use the brighter dark values.

---

## 3. Typography

Two families only. **Self-host** both (woff2, `font-display: swap`); no Google Fonts CDN.
Latin subset is fine (English-only).

- **Space Grotesk** — ONLY prominent statistical numbers: KPI values, uptime %, response
  times (e.g. `2ms` in the table), big dashboard figures, Domain/SSL dates. Always
  `font-variant-numeric: tabular-nums`. Weights: 500, 600.
- **Inter** — EVERYTHING else: page titles/headings, monitor names, body, buttons, labels
  (incl. uppercase stat labels like "FLEET UPTIME"), nav, URLs and host:port, and small
  inline numbers ("17s", "2m ago", "eu 14 / us 11"). Weights: 400, 500, 600, 700.

Rule of thumb: **big/important stat → Space Grotesk; small number inside text or a label →
Inter.** Space Grotesk is an accent for headline figures, not for every digit.

Do NOT use Space Grotesk for headings (too "display" at title size) — headings are Inter,
bold, slightly tight tracking (~-0.02em). **No monospace** — technical strings (URLs,
host:port) are just Inter.

---

## 4. Shape, spacing, density

- **Corners:** cards ~4px, buttons ~3px, pills/badges ~3px. Tight, not soft.
- **Borders:** 1px `--border` hairlines are the primary separator (NOT shadows). Row
  separators inside tables/lists are 1px **dashed** `--border-dashed`. Section titles can
  sit above a 1px `--border` rule.
- **Shadows / glow:** none. Depth comes from borders + the `--bg`/`--surface` step only.
- **Density:** compact — card padding ~14px, table row padding ~10px vertical, stat cards
  ~14px. An information-dense operator console, not a marketing dashboard.
- **Left-accent borders:** highlighted cards (open incident, Domain/SSL rows) use a 2px
  left border in `--brand` (or `--status-*` where it denotes status).

---

## 5. Components (shared, reused everywhere)

- **StatCard**: uppercase Inter label (`--text-muted`), big Space Grotesk number
  (`--text-primary` / `--brand`), small Inter sub-line. `variant="emphasis"` = brand-filled
  in light / brand-accented surface in dark (see the dark rule above).
- **Button**: primary = `--brand` fill + `--brand-contrast` text; secondary = `--surface-1`
  + 1px `--border` + `--text-secondary`. ~3px radius, no shadow, Inter 500.
- **Pill / StatusBadge**: `● up` (`--status-up` on `--status-up-wash`), `● down`, `paused`,
  `pending`. Small, ~3px radius, flat. Dot + short word.
- **Table / list**: mono-free; header row = uppercase Inter `--text-muted` small; rows
  separated by dashed `--border-dashed`; numeric columns right-aligned, Space Grotesk +
  tabular-nums; name cell = Inter 500 primary + Inter `--text-muted` sub-line (url/host).
- **Card**: `--surface-1`, 1px `--border`, ~4px radius, header strip with title (Inter 600
  `--brand`) + a `[n]` count (Inter `--text-muted`).
- **Tag / Chip**: `#tag` style, `--brand-wash` fill, 1px `--border`, small.
- **Form field**: full-width, 1px `--border`, ~3px radius, uppercase Inter label above,
  `--text-faint` placeholder (clearly lighter than entered text). Selected checkbox chips
  (zones) use `--brand` border + `--brand-wash` fill.
- **Domain & SSL card**: two stacked rows, each a left-accent border, an uppercase label, a
  small name line, and a big Space Grotesk date.

---

## 6. Themes & accent picker

- Everything above is defined for **both** light and dark via token values; a
  `data-theme="dark"` (or the project's existing mechanism) swaps the values.
- The **accent picker** stays: it overrides `--brand` and its derived
  `--brand-contrast` / `--brand-muted` / `--brand-wash`. It must NOT affect `--status-*` or
  structural tokens. Petrol `#123b40` is the default.
- Verify contrast in both themes (WCAG AA for text): the brightened dark `--brand`, the
  status colors, and text-on-brand must all pass.

---

## 7. Scope & delivery

Token/foundation + shared-components layer of the redesign epic (#197), compatible with the
responsive epic (#189) — build tokens/components responsive-ready. Apply across all app
pages and keep the landing consistent without regressing its approved design.

Ship incrementally, a PR per layer:
1. Tokens + theme foundation + self-hosted fonts (Inter + Space Grotesk); accent picker →
   `--brand`; legacy v4 token names aliased so existing components keep working.
2. Shared components (StatCard, Button, Pill, Table, Card, Form field, Chip, Domain & SSL).
3. Per-page application.
4. Dark-mode + accent-picker verification sweep.

Don't hardcode values that should be tokens. If something needs a value not covered here,
add a token for it rather than a one-off literal.
