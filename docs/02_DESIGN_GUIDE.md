# DevScent Design System

**Version**: 2.0.0
**Last Updated**: 2026-05-14
**Applies to**: All DevScent products (inmemorytrip.com, devscent.com, etc.)
**Parent Reference**: devscent-home/docs/02_design_guide.md

---

## 1. Brand Foundation

### 1.1 Identity

DevScent = Development + Scent

> "A scent from someone who loves software engineering."

Every DevScent product inherits this philosophy: clarity, structure, and joy.
Design is not decoration. Design is structure. Every pixel must have a reason.

### 1.2 Design Direction

| Principle | Intent |
|-----------|--------|
| **Minimal but Powerful** | Strip away the unnecessary. Keep what matters. |
| **Structured over Decorative** | Information hierarchy drives every layout decision. |
| **Normal over Novel** | Prefer proven product patterns over attention-seeking composition. |
| **Calm Color, Strong Contrast** | One palette at a time. Let media be expressive and chrome stay quiet. |
| **Confident but Not Aggressive** | Professional B2B tone with calm authority. |
| **Engineering-First Aesthetic** | Precision, alignment, and intentional spacing. |
| **Joyful Interactions** | Development should feel exciting, not exhausting. |

### 1.3 Design Characteristics

- Clean interfaces with generous whitespace
- Clear visual hierarchy at every level
- Intentional spacing on an 8px grid
- Strong contrast for readability
- Solid surfaces with restrained depth
- High information density without clutter
- Fast interactions with minimal friction
- Familiar layout patterns before expressive decoration
- Photography and media may be bold; UI chrome should remain disciplined

### 1.4 Uncodixfy Baseline

- Default to solid surfaces, simple borders, and predictable layout shells.
- No glassmorphism, glow, conic gradients, oversized radii, decorative headline blocks, or floating detached cards.
- Buttons, inputs, tables, lists, and panels must read as product UI first.
- Landing pages may use strong photography, but section frames, navigation, CTAs, and cards stay structurally normal.
- Choose one theme preset per product and apply it consistently to landing, auth, and internal app screens.
- Do not combine Aman surfaces with Airbnb actions, or Belmond editorial tones with Elegant Dark chrome.

### 1.5 Product Planning Artifact Contract

This design guide is not only a styling reference. For new services, redesigns, and meaningful feature launches, the design stage must produce a small product packet before implementation starts.

Required planning inputs:

- `docs/PRD.txt`, `docs/PRD.md`, or `docs/product/PRD.md` as the source requirements document.
- Existing service docs, screenshots, analytics, support notes, and operating constraints.
- Current codebase scan so the proposed UI can be implemented without fighting the stack.

Required planning outputs:

| File | Purpose | Must Include |
|------|---------|--------------|
| `docs/product/01_PRD_ANALYSIS.md` | Requirements digestion | Users, jobs, goals, non-goals, constraints, open questions, success metrics |
| `docs/product/02_SHAPING.md` | Brainstorming and scope shaping | Better ideas considered, selected concept, risks, rabbit holes, out-of-bounds |
| `docs/product/03_MVP.md` | Buildable first release | Vertical slice, screens, APIs/data, permissions, tests, launch criteria |
| `docs/product/04_STORYBOARD.md` | Experience narrative | User emotion, scene goal, transition, empty/error states |
| `docs/product/05_WIREFRAMES.md` | Layout skeleton | Desktop/tablet/mobile text wireframes and navigation model |
| `docs/product/06_HIGH_FIDELITY_DESIGN.md` | Implementation-ready visual spec | Concept, palette, type, components, states, motion, imagery, responsive rules |

The packet should stay concise. It exists to remove ambiguity before code, not to become a separate product.

### 1.6 High-Fidelity Design Requirements

High-fidelity design must describe what the built service will actually look like. Do not stop at mood words.

Each high-fidelity document must define:

- The selected concept family and why it matches the domain.
- Color tokens for background, surfaces, text, border, primary action, supporting accent, success, warning, error, and info.
- Type roles for display, body, data/mono, captions, and Korean/English fallback behavior.
- Navigation behavior on desktop and mobile.
- Core screen composition for the first three user journeys.
- Component states: default, hover, active, disabled, loading, empty, error, permission-limited.
- Responsive rules for tables, charts, grids, cards, forms, modals, and sticky actions.
- Motion rules and `prefers-reduced-motion` behavior.
- Image/media policy: what media proves the product, where it appears, and what must never be decorative filler.

When the target service is operational software, the screen must privilege scanning, comparison, repeated action, and error recovery over oversized marketing composition.

### 1.7 External Practice Principles

Use these product-development practices as design inputs, not as ceremony:

- Shape Up: separate problem, appetite, solution outline, risks, and excluded scope before committing to a build.
- Design Sprint: map the problem, sketch options, decide, prototype realistically enough to learn, then test assumptions.
- TDD/ATDD/BDD: convert risky behavior into testable examples from the user's point of view.
- Fowler-style refactoring: preserve behavior while improving structure in small, verifiable steps.
- Modern design systems: use tokens, foundations, components, accessibility, and platform consistency as reusable decision layers.

---

## 2. Technology Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| **Framework** | Next.js (App Router) | Server Components by default |
| **Styling** | Tailwind CSS v4 + CSS Variables | Theming via `--ds-*` custom properties |
| **UI Primitives** | Radix UI | Accessible, unstyled headless components |
| **Icons** | Lucide React | Consistent, lightweight icon set |
| **i18n** | next-intl | All visible strings via i18n keys |
| **State** | Zustand | Lightweight client state management |
| **Testing** | Vitest + Testing Library + Playwright | Unit / Integration / E2E |

---

## 3. Color System

All DevScent products share a semantic token system using the `--ds-` prefix, but new work must choose one preset and apply it consistently across landing, auth, and app UI.

### 3.1 Brand Colors (Corporate Reference)

These values define DevScent's brand identity for logos, corporate materials, and shared brand assets.
Theme presets may remap runtime UI tokens, but the brand marks themselves should remain compatible with these colors.

```css
:root {
  --ds-brand-base:      #1A2238;
  --ds-brand-primary:   #2562EB;
  --ds-brand-accent:    #34D399;
  --ds-brand-highlight: #60A5FA;
}
```

### 3.2 Semantic Token Contract

Every preset must define the same runtime token contract:

- Surfaces: `--ds-bg`, `--ds-surface`, `--ds-surface-alt`, `--ds-surface-raised`, `--ds-surface-strong`
- Text: `--ds-foreground`, `--ds-muted`, `--ds-muted-foreground`
- Borders: `--ds-border`, `--ds-border-strong`
- Actions: `--ds-primary`, `--ds-primary-hover`, `--ds-primary-subtle`, `--ds-primary-foreground`
- Supporting accents: `--ds-accent`, `--ds-accent-hover`, `--ds-accent-subtle`
- Product accent: `--ds-product-accent`, `--ds-product-accent-hover`, `--ds-product-accent-subtle`
- Semantic states: `--ds-success`, `--ds-warning`, `--ds-error`, `--ds-info`

### 3.3 Theme Preset Selection Rules

- One preset per product. Do not switch preset by page.
- Landing, login, dashboard, settings, modal, and table views must share the same preset.
- Primary is for actions. Accent is for secondary emphasis. Product accent is for service-specific moments only.
- Do not add gradient backgrounds, glow, or tinted shadow systems on top of these presets.
- If a product needs a dark mode, use the dedicated dark preset below rather than inventing a new blue-black theme.

### 3.4 Supported Theme Presets

| Preset | Mode | Reference | Palette Spine | Best Fit |
|--------|------|-----------|---------------|----------|
| **DevScent Core** | Light | DevScent internal baseline | Paper neutral, navy, amber | General product UI, admin tools, B2B apps |
| **Namu Heritage Green** | Light | Korean archival and celadon-inspired | Hanji, pine ink, celadon green | Genealogy, archives, heritage records, cultural services |
| **Aman Quiet Luxury** | Light | Aman-inspired | Stone, sand, smoke, bronze | Travel, wellness, premium hospitality |
| **Belmond Editorial Heritage** | Light | Belmond-inspired | Porcelain, black, taupe, reserve red | Story-led travel, editorial commerce |
| **Airbnb Friendly Utility** | Light | Airbnb-inspired | Off-white, coral, charcoal | Consumer products, approachable booking flows |
| **Elegant Dark** | Dark | `btrader.kr` / `werqon.com` inspired | Charcoal, graphite, champagne, bronze | Trading, analytics, premium operational tools |

#### 3.4.1 DevScent Core

Use this when the product should feel structured and product-first, not luxurious or lifestyle-led.

```css
:root[data-theme-preset="core"] {
  --ds-bg: #F6F4EF;
  --ds-surface: #FFFFFF;
  --ds-surface-alt: #EEE8DE;
  --ds-surface-raised: #FFFFFF;
  --ds-surface-strong: #E4DBCF;

  --ds-foreground: #1F2933;
  --ds-muted: #A59B8E;
  --ds-muted-foreground: #6C665F;

  --ds-border: #DBD2C6;
  --ds-border-strong: #CFC5B8;

  --ds-primary: #1A2238;
  --ds-primary-hover: #111827;
  --ds-primary-subtle: #ECE6DC;
  --ds-primary-foreground: #F8F5EE;

  --ds-accent: #B16A34;
  --ds-accent-hover: #965929;
  --ds-accent-subtle: #F5E6D5;

  --ds-product-accent: #8E6B43;
  --ds-product-accent-hover: #755636;
  --ds-product-accent-subtle: #F2E7D7;

  --ds-success: #356347;
  --ds-warning: #A06D2E;
  --ds-error: #B65445;
  --ds-info: #1A2238;
}
```

Rules:
- Keep backgrounds neutral. Do not blue-tint the shell.
- Use navy for actions and emphasis, not for decorative washes.
- Use amber sparingly for product moments, counters, or travel memory cues.

#### 3.4.2 Namu Heritage Green

Use this for genealogy, archival, heritage, or cultural-record products where the interface should feel calm, rooted, and well-kept rather than overtly modernist or lifestyle-luxury.
This preset is based on hanji paper neutrals, celadon green, and deep pine-ink tones. The goal is not "green app UI". The goal is "trusted record system with Korean heritage undertones".

```css
:root[data-theme-preset="namu-heritage"] {
  --ds-bg: #F6F4EE;
  --ds-surface: #FFFDFC;
  --ds-surface-alt: #EEF2ED;
  --ds-surface-raised: #FFFFFF;
  --ds-surface-strong: #DDE5DF;

  --ds-foreground: #1E2B24;
  --ds-muted: #99A399;
  --ds-muted-foreground: #5F6C64;

  --ds-border: #D7DED8;
  --ds-border-strong: #C5D0C9;

  --ds-primary: #234B3B;
  --ds-primary-hover: #1B3A2E;
  --ds-primary-subtle: #E6EFEB;
  --ds-primary-foreground: #F8F6F1;

  --ds-accent: #6C8A7E;
  --ds-accent-hover: #5B786D;
  --ds-accent-subtle: #EDF4F0;

  --ds-product-accent: #88A99A;
  --ds-product-accent-hover: #6F9382;
  --ds-product-accent-subtle: #E8F1EC;

  --ds-success: #2F6A50;
  --ds-warning: #9A7140;
  --ds-error: #A6574E;
  --ds-info: #234B3B;
}
```

Rules:
- Green must stay slightly cool and muted. No lime, neon, mint, or cartoon leaf tones.
- Pair green with warm paper neutrals so the UI reads like a curated archive, not a gardening app.
- Use celadon or sage for secondary emphasis, not for the main action hierarchy.
- Saturated red may appear only in seal, approval, alert, or ceremonial moments.
- This preset fits products like `Namu Service`, clan records, document vaults, and cultural knowledge systems.

#### 3.4.3 Aman Quiet Luxury

Use this for quiet travel, wellness, accommodation, or premium experience products.
This preset is based on the official Aman site signals: muted stone/sand surfaces, charcoal text, Whitney-family UI sans, and Lyon-family serif typography.

```css
:root[data-theme-preset="aman"] {
  --ds-bg: #F3EEE7;
  --ds-surface: #FAF7F1;
  --ds-surface-alt: #ECE6DD;
  --ds-surface-raised: #FFFFFF;
  --ds-surface-strong: #DAD9D7;

  --ds-foreground: #313131;
  --ds-muted: #82847F;
  --ds-muted-foreground: #625F5F;

  --ds-border: #DAD9D7;
  --ds-border-strong: #CFC8BD;

  --ds-primary: #313131;
  --ds-primary-hover: #202020;
  --ds-primary-subtle: #E6E2DB;
  --ds-primary-foreground: #FAF7F1;

  --ds-accent: #82847F;
  --ds-accent-hover: #6F716D;
  --ds-accent-subtle: #ECE9E2;

  --ds-product-accent: #B38B5B;
  --ds-product-accent-hover: #987347;
  --ds-product-accent-subtle: #F3E8D7;

  --ds-success: #5F7168;
  --ds-warning: #B38B5B;
  --ds-error: #A05B50;
  --ds-info: #313131;
}
```

Rules:
- Surfaces should feel architectural and matte, not glossy.
- Contrast is calm. Avoid pure black blocks and loud fills.
- Olive-smoke and bronze are supporting notes, not dominant accents.
- Large media, quiet navigation, and serif-led editorial moments fit this preset best.

#### 3.4.4 Belmond Editorial Heritage

Use this for travel storytelling, premium booking, destination discovery, or media-led commerce.
This preset is based on the official Belmond site signals: porcelain paper tones, near-black typography, Montserrat UI/body, and Theano Didot display contrast.

```css
:root[data-theme-preset="belmond"] {
  --ds-bg: #FAF9F7;
  --ds-surface: #FFFFFF;
  --ds-surface-alt: #F6F4F0;
  --ds-surface-raised: #FFFFFF;
  --ds-surface-strong: #DBD9D9;

  --ds-foreground: #111111;
  --ds-muted: #757575;
  --ds-muted-foreground: #5C5651;

  --ds-border: #DBD9D9;
  --ds-border-strong: #B9B9B9;

  --ds-primary: #111111;
  --ds-primary-hover: #000000;
  --ds-primary-subtle: #F0EEEA;
  --ds-primary-foreground: #FFFFFF;

  --ds-accent: #887974;
  --ds-accent-hover: #6F625E;
  --ds-accent-subtle: #F2EEEB;

  --ds-product-accent: #C24B46;
  --ds-product-accent-hover: #A33C38;
  --ds-product-accent-subtle: #FBE9E8;

  --ds-success: #476152;
  --ds-warning: #A06A3A;
  --ds-error: #D0011B;
  --ds-info: #111111;
}
```

Rules:
- Typography contrast should do more work than color contrast.
- Use strong black-on-porcelain structure before adding warm accent notes.
- Reserve red for rare offer, alert, or editorial emphasis moments.
- Cards, rails, and navigation should feel sharper and more editorial than Aman.

#### 3.4.5 Airbnb Friendly Utility

Use this for approachable consumer products where trust, ease, and fast action matter more than prestige.

```css
:root[data-theme-preset="airbnb"] {
  --ds-bg: #FFF8F3;
  --ds-surface: #FFFFFF;
  --ds-surface-alt: #F6EEE7;
  --ds-surface-raised: #FFFFFF;
  --ds-surface-strong: #E9DDD3;

  --ds-foreground: #222222;
  --ds-muted: #A69486;
  --ds-muted-foreground: #70675F;

  --ds-border: #E4D8CE;
  --ds-border-strong: #D6C7BC;

  --ds-primary: #FF5A5F;
  --ds-primary-hover: #E34C51;
  --ds-primary-subtle: #FFE7E6;
  --ds-primary-foreground: #FFFFFF;

  --ds-accent: #384A42;
  --ds-accent-hover: #2D3D36;
  --ds-accent-subtle: #EBF0ED;

  --ds-product-accent: #C56F42;
  --ds-product-accent-hover: #A95E37;
  --ds-product-accent-subtle: #F8E9DF;

  --ds-success: #3E745D;
  --ds-warning: #AD7240;
  --ds-error: #C94C4C;
  --ds-info: #FF5A5F;
}
```

Rules:
- Use coral as the action color, not as a page background.
- Layout stays highly functional: simple cards, obvious filters, clear booking actions.
- This preset must remain friendly and sharp, not playful or bubbly.

#### 3.4.6 Elegant Dark

Use this for premium dark products influenced by `btrader.kr` and `werqon.com`, but translated into an uncodixfy system: muted, solid, low-gloss, and readable.

```css
[data-theme-preset="elegant-dark"] {
  --ds-bg: #111315;
  --ds-surface: #171A1D;
  --ds-surface-alt: #1D2125;
  --ds-surface-raised: #1B1F23;
  --ds-surface-strong: #242A30;

  --ds-foreground: #F1ECE5;
  --ds-muted: #7C746A;
  --ds-muted-foreground: #A79D91;

  --ds-border: #2A2F34;
  --ds-border-strong: #383E45;

  --ds-primary: #E0CFB6;
  --ds-primary-hover: #CDBA9C;
  --ds-primary-subtle: #292521;
  --ds-primary-foreground: #111315;

  --ds-accent: #9C6A3B;
  --ds-accent-hover: #85572F;
  --ds-accent-subtle: #241E19;

  --ds-product-accent: #8A8F83;
  --ds-product-accent-hover: #73786D;
  --ds-product-accent-subtle: #1D211E;

  --ds-success: #6F927A;
  --ds-warning: #C09152;
  --ds-error: #D47C68;
  --ds-info: #E0CFB6;
}
```

Rules:
- Dark means charcoal and graphite, not navy gradients or neon accents.
- Gold, bronze, or sage should be muted and matte.
- Avoid finance-dashboard clichés such as glowing charts, glass cards, cyan highlights, or pulse badges.

### 3.5 Product Accent Override (Optional)

Products may tune `--ds-product-accent` inside the active preset, but only within the palette family already chosen.
Do not introduce a new chroma direction just because a feature needs emphasis.

```css
/* Example: a travel product using the Belmond preset */
[data-theme-preset="belmond"][data-product="inmemorytrip"] {
  --ds-product-accent: #B34C45;
  --ds-product-accent-hover: #973F3A;
  --ds-product-accent-subtle: #FBEAE8;
}
```

### 3.6 Concept Families for New Services

Theme presets are token-level starting points. A product still needs a concept family that explains information architecture, density, tone, motion, and media. Pick one primary family per product and document it in `docs/product/06_HIGH_FIDELITY_DESIGN.md`.

| Concept Family | Local Reference | Best Fit | Visual Direction | Product Rules |
|----------------|-----------------|----------|------------------|---------------|
| Quant Terminal OS | `btrader`, `atrader` | Trading, analytics, model operations | Dark graphite, compact panels, mono data, restrained champagne/green/red states | Paper/simulation first, risk visible before action, no profit-guarantee language |
| Guided Expert Lab | `atrader` | AI/quant tools with novice and expert users | Clear mode separation, checklist onboarding, dense expert tabs behind progressive disclosure | Beginner mode hides JSON/threshold terms; expert mode groups controls by domain concept |
| Learning Arcade Lab | `malmoelab` | Language learning, habit loops, gamified education | Dark playful surfaces, XP/quest accents, high feedback density, clear progress tracks | Reward motion must support learning feedback, not distract from review flow |
| Field Decision Companion | `toop` | Travel, emergency interpretation, situational AI | Mobile-first, camera/media-first, trust score, source-backed answer cards | Show conclusion, evidence, source, confidence, and next action in that order |
| Memory Editorial Journey | `inmemorytrip` | Travel memory, albums, storytelling | Large real media, calm editorial rhythm, warm accent moments | Media must reveal actual place/memory; UI chrome stays quiet |
| Fashion Atelier Commerce | `wedding` | Wedding/evening dress commerce, brand storefronts | Elegant product photography, refined catalog grid, fitting/reservation cues | Product inspection, size/color/status, inquiry/purchase/rental flow must be immediate |
| Clinical Trust Workspace | `mediscent` and healthcare tools | Medical, clinic, care coordination | Light trustworthy surfaces, high contrast, calm status colors, audit-friendly layout | Avoid decorative ambiguity; expose source, timestamp, responsibility, and privacy state |
| Developer Ops Workspace | `connscent`, internal tools | Alerts, incidents, tasks, dashboards | Dense but calm operational shell, channel/event/task objects, clear severity lanes | Event lifecycle and ownership must be visible; do not bury ack/assign/resolve actions |

Concept selection checklist:

- Does the first viewport prove the service's real job?
- Does mobile navigation expose the top three repeated actions without horizontal overflow?
- Does the visual density match the user's work frequency and stress level?
- Are risky actions gated by state, permission, preview, or confirmation?
- Does the design leave room for SEO content only where the service needs public discovery?

### 3.7 Shared Geometry & Depth Tokens

Geometry and depth should remain constant across presets so the product changes mood without changing component behavior.

```css
:root {
  --ds-radius-sm: 8px;
  --ds-radius-md: 10px;
  --ds-radius-lg: 10px;
  --ds-radius-xl: 12px;

  --ds-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.04);
  --ds-shadow-md: 0 2px 8px rgba(0, 0, 0, 0.10);
  --ds-shadow-lg: 0 4px 12px rgba(0, 0, 0, 0.12);
}
```

---

## 4. Typography

### 4.1 Typography System Rules

- Each theme preset defines a typography profile, not just colors.
- A preset must specify `UI sans`, `body`, and `display` roles.
- Exact official brand fonts may be used only when licensing allows self-hosting or CDN delivery.
- If an official font is unavailable, use the approved fallback stack below rather than improvising a new one.
- Korean support must remain first-class. Every preset must pair its Latin font choice with `Pretendard` or another agreed Korean fallback.

### 4.2 Shared Font Tokens

```css
--ds-font-ui: 'Inter', 'Pretendard', -apple-system, BlinkMacSystemFont,
              'Segoe UI', Roboto, sans-serif;
--ds-font-body: 'Inter', 'Pretendard', -apple-system, BlinkMacSystemFont,
                'Segoe UI', Roboto, sans-serif;
--ds-font-display: 'Inter', 'Pretendard', -apple-system, BlinkMacSystemFont,
                   'Segoe UI', Roboto, sans-serif;
--ds-font-mono: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
```

### 4.3 Theme Typography Profiles

| Preset | UI Sans | Body | Display | Accent Usage |
|--------|---------|------|---------|--------------|
| **DevScent Core** | Inter + Pretendard | Inter + Pretendard | Inter | None |
| **Namu Heritage Green** | Pretendard + Inter | Pretendard + Inter | MaruBuri, fallback Cormorant Garamond + Pretendard | Cover titles, clan names, archival section headings only |
| **Aman Quiet Luxury** | Whitney / Whitney SSm, fallback Inter + Pretendard | Lyon Text Web, fallback Spectral + Pretendard | Lyon Display Web, fallback Cormorant Garamond + Pretendard | None |
| **Belmond Editorial Heritage** | Montserrat + Pretendard | Montserrat + Pretendard | Theano Didot, fallback Cormorant Garamond + Pretendard | Beyond Infinity only for tiny decorative labels |
| **Airbnb Friendly Utility** | Airbnb Cereal if licensed, else Inter + Pretendard | Inter + Pretendard | Inter | None |
| **Elegant Dark** | Inter + Pretendard | Inter + Pretendard | Newsreader or Inter | None |

### 4.4 Theme Typography Implementation

```css
:root[data-theme-preset="namu-heritage"] {
  --ds-font-ui: 'Pretendard', 'Inter', sans-serif;
  --ds-font-body: 'Pretendard', 'Inter', sans-serif;
  --ds-font-display: 'MaruBuri', 'Cormorant Garamond', 'Pretendard', serif;
}

:root[data-theme-preset="aman"] {
  --ds-font-ui: 'Whitney SSm A', 'Whitney SSm B', 'Inter', 'Pretendard', sans-serif;
  --ds-font-body: 'Lyon Text Web', 'Spectral', 'Pretendard', serif;
  --ds-font-display: 'Lyon Display Web', 'Cormorant Garamond', 'Pretendard', serif;
}

:root[data-theme-preset="belmond"] {
  --ds-font-ui: 'Montserrat', 'Pretendard', sans-serif;
  --ds-font-body: 'Montserrat', 'Pretendard', sans-serif;
  --ds-font-display: 'Theano Didot', 'Cormorant Garamond', 'Pretendard', serif;
}
```

Rules:
- Aman uses serif display and often serif body support; UI chrome remains quiet and never overly bold.
- Belmond uses sans for interface structure and body rhythm, with serif only for large headings and select editorial pull moments.
- Never use a decorative script or display face for buttons, forms, navigation, data tables, or body copy.
- If `Beyond Infinity` is licensed and loaded, limit it to micro-accent labels under 16px and never in all-caps blocks.

### 4.5 Wordmark Typography

Follows the DevScent logo standard:
- **Dev** — Inter Medium (500)
- **Scent** — Inter Bold (700)
- Letter-spacing: `-0.5px`

### 4.6 Type Scale

| Role | Size | Weight | Line Height | Tailwind |
|------|------|--------|-------------|----------|
| **Display** | 32px | 700 | 1.2 | `text-3xl font-bold` |
| **H1** | 28px | 700 | 1.2 | `text-2xl font-bold` |
| **H2** | 20px | 600 | 1.4 | `text-xl font-semibold` |
| **H3** | 16px | 600 | 1.5 | `text-base font-semibold` |
| **Body** | 15px | 400 | 1.5 | `text-[15px]` |
| **Body Small** | 14px | 400 | 1.5 | `text-sm` |
| **Caption** | 12px | 400 | 1.5 | `text-xs` |

### 4.7 Typography Rules

- Body text: `15px` on desktop, `16px` on mobile to prevent iOS auto-zoom.
- Headings use `font-bold` or theme-specific display styling. Subheadings use `font-semibold`.
- Maximum line length: `65ch` for content readability.
- Heading color: `--ds-foreground`. Body color: `--ds-foreground`. Muted: `--ds-muted`.
- No underlines except on links and only on hover.
- Belmond may run more aggressive heading contrast than Aman, but body density must remain readable.
- Aman should avoid tight tracking and excessive uppercase; Belmond may use restrained uppercase for metadata and nav.

---

## 5. Spacing & Layout

### 5.1 Grid System

**Base unit: 8px.**
All spacing, padding, margin, and gap values must be multiples of 8.

| Token | Value | Tailwind | Usage |
|-------|-------|----------|-------|
| `xs` | 4px | `p-1` | Icon padding, tight gaps |
| `sm` | 8px | `p-2` | Inline element spacing |
| `md` | 16px | `p-4` | Standard component padding |
| `lg` | 24px | `p-6` | Card padding, section gaps |
| `xl` | 32px | `p-8` | Page section spacing |
| `2xl` | 48px | `p-12` | Major section separators |
| `3xl` | 64px | `p-16` | Hero / landing spacing |

### 5.2 Standard Measures

| Element | Value |
|---------|-------|
| Card padding | 24px (`p-6`) |
| Section gap | 24px (`gap-6`) |
| Form field gap | 16px (`gap-4`) |
| Button padding | 12px 24px (`px-6 py-3`) |
| Input padding | 12px 16px (`px-4 py-3`) |

### 5.3 Responsive Breakpoints

| Breakpoint | Width | Behavior |
|------------|-------|----------|
| **Mobile** | < 640px | Single column, sidebar hidden, stacked layout |
| **Tablet** | 640 – 1024px | Collapsed sidebar (icons only), responsive grid |
| **Desktop** | 1024 – 1440px | Full sidebar, two-column content |
| **Wide** | > 1440px | Max-width container, centered |

### 5.4 Container

```
Max width:   1280px (content area)
Padding:     24px desktop, 16px mobile
Alignment:   mx-auto (centered)
```

---

## 6. Component Standards

### 6.1 Border Radius

| Component | Radius | Token | Tailwind |
|-----------|--------|-------|----------|
| **Cards / Panels** | 10px | `--ds-radius-lg` | `rounded-[10px]` |
| **Modals / Dialogs** | 12px | `--ds-radius-xl` | `rounded-xl` |
| **Buttons / Inputs** | 10px | `--ds-radius-md` | `rounded-[10px]` |
| **Tooltips / Popovers** | 8px | `--ds-radius-sm` | `rounded-lg` |
| **Tags / Badges** | 8px | `--ds-radius-sm` | `rounded-lg` |
| **Avatars** | 9999px | — | `rounded-full` |

### 6.2 Shadows

Subtle and restrained. Shadows provide depth hierarchy, not decoration.

| State | Light Mode | Dark Mode |
|-------|-----------|-----------|
| **Resting** | `var(--ds-shadow-sm)` | `var(--ds-shadow-sm)` |
| **Hover / Elevated** | `var(--ds-shadow-md)` | `var(--ds-shadow-md)` |
| **Modal / Overlay** | `var(--ds-shadow-lg)` | `var(--ds-shadow-lg)` |

Rules:
- Cards at rest use `--ds-shadow-sm` only.
- On hover, transition to `--ds-shadow-md` with `transition-shadow duration-150`.
- Never use colored shadows, glow, or decorative blur.
- Default shadow ceiling for standard UI is `0 2px 8px rgba(0,0,0,0.10)`.

### 6.3 Transitions & Motion

| Property | Duration | Easing |
|----------|----------|--------|
| Color, background, border | 150ms | `ease-in-out` |
| Transform, opacity | 200ms | `ease-out` |
| Layout (width, height) | 250ms | `ease-in-out` |

Rules:
- Respect `prefers-reduced-motion: reduce` and disable non-essential animations.
- Tailwind: `transition-colors duration-150` for interactive states.
- No bouncy or spring animations. Motion should feel precise, not playful.

### 6.4 Focus States

All focusable elements must display a visible focus ring:

```css
:focus-visible {
  outline: 2px solid var(--ds-primary);
  outline-offset: 2px;
}
```

Tailwind: `focus-visible:ring-2 focus-visible:ring-[var(--ds-primary)] focus-visible:ring-offset-2`

---

## 7. App Shell Layout

### 7.1 Structure

```
+──────────────────────────────────────────────────────+
│ Sidebar (fixed)  │  Header (sticky)                  │
│                  │  [Page Title]  ... [Lang][Theme][U]│
│  ┌────────────┐  ├──────────────────────────────────-─┤
│  │ Logo +     │  │                                    │
│  │ AppName    │  │  Content Area (scrollable)         │
│  │ [< / >]    │  │  ┌──────────────────────────────┐  │
│  ├────────────┤  │  │  max-w-6xl mx-auto           │  │
│  │ Nav Items  │  │  │  Card-based sections         │  │
│  │ (icon+lbl) │  │  │                              │  │
│  │            │  │  └──────────────────────────────┘  │
│  ├────────────┤  │                                    │
│  │ User Info  │  │                                    │
│  │ (popover)  │  │                                    │
│  └────────────┘  │                                    │
+──────────────────────────────────────────────────────+
```

### 7.2 Sidebar

| Property | Value |
|----------|-------|
| Width (expanded) | 256px |
| Width (collapsed) | 64px |
| Position | Fixed left, full viewport height |
| Background | `--ds-surface` |
| Border right | `1px solid var(--ds-border)` |
| Scroll | Non-scrolling (content area scrolls independently) |

**Sections:**
- **Top**: Logo + product name + collapse toggle (`<` / `>` chevron icon)
- **Middle**: Navigation items, icon (20px) + label. Active item uses `--ds-primary-subtle` background.
- **Bottom**: User avatar + name + role. Click opens popover with profile/logout.

**Collapsed State**: Icons only (centered). Tooltip on hover shows label.
**Mobile**: Hidden by default. Hamburger icon in header opens sidebar as overlay with backdrop.

### 7.3 Header Bar

| Property | Value |
|----------|-------|
| Height | 56px |
| Position | Sticky top within content scroll area |
| Background | `--ds-bg` with `backdrop-blur` |
| Border bottom | `1px solid var(--ds-border)` |

**Layout:**
- Left: Breadcrumb or page title
- Right: Language switcher, theme switcher, user quick actions

### 7.4 Content Area

- Only content area scrolls. Sidebar and header remain fixed.
- Layout: `max-w-6xl mx-auto` with `p-6` padding.
- Content organized in card-based sections using `--ds-surface`, `--ds-radius-lg`, and `--ds-shadow-sm`.

---

## 8. Component Directory

```
src/
├── components/
│   ├── ui/                        # Reusable UI primitives (design system)
│   │   ├── Button.tsx
│   │   ├── Input.tsx
│   │   ├── Card.tsx
│   │   ├── Modal.tsx
│   │   ├── Popover.tsx
│   │   ├── Dropdown.tsx
│   │   ├── Tabs.tsx
│   │   ├── Badge.tsx
│   │   ├── Avatar.tsx
│   │   └── Skeleton.tsx
│   │
│   └── app/                       # Product-specific composed components
│       ├── Sidebar.tsx
│       ├── Header.tsx
│       ├── Stepper.tsx
│       ├── UploadZone.tsx
│       └── LanguageSwitcher.tsx
│
├── styles/
│   └── globals.css                # --ds-* tokens, Tailwind base, theme definitions
│
└── lib/
    └── utils.ts                   # cn() helper (clsx + tailwind-merge)
```

---

## 9. Internationalization (i18n)

### 9.1 Rules — STRICT

- **Zero hardcoded strings.** All user-visible text must use i18n keys.
- Default language: `en-US`
- Supported: `en-US`, `ko-KR`
- Auto-discover locales via `messages/` directory.
- Key convention: `section.subsection.key` such as `sidebar.nav.dashboard`

### 9.2 File Structure

```
messages/
├── en.json
└── ko.json
```

### 9.3 Usage Pattern

```tsx
// Correct
const t = useTranslations('album');
return <h1>{t('title')}</h1>;

// Incorrect
return <h1>My Album</h1>;
```

---

## 10. Accessibility

| Standard | Requirement |
|----------|-------------|
| **WCAG Level** | AA minimum (AAA for critical text) |
| **Keyboard** | All interactive elements reachable via Tab |
| **Focus Ring** | Visible `2px solid var(--ds-primary)` ring on `:focus-visible` |
| **ARIA** | Labels on all icons, buttons, and interactive elements |
| **Contrast** | 4.5:1 normal text, 3:1 large text (18px+ bold or 24px+) |
| **Semantics** | Proper heading hierarchy (h1 > h2 > h3), landmark regions |
| **Motion** | Respect `prefers-reduced-motion` and disable non-essential animations |
| **Color Independence** | Never use color alone to convey status. Pair with icons or text |

---

## 11. Performance

| Metric | Target |
|--------|--------|
| **LCP** | < 2.5s |
| **INP** | < 200ms |
| **CLS** | < 0.1 |
| **Initial JS Bundle** | < 200KB |
| **Images** | `next/image` with WebP/AVIF, lazy loading |
| **Fonts** | `font-display: swap`, preload only used weights |

---

## 12. File Naming Conventions

| Type | Convention | Example |
|------|-----------|---------|
| **Components** | PascalCase | `UploadZone.tsx` |
| **Hooks** | camelCase with `use` prefix | `useTheme.ts` |
| **Utilities** | camelCase | `formatDate.ts` |
| **Constants** | UPPER_SNAKE_CASE | `MAX_FILE_SIZE` |
| **Types / Interfaces** | PascalCase | `TripAlbum.ts` |
| **Test Files** | `*.test.ts(x)` | `Button.test.tsx` |
| **CSS Modules** | kebab-case | `upload-zone.module.css` |
| **i18n keys** | dot.separated.lowercase | `album.step.upload` |

---

## 13. Code Quality

| Tool | Purpose | Config File |
|------|---------|-------------|
| **ESLint** | Linting | `eslint.config.js` |
| **Prettier** | Formatting | `.prettierrc` |
| **TypeScript** | Type safety (strict mode) | `tsconfig.json` |
| **Husky** | Git hooks | Pre-commit: lint + format + type-check |

---

## 14. Source Notes

- Aman signals were redefined from official site typography and palette references observed in `aman.com` CSS, including Whitney, Whitney SSm, Lyon Display Web, Lyon Text Web, and muted stone/sand color values.
- Belmond signals were redefined from official site typography and palette references observed in `belmond.com` CSS, including Montserrat, Theano Didot, Beyond Infinity, and high-contrast porcelain/black surfaces.
- Theme presets should capture the product behavior of those references, not clone them blindly. Layout, motion, and component behavior must still follow DevScent's uncodixfy baseline.
- Product planning guidance borrows from Shape Up's shaping/risk framing, Design Sprint's prototype-before-build habit, Agile Alliance's TDD/ATDD/BDD descriptions, and Fowler's refactoring/evolutionary design writing.
- Concept families were calibrated against local DevScent services: `btrader`, `atrader`, `malmoelab`, `toop`, `inmemorytrip`, `wedding`, `mediscent`, and `connscent`.

Reference links:

- Shape Up: https://basecamp.com/shapeup/1.1-chapter-02
- Shape Up risk review: https://basecamp.com/shapeup/1.4-chapter-05
- Design Sprint: https://www.character.vc/sprint
- TDD: https://agilealliance.org/glossary/tdd/
- ATDD: https://agilealliance.org/glossary/atdd/
- BDD: https://agilealliance.org/glossary/bdd/
- Refactoring: https://www.martinfowler.com/books/refactoring.html
- Evolutionary database design: https://www.martinfowler.com/articles/evodb.html

---

**Copyright (C) 2026 devscent.com. All rights reserved.**
This document is the single source of truth for DevScent product design decisions.
All implementations must conform to these standards.
