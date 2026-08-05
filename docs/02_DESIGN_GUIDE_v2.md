# DevScent Design System — v2 (Elegant Dark Particle)

**Version**: 2.1.0
**Last Updated**: 2026-05-14
**Applies to**: `devscent.com` family landings and marketing sites (portfolio, services, estimate, case studies)
**Supersedes for devscent.com**: §3.4 preset selection in the base guide (`02_DESIGN_GUIDE.md`) - devscent.com now uses the Elegant Dark Particle preset defined here.
**Still authoritative**: the base guide (`02_DESIGN_GUIDE.md`) for brand foundation, planning artifacts, product concept families, light presets (Core / Namu / Aman / Belmond / Airbnb), accessibility, and product-UI conventions.

---

## 0. What v2 Changes

The base guide describes presets suitable for different product surfaces. Every devscent.com landing historically picked one of the light presets and adapted it. This document codifies a **single marketing preset** for the devscent.com family itself so every devscent-owned portfolio/landing site reads as the same studio:

1. A concrete dark preset — **Elegant Dark Particle** — with every `--ds-*` token filled in.
2. A display-type pairing (Syne + DM Sans + JetBrains Mono) that sits on top of the base guide sans stack.
3. A shared chrome recipe (`body.elegant-shell`) that re-skins nav, buttons, and footer without rewriting page-level CSS.
4. A landing recipe — hero with particle canvas + code window, scroll-revealed sections, services/works grid, about strip, CTA glow — that can be lifted into any devscent.com-family site.

The base guide rule "one preset per product, applied across landing / auth / internal app" still holds. Elegant Dark Particle is the devscent.com marketing-surface preset; internal consoles (e.g. `admin.html`) continue to use their own preset from the base guide.

Planning note: for new products and redesigns, start from base guide §1.5 (planning artifact contract) and §3.6 (concept families). Use this document only after the product is clearly a devscent.com-family marketing surface.

---

## 1. Brand Voice on the Marketing Surface

devscent.com reads as **"a developer studio that respects both engineering and craft."** The marketing surface should feel:

| Feel | Translation to UI |
|------|-------------------|
| Engineered | Mono eyebrows, code window with real syntax colors, grid-aligned composition |
| Calm | Near-black shell, generous whitespace, slow motion, no gradients except one CTA glow |
| Human | Rotated code window, hand-tuned particle motion, scroll-reveal stagger |
| Confident | Syne display at large sizes, single navy action, mint used as a signature dot |

**Forbidden on devscent.com marketing pages**: rainbow gradients, purple-to-pink washes, glassmorphism cards stacked over gradient blobs, neon outline text, or glowing drop-shadows on typography. The one permitted glow is the fixed CTA section glow (§5.9).

---

## 2. Canonical Stack

Marketing pages on devscent.com are static HTML/CSS/vanilla JS — no framework build step. This guide preserves the base `--ds-*` token contract so product pages using Tailwind + Next.js can adopt the same preset by swapping `data-theme` on `<html>`.

| Layer | Used on devscent.com | Notes for other sites |
|-------|----------------------|-----------------------|
| Shell | `theme-tokens.css` + `styles-elegant-shell.css` + `elegant-shell.js` | Portable — copy these three files |
| Landing | `styles-home-elegant.css` + `home-elegant.js` | Landing-specific; scoped under `.index-elegant` |
| Fonts | Google Fonts: Syne, DM Sans, JetBrains Mono, IBM Plex Sans KR | Preconnect, single `<link>` line |
| Theme persistence | `localStorage['devscent.siteTheme']` with `'elegant-dark'` default | Inline `<script>` in `<head>` before paint |
| i18n persistence | `localStorage['devscent.locale']` | Shared with existing `i18n.js` |

---

## 3. Elegant Dark Particle Preset

### 3.1 Token Contract

The preset is declared as `:root[data-theme="elegant-dark"]` in `frontend/theme-tokens.css`. Every runtime token named in base guide §3.2 is filled in so that page-level CSS (pricing, estimate, portfolio-detail) inherits the dark chrome without per-file overrides.

```css
:root[data-theme="elegant-dark"] {
  color-scheme: dark;
  --ds-font-sans: "DM Sans", "IBM Plex Sans KR", "Pretendard Variable",
                   "Pretendard", "Apple SD Gothic Neo", -apple-system, sans-serif;
  --ds-font-display: "Syne", "DM Sans", "Manrope", sans-serif;

  /* Surfaces — step from near-black shell to chrome-raised */
  --ds-bg:              #08090c;
  --ds-surface:         #101218;
  --ds-surface-alt:     #161921;
  --ds-surface-raised:  #1e2230;
  --ds-surface-strong:  #242a34;

  /* Text */
  --ds-foreground:      #e6e4df;         /* warm paper-white, not pure white */
  --ds-foreground-dim:  rgba(230,228,223,0.72);
  --ds-muted:           #565d72;
  --ds-muted-foreground:#8b93a8;

  /* Borders */
  --ds-border:          #1e2232;
  --ds-border-strong:   #2c3148;

  /* Action — navy, from the brand spine */
  --ds-action:          #2562eb;
  --ds-action-hover:    #1d4fcc;
  --ds-action-foreground:#ffffff;
  --ds-action-subtle:   rgba(37,98,235,0.12);
  --ds-link:            #60a5fa;

  /* Accent — mint (signature) */
  --ds-accent:          #34d399;
  --ds-accent-hover:    #28b880;
  --ds-accent-subtle:   rgba(52,211,153,0.12);

  /* Highlight — azure (hover/link emphasis) */
  --ds-highlight:       #60a5fa;
  --ds-highlight-subtle:rgba(96,165,250,0.14);

  /* Semantic states — tuned for dark surface */
  --ds-success: #34d399;  --ds-success-surface: rgba(52,211,153,0.12);
  --ds-warning: #f4a261;  --ds-warning-surface: rgba(244,162,97,0.14);
  --ds-error:   #f87171;  --ds-error-surface:   rgba(248,113,113,0.14);
  --ds-info:    #60a5fa;  --ds-info-surface:    rgba(96,165,250,0.14);

  --ds-overlay:    rgba(8,9,12,0.72);
  --ds-shadow-sm:  0 1px 2px rgba(0,0,0,0.40);
  --ds-shadow-md:  0 12px 32px rgba(0,0,0,0.40);
  --ds-shadow-lg:  0 32px 80px rgba(0,0,0,0.60);
}
```

### 3.2 Why These Values

- **#08090c bg, not pure #000**: pure black against warm-white type creates CRT vibration; #08090c lets the foreground settle.
- **#e6e4df foreground, not #fff**: slightly warm paper-white keeps long-reading copy comfortable against the cool shell.
- **Navy primary (#2562eb) + mint accent (#34d399)**: navy stays the product action across the whole DevScent system (base guide §3.1); mint is the marketing signature that differentiates the landing from the product console.
- **5-step surface ladder**: `bg → surface → surface-alt → surface-raised → surface-strong`. Use `surface-alt` for nav-scrolled blur; `surface-raised` for code window and hero cards; `surface-strong` for pressed states only.

### 3.3 Do / Don't

**Do**
- Keep the shell strictly on the `bg/surface/surface-alt` triplet. Lift to `surface-raised` only for elevated cards (code window, stats pill, hero badge).
- Use `--ds-accent` (mint) as a *single-point* accent: section-label bars, code-window dots, footer period, hero stat numbers. Not fills.
- Use `--ds-action` (navy) for primary CTAs and nothing else on the marketing surface.

**Don't**
- Don't introduce a second accent hue. The preset has exactly three non-neutral roles: action navy, accent mint, highlight azure.
- Don't pair this preset with Aman or Belmond type — Syne's geometry fights their serifs.
- Don't tint the bg toward blue (#0a0f1c etc.) — it drifts into generic "crypto dashboard" territory.

---

## 4. Typography

### 4.1 Families

| Role | Family | Weights | When to use |
|------|--------|---------|-------------|
| Display | **Syne** | 600 / 700 / 800 | `h1`, `h2`, brand mark, section-head titles. Tight letter-spacing (`-0.02em`). |
| Body | **DM Sans** | 300 / 400 / 500 | All paragraphs, lists, buttons, nav, form labels |
| Mono | **JetBrains Mono** | 400 / 500 | Eyebrows (`.t-label`, `.eyebrow`), code-window body, badge labels, stat captions |
| Korean body | **IBM Plex Sans KR** | 400 / 500 / 600 / 700 | Fallback inside `--ds-font-sans` so Korean glyphs land on IBM Plex Sans KR while Latin lands on DM Sans |

Font link used on every elegant-shell page:

```html
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300&family=JetBrains+Mono:wght@400;500&family=IBM+Plex+Sans+KR:wght@400;500;600;700&display=swap" rel="stylesheet">
```

### 4.2 Scale

| Class | Size / line | Weight | Letter-spacing | Family |
|-------|-------------|--------|----------------|--------|
| `.t-h1` | clamp(42px, 6vw, 84px) / 1.04 | 700 | -0.03em | Syne |
| `.t-h2` | clamp(32px, 4vw, 48px) / 1.12 | 700 | -0.02em | Syne |
| `.t-h3` | clamp(22px, 2.5vw, 28px) / 1.2 | 600 | -0.015em | Syne |
| `.t-body` | 16–17px / 1.65 | 400 | 0 | DM Sans |
| `.t-label` (eyebrow) | 11–12px / 1 | 500 | 0.18em, UPPERCASE | JetBrains Mono |
| `.code-body` | 13–14px / 1.6 | 400–500 | 0 | JetBrains Mono |

### 4.3 Rules

- Korean and English share `--ds-font-sans`. Do **not** override per-language — the `IBM Plex Sans KR` fallback handles Korean glyph coverage.
- Never set color on display headings beyond `--ds-foreground`. If a headline needs emphasis, break it across two lines (see `.about-title` in landing) rather than coloring a word.
- Eyebrows always sit next to a 28–40px wide mint bar (`.section-label-bar`) — this pairing is the single most-repeated motif on devscent.com.

---

## 5. Landing Recipe (`index.html` + `.index-elegant`)

The landing is composed of six sections in this exact order. Each section below lists the required DOM, the visible-behavior rules, and what to keep vs. what is safe to re-theme when porting to another devscent.com-family site.

### 5.1 Nav

- 64–72px fixed bar, transparent on top, `rgba(8,9,12,0.88)` + `backdrop-filter: blur(20px)` when `window.scrollY > 40`.
- Logo uses `docs/devscent_ci/horizontal/horizontal_white.png`, filtered to pure white via `filter: brightness(0) invert(1)`. Do not ship a second-color version — the filter ensures the same asset works across presets.
- Nav link radius 6px, inactive color `--ds-foreground-dim`, hover/active fill `--ds-surface-alt`.
- Lang switch is a pill group (`.lang-switch`), not a dropdown, on the shell. The landing may upgrade to a flag dropdown (`.lang-dd`) that reads from `flagcdn.com` — both store to `localStorage['devscent.locale']`.

### 5.2 Split Hero

Mandatory two-column structure: left = copy + CTA pair + stats strip; right = code window + latest-build badge. Canvas sits behind both.

```html
<section class="hero hero-split">
  <canvas id="hero-canvas" aria-hidden="true"></canvas>
  <div class="hero-content">
    <div class="container">
      <div class="hero-inner">
        <div class="hero-left">
          <div class="hero-anim hero-anim-1"><div class="scroll-ind">…</div></div>
          <div class="hero-anim hero-anim-2"><h1 class="t-h1">…</h1></div>
          <div class="hero-anim hero-anim-3"><p>…</p></div>
          <div class="hero-anim hero-anim-4 hero-ctas">…</div>
          <div class="hero-anim hero-anim-4 hero-stats"></div>
        </div>
        <div class="hero-right hero-anim hero-anim-3">
          <div class="code-window">…</div>
          <div class="hero-badge">…</div>
        </div>
      </div>
    </div>
  </div>
</section>
```

Rules:
- Left column entry is staggered: `hero-anim-1 … hero-anim-4` apply a 120ms cascade (opacity 0→1, translateY 24px→0). Implemented via CSS keyframes, not JS, so it runs before `home-elegant.js` boots.
- The code window is rotated `1.5deg` on desktop and flattened to `0deg` below 900px.
- The scroll indicator uses a 1px vertical line with an animated scanning dot (`scanLine` keyframe, 2.4s loop) — it is the only always-looping motion on the page.

### 5.3 Particle Canvas

Implemented in `home-elegant.js :: initParticles`. 55 particles, 60% code snippets (short strings like `const`, `async`, `=>`, `()`, `null`) and 40% dots. Each particle has `vx, vy ∈ [-0.12, 0.12]` and wraps at viewport edges. Render pass:

1. Clear canvas.
2. Draw code-snippet particles in `JetBrains Mono 12px` at `rgba(52,211,153,0.22)`.
3. Draw dot particles as 1.5px circles at `rgba(96,165,250,0.34)`.
4. Draw connecting lines between dots within 120px radius at opacity `(1 - d/120) * 0.12`.

Rules:
- Pause the RAF loop when `document.hidden` and resume on `visibilitychange`. This is non-negotiable — marketing landings often sit in backgrounded tabs.
- Respect `prefers-reduced-motion: reduce` by skipping the RAF loop and drawing one static frame.

### 5.4 Code Window

A purely decorative DOM element — no real syntax highlighting engine. Structure is a `.code-window-bar` (three traffic-light dots, file name) plus a `.code-body` of hand-classed spans:

| Class | Color token |
|-------|-------------|
| `.code-cm` | `#6b7280` (comment) |
| `.code-kw` | `--ds-link` / `#60a5fa` (keyword) |
| `.code-fn` | `--ds-accent` / `#34d399` (function) |
| `.code-str` | `#fbbf24` (string) |
| `.code-num` | `#f472b6` (number) |
| `.code-var` | `--ds-foreground-dim` (default var) |
| `.code-ln` | `--ds-muted` (line number gutter) |

When porting this window to another site, the only value you should change is the file name (e.g. `main.js — devscent` → `order.ts — <productname>`) and the code contents. The classed spans are stable.

### 5.5 Works Grid (SELECTED WORKS)

3-column grid on desktop (`grid-template-columns: repeat(3, 1fr)`), 2-column at ≤1100px, 1-column at ≤700px. Each card is a `<a class="work-card">` with an image thumb, title, and tag row. Cards use `border: 1px solid var(--ds-border)` and lift to `translateY(-4px)` on hover with `--ds-shadow-md`.

Data source on devscent.com: `home-elegant.js :: renderProjects()` reads the same `portfolio-data.js` file used by `/portfolio.html`, so a single catalog edit updates both. For other devscent.com-family sites, recreate the same render contract (`{id, name, summary, tags, cover}`) and reuse the CSS.

### 5.6 Services Grid

4-column grid on desktop, 2-col at ≤1000px, 1-col at ≤600px. Each card has a mint-dot eyebrow, Syne title, DM Sans summary, and `→` chevron footer. Background `--ds-surface`; hover lifts to `--ds-surface-alt` with accent chevron color flip.

### 5.7 About Strip

Two-column: left = eyebrow + headline + paragraph + ghost button; right = 2×2 stats grid. Stats cells show a display-weight number over a mono eyebrow label. The headline is intentionally broken across three visible lines — pre-line whitespace is preserved via `white-space: pre-line`, so translators can ship multi-line strings in a single i18n value.

### 5.8 CTA Section

A single full-width section with a fixed-height radial glow (`cta-glow`) sitting *behind* the text. Glow spec:

```css
.cta-glow {
  position: absolute; inset: 0;
  background: radial-gradient(ellipse at center,
    rgba(37, 98, 235, 0.22) 0%,
    rgba(52, 211, 153, 0.08) 40%,
    transparent 70%);
  filter: blur(60px);
  pointer-events: none;
}
```

This is the **only** permitted gradient on devscent.com marketing surfaces. Do not duplicate this pattern for other section headers.

### 5.9 Footer

4-column grid (brand / pages / links / contact) on desktop, stacked on mobile. The `devscent.` wordmark in the brand cell uses Syne 800 with the period in `--ds-accent`. Same treatment is reapplied via the elegant-shell footer recipe (`footer p::before` / `::after`) on non-landing pages so every devscent.com page closes on the same mark.

---

## 6. Reuse Pattern for Other Pages

Non-landing pages (pricing, estimate, portfolio detail) adopt the preset through three additions — no content CSS rewrite needed:

1. **`<html data-theme="elegant-dark">`** (default via inline script reading `localStorage['devscent.siteTheme']`).
2. **`<body class="elegant-shell">`** — activates `styles-elegant-shell.css` rules which re-skin `.topbar`, `.brand`, `nav a`, `.lang-switch`, `.btn / .btn-primary / .btn-soft / .btn-ghost`, and `footer`.
3. **`<script src="./elegant-shell.js">`** — adds only the scroll-blur class to the nav.

Page-specific CSS (`pricing.css`, `estimate.css`, `portfolio-detail.css`) continues to use `--ds-*` tokens; because those tokens now resolve against the elegant-dark preset, the page renders correctly on the new shell without touching its layout rules.

**When a page needs a hero-level moment** (e.g. a portfolio case study hero), lift the split-hero DOM from the landing but drop the canvas and code window. Keep the `.t-h1`, eyebrow, and ghost-CTA pattern. Do not introduce a second particle scene on interior pages — the particle canvas belongs to `/` only.

---

## 7. Motion Recipes

| Motion | Implementation | Tune |
|--------|----------------|------|
| Hero entry cascade | CSS `@keyframes heroIn` on `.hero-anim-1/2/3/4` with 0/120/240/360ms delay | Ship in CSS, not JS — runs before hydration |
| Scroll reveal | Singleton `IntersectionObserver`, threshold `0.15`, toggles `.visible` | `home-elegant.js :: observeReveal()` — must be re-run after i18n re-render |
| Section label reveal | Piggy-backs on the same `.reveal` observer with `reveal-delay-1..3` CSS modifiers | Delays: 0 / 80ms / 160ms / 240ms |
| Particle loop | RAF, pause on `visibilitychange`, honor `prefers-reduced-motion` | Cap DPR at 1.5 to avoid mobile thermal throttle |
| Nav blur | Class toggle on `scrollY > 40` | 300ms `transition` on `background, border-color, backdrop-filter` |
| Scroll indicator | `@keyframes scanLine`, 2.4s infinite | Only looping motion above the fold |

Global rule: every non-loop motion caps at 600ms. Reveal stagger never exceeds 240ms of additional delay.

---

## 8. Porting Checklist (for a new devscent.com-family site)

Use this as a PR checklist when launching a new devscent-owned portfolio/landing.

```
[ ] Copy frontend/theme-tokens.css (keeps --ds-* + elegant-dark preset)
[ ] Copy frontend/styles-elegant-shell.css
[ ] Copy frontend/elegant-shell.js
[ ] For the landing: copy styles-home-elegant.css + home-elegant.js
[ ] Inline theme-default script in <head> reading localStorage['devscent.siteTheme']
[ ] <body class="elegant-shell"> on every page; <body class="index-elegant noise"> on the landing
[ ] Font <link> (Syne + DM Sans + JetBrains Mono + IBM Plex Sans KR)
[ ] Logo asset: horizontal_white.png (filter: brightness(0) invert(1))
[ ] Nav items limited to: Portfolio / Services / Estimate / About / Contact (rename per product)
[ ] i18n switcher persists to localStorage['devscent.locale']
[ ] Footer closes with the 'devscent.' wordmark recipe
[ ] One radial glow, one particle canvas, one code window — all on the landing only
[ ] All motion respects prefers-reduced-motion
[ ] Preset is elegant-dark across landing, detail pages, and auth; never mixed with base-guide light presets on the same origin
```

---

## 9. Anti-Patterns Seen in Review

Things that have surfaced in previous devscent.com-family drafts and should not ship:

- **Second accent hue** (e.g. adding an amber or rose alongside mint) — dilutes the signature. Keep exactly one accent.
- **Gradient fills behind section headers** — only the CTA glow uses gradient. Section heads use the mint bar.
- **Animated glowing text** — text never glows on this preset. Glow is reserved for behind-type atmosphere (CTA).
- **Per-page theme switching** — e.g. pricing in light, landing in dark. Violates base guide §3.3 and confuses brand recall.
- **Custom cursors or cursor followers** — ship only the baseline pointer.
- **Marquee banners with looping text** — looping motion is one scanLine only.
- **3D tilt / mouse-parallax on cards** — cards lift on hover and nothing else.
- **Replacing Syne with a different display face without updating this doc** — Syne's geometry is the reason the code window and headlines rhyme; swapping it breaks the recipe.

---

## 10. Versioning

- This document is versioned independently from the base guide but MUST NOT contradict base guide §1 (Brand Foundation) or §3.2 (Semantic Token Contract). If a future revision needs to break those, bump the base guide major version and retire this file.
- Token values in §3.1 are the source of truth. When they diverge from `frontend/theme-tokens.css`, reconcile **toward the CSS file** and update this doc in the same PR.
- Component recipes in §5 are the source of truth for devscent.com. When they diverge from `styles-home-elegant.css` / `home-elegant.js`, reconcile **toward the files** and update this doc.

---

## Appendix A — File Map

| File | Role |
|------|------|
| `frontend/theme-tokens.css` | All base presets + Elegant Dark Particle |
| `frontend/styles-elegant-shell.css` | Shared chrome for non-landing pages (topbar/buttons/footer) |
| `frontend/elegant-shell.js` | Shared chrome JS — nav scroll blur only |
| `frontend/styles-home-elegant.css` | Landing-specific CSS, scoped under `.index-elegant` |
| `frontend/home-elegant.js` | Landing JS — i18n content, particles, reveal observer, lang dropdown |
| `frontend/index.html` | Landing shell |
| `frontend/portfolio.html`, `pricing.html`, `estimate.html` | Consumers of the elegant shell |
| `docs/02_DESIGN_GUIDE.md` | Base guide - brand foundation, planning artifacts, concept families, presets, accessibility |
| `docs/02_DESIGN_GUIDE_v2.md` | devscent.com marketing-surface guide - this document |

## Appendix B — Token Quick Reference

| Role | Token | Value |
|------|-------|-------|
| Shell bg | `--ds-bg` | `#08090c` |
| Card surface | `--ds-surface` | `#101218` |
| Raised card | `--ds-surface-raised` | `#1e2230` |
| Type | `--ds-foreground` | `#e6e4df` |
| Dim type | `--ds-foreground-dim` | `rgba(230,228,223,0.72)` |
| Action | `--ds-action` | `#2562eb` |
| Accent | `--ds-accent` | `#34d399` |
| Highlight | `--ds-highlight` | `#60a5fa` |
| Border | `--ds-border` | `#1e2232` |
