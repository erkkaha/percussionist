# Design System — Technical Precision

## Personality

Minimalist, technical, high-fidelity developer environment. Deep focus, precision,
architectural stability. Dark-only theme inspired by high-end IDEs and
mission-critical dashboards.

## Typography

| Font | Usage | Tailwind class |
|------|-------|----------------|
| **Geist** | All UI text: headlines, body, buttons, navigation, content | `font-sans` (default on `<body>`) |
| **JetBrains Mono** | Labels, badges, code blocks, technical identifiers | `font-mono` (opt-in) |

### Scale

| Token | Size | Weight | Line-height | Letter-spacing |
|-------|------|--------|-------------|----------------|
| `text-headline-lg` | 24px | 600 | 32px | -0.02em |
| `text-headline-md` | 20px | 600 | 28px | — |
| `text-body-lg` | 16px | 400 | 24px | — |
| `text-body-sm` | 14px | 400 | 20px | — |
| `text-label-md` | 12px | 500 | 16px | 0.05em |
| `text-code-block` | 13px | 400 | 20px | — |

### Font Logic

- **Labels describe things** → JetBrains Mono (`text-label-md font-mono uppercase`)
  - Section headers, metadata labels, badges, tags, column headers
- **Content is the thing** → Geist (default `font-sans`)
  - Task titles, descriptions, data values, event descriptions
- **Technical identifiers** → JetBrains Mono (`font-mono text-xs`)
  - Run names, task names, git branches, timestamps
- **Interactive controls** → Geist (default `font-sans`)
  - Buttons, filter pills, links
- **Code** → JetBrains Mono (`font-mono`)
  - Inline code, code blocks

## Colors

Cool midnight base with gold accents. Full Material 3-inspired palette.

### Surfaces

| Token | Value | Purpose |
|-------|-------|---------|
| `--surface` | `#111317` | Main page background |
| `--surface-dim` | `#111317` | Same as surface |
| `--surface-bright` | `#37393e` | Bright elevated surface |
| `--surface-container-lowest` | `#0c0e12` | Deepest layer |
| `--surface-container-low` | `#1a1c20` | Subtle container |
| `--surface-container` | `#1e2024` | Default container (cards) |
| `--surface-container-high` | `#282a2e` | Elevated container (buttons) |
| `--surface-container-highest` | `#333539` | Highest container |
| `--surface-variant` | `#333539` | Variant surface |
| `--on-surface` | `#e2e2e8` | Text on surfaces |
| `--on-surface-variant` | `#d5c4b2` | Muted text |

### Brand / Accent

| Token | Value | Purpose |
|-------|-------|---------|
| `--primary` | `#ffc67d` | Bright gold accent |
| `--primary-container` | `#e8a852` | Container accent (buttons) |
| `--on-primary` | `#462a00` | Text on accent |
| `--accent` | `#e8a852` | Legacy alias for primary-container |

### Semantic

| Token | Value | Purpose |
|-------|-------|---------|
| `--tertiary` | `#58ea8a` | Success states |
| `--error` | `#ffb4ab` | Error states |
| `--outline` | `#9e8e7e` | Borders, dividers |
| `--outline-variant` | `#514537` | Subtle borders |
| `--border` | `#514537` | Legacy alias for outline-variant |

### Phase Status

| Token | Value |
|-------|-------|
| `--phase-pending` | `#fbbf24` |
| `--phase-initializing` | `#fb923c` |
| `--phase-running` | `#e8a852` |
| `--phase-succeeded` | `#58ea8a` |
| `--phase-failed` | `#ffb4ab` |
| `--phase-cancelled` | `#514537` |

### Sidebar

| Token | Value |
|-------|-------|
| `--sidebar` | `#1a1c20` |
| `--sidebar-foreground` | `#e2e2e8` |
| `--sidebar-primary` | `#e8a852` |
| `--sidebar-border` | `#514537` |
| `--sidebar-ring` | `#e8a852` |

## Rounded Corners

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | 0.125rem (2px) | — |
| `--radius` | 0.25rem (4px) | **Standard**: buttons, inputs, badges, tags |
| `--radius-md` | 0.375rem (6px) | — |
| `--radius-lg` | 0.5rem (8px) | Large containers |
| `--radius-xl` | 0.75rem (12px) | — |
| `--radius-full` | 9999px | Scrollbar thumbs only |

**Rule**: Standard shape is **strictly 4px**. Large containers may use 8px.
No pill shapes for UI elements. Bar charts and progress bars are `rounded-none`.

## Spacing

| Token | Value | Tailwind equivalent |
|-------|-------|---------------------|
| `--spacing-margin-page` | 24px | `p-6` |
| `--spacing-gutter-grid` | 16px | `gap-4` |
| `--spacing-padding-card` | 16px | `p-4` |
| `--spacing-gap-sidebar` | 12px | `gap-3` |
| `--spacing-stack-sm` | 8px | `gap-2` |
| `--spacing-stack-md` | 16px | `gap-4` |
| `--spacing-stack-lg` | 32px | `gap-8` |

## Elevation

No drop shadows. Depth via tonal layering and thin borders:

- **Base layer**: `--surface` (`#111317`)
- **Surface layer**: Cards use `--surface-container` (`#1e2024`) or 1px `--outline-variant` border
- **Active/hover**: `--surface-container-high` (`#282a2e`) background or accent left-border
- **Code blocks**: `--surface-container-lowest` (`#0c0e12`) for a sunken feel

## Components

### Buttons
- **Primary**: `bg-accent text-surface hover:bg-accent/80`, 4px radius, no shadow
- **Secondary**: `bg-surface-container-high text-text hover:bg-surface-container-highest`
- **Ghost**: `text-text-dim hover:bg-surface-overlay hover:text-text-muted`
- **Outline**: `border border-border-muted text-text-dim hover:border-border hover:text-text-muted`

### Badges
`text-label-md font-mono uppercase` with 4px radius. Color-coded by phase:
pending (yellow), running (gold), succeeded (green), failed (red), cancelled (grey).

### Task Cards
1px border (`--outline-variant`), title + status badges. Active state uses
accent-tinted background at 5-10% opacity.

### Inputs
Dark background (`--surface`), 1px border (`--border`), 4px radius.
Focus: 1px accent border (no glow ring).

### Sidebar
Flat design with vertical separator bar. No rounded corners, no group labels,
no resize handle. Collapsed state (icon mode): 48px width, centered icons.

## Font Loading

Geist Sans and JetBrains Mono loaded from jsDelivr CDN via `<link>` tags in
`index.html`:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/geist-sans@5/index.css" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/jetbrains-mono@5/index.css" />
```

## Implementation

All design tokens are CSS custom properties in `:root` and mapped to Tailwind v4
theme via `@theme` in `src/client/index.css`. Components use Tailwind utility
classes only (no CSS modules, no styled-components).
