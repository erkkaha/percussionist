# Notification Settings — Implementation Plan

**Task:** `percussionist-dev-plan-6aa06a`  
**Branch:** `feature/percussionist-dev-plan-6aa06a`

---

## Context

The Percussionist web app already has a notification system with synthesized drum sounds (Web Audio API) that fires on run/board state transitions. Currently, there is no way for users to control sound playback or preview the available sounds. All settings are cluster-wide via Kubernetes CRDs (`ClusterSettings/default`), but this feature requires per-user client-side preferences since Percussionist has no user accounts.

### Relevant existing code

| File | Purpose |
|------|---------|
| `packages/web/src/client/lib/notifications.ts` | Audio synthesis (`playDrum()`), browser notifications, history store |
| `packages/web/src/client/components/SettingsPage.tsx` | Tabbed settings UI (7 tabs: projects, agents, secrets, opencode, manager, runner, updates) |
| `packages/web/src/client/hooks/useRunNotifications.ts` | Fires notifications on run phase transitions |
| `packages/web/src/client/hooks/useBoardNotifications.ts` | Fires notifications on board task status changes |
| `packages/web/src/client/components/NotificationBell.tsx` | Bell icon + dropdown in header bar |

### Existing drum sounds (5 types)

- `"success"` — rimshot (noise burst + short ring at 320Hz)
- `"failure"` — low tom thud (68Hz sine with pitch drop to 30Hz)
- `"cancelled"` — muted cymbal (highpass noise burst at 6kHz)
- `"escalated"` — double hi-hat tick (two highpass noise bursts)
- `"running"` — short kick drum (90Hz sine with pitch drop to 30Hz)

---

## Approach

### Persistence Strategy: localStorage

Since Percussionist has no per-user accounts, notification preferences are stored client-side in `localStorage` under the key `percussionist:notifications`. This follows the existing pattern used by `SessionTimeline` (`percussionist:timeline:collapsed`). The preference shape:

```typescript
interface NotificationPreferences {
  soundEnabled: boolean; // default: true
}
```

### Sound Toggle Integration

The `notify()` function in `notifications.ts` will check the preference before calling `playDrum()`. A new exported function `getNotificationPreferences()` reads from localStorage, and a setter `setNotificationPreferences()` writes to it. The hooks (`useRunNotifications`, `useBoardNotifications`) do not need changes — they call `notify()` which now respects the setting.

### Sound Preview UI

The Notifications settings panel includes:
- A toggle switch for enabling/disabling notification sounds
- A list of all 5 drum sound types, each with a "Play" button that calls `playDrum(sound)` directly (bypassing the mute check so users can always preview)
- Brief descriptive labels for each sound type

### UI Pattern

Follows the existing SettingsPage tab pattern: add an `"notifications"` tab to the `Tab` union, render a `<NotificationsPanel />` component using Card/CardHeader/CardContent primitives. The panel is self-contained (no server API calls needed).

---

## Tasks

### Task 1: Add notification preference helpers to `notifications.ts`

**File:** `packages/web/src/client/lib/notifications.ts`

- Define `NotificationPreferences` interface with `soundEnabled: boolean`
- Add `NOTIFICATION_PREFS_KEY = "percussionist:notifications"` constant
- Implement `getNotificationPreferences(): NotificationPreferences` — reads from localStorage, returns `{ soundEnabled: true }` as default if not set or invalid
- Implement `setNotificationPreferences(prefs: Partial<NotificationPreferences>): void` — merges with existing prefs and writes to localStorage
- Modify `notify()` to check `getNotificationPreferences().soundEnabled` before calling `playDrum()`. If sounds are disabled, skip audio but still record history and dispatch the CustomEvent (so the bell icon still updates)

### Task 2: Add a Switch UI component

**File:** `packages/web/src/client/components/ui/switch.tsx`

- Install `@radix-ui/react-switch` via pnpm
- Create a shadcn/ui-style Switch component using Radix primitives, styled with existing design tokens (accent color for checked state, border/surface colors for unchecked)
- Follow the pattern of existing UI components (`button.tsx`, `input.tsx`) — use `Slot` for flex compatibility, accept standard props

### Task 3: Create NotificationsPanel component

**File:** `packages/web/src/client/components/NotificationsPanel.tsx` (new file)

- Read current preferences via `getNotificationPreferences()` on mount
- Render a `<Card>` with:
  - **Header**: "Notifications" title, description explaining sound settings
  - **Sound toggle row**: Label "Play notification sounds", Switch component bound to `soundEnabled`, save-on-change (write directly to localStorage — no server round-trip needed)
  - **Sound preview section** (rendered only when `soundEnabled` is true): A list of all 5 drum sound types, each showing:
    - Sound name (e.g. "Success") with a brief description (e.g. "Rimshot — played when a run succeeds")
    - A small "Play" button that calls `playDrum("success")` directly
- Use existing UI primitives: Card, Button, Switch, Separator

### Task 4: Wire NotificationsPanel into SettingsPage

**File:** `packages/web/src/client/components/SettingsPage.tsx`

- Add `"notifications"` to the `Tab` type union
- Add `{ id: "notifications", label: "Notifications" }` to the tabs array (position it after "runner" and before "updates")
- Import `<NotificationsPanel />` from the new component file
- Render conditionally: `{activeTab === "notifications" && <NotificationsPanel />}`

### Task 5: Verify typecheck and build

- Run `pnpm typecheck` to ensure no TypeScript errors
- Run `pnpm build` to confirm clean compilation
- Manual smoke test in browser (if cluster is available): navigate to Settings → Notifications tab, toggle sound on/off, verify preview buttons work, verify actual notifications respect the setting

---

## Risks / Open Questions

1. **AudioContext resume**: Browsers require a user gesture before AudioContext can play audio. The existing `playDrum()` already handles this with `ctx.resume()`. The preview "Play" buttons will serve as valid user gestures, so this should work fine. No change needed.

2. **Switch component dependency**: Adding `@radix-ui/react-switch` is a new dependency. Alternative: build a CSS-only toggle using a styled checkbox input. The Radix approach is more idiomatic for the shadcn/ui stack and provides better accessibility (keyboard support, ARIA attributes).

3. **Mobile experience**: The sound preview buttons should be touch-friendly on mobile. Use existing responsive patterns from SettingsPage (`sm:` breakpoints).

4. **No server persistence**: Preferences are localStorage-only and will not survive browser data clearing or cross-device usage. This is acceptable given the app has no user accounts. If per-user persistence becomes a requirement later, it would need a database table + auth system.

---

## Acceptance Criteria

- [ ] A "Notifications" tab appears in Settings alongside existing tabs
- [ ] The panel shows a toggle to enable/disable notification sounds
- [ ] Toggling the switch immediately affects whether `notify()` plays audio (no page reload needed)
- [ ] All 5 drum sound types are listed with descriptive labels and playable preview buttons
- [ ] Preview buttons play sounds regardless of the mute setting (so users can always familiarize themselves)
- [ ] The preference persists across page reloads via localStorage
- [ ] Default state is `soundEnabled: true` (backward compatible — existing behavior preserved)
- [ ] Code passes `pnpm typecheck` and `pnpm build`
