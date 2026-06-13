# Plan: Render structured option blocks as interactive chat buttons

## Context

Relevant existing code and behavior:

- `packages/web/src/client/components/AgentChatPanel.tsx`
  - Renders manager chat messages from SSE/history using a local `ChatMessage` type (`role`, `text`, `id`, `created`).
  - Current assistant rendering is plain text (`<div>{msg.text}</div>`) with `whitespace-pre-wrap`; no markdown parsing and no structured text block handling.
  - Sending logic is centralized in `sendText(text: string)` and reused by form submit (`handleSend`) and external task injection (`onChatReady.injectTask`).
- `packages/web/src/client/components/ui/button.tsx` and `ui/card.tsx`
  - Existing reusable primitives already provide accessible button semantics and styling variants.
- Manager decision-agent prompt currently lives in `k8s/deploy/agent-config.yaml` (`manager-decision.md` entry), not under `k8s/agents/`.
  - Prompt currently requests JSON in some contexts and clear prose for operator chat, but does not yet instruct the `[!options]` block convention.

Gap to close:

- The chat UI cannot convert structured agent options into interactive controls, so operators must manually type replies.

## Scope boundaries

In scope:

- Client-side parsing of `[!options]...[!/!options]` blocks in manager chat message text.
- Interactive option button rendering in `AgentChatPanel`.
- Reusing existing send path to submit selected option key as a user message.
- Prompt guidance update so decision/manager agent emits the structured format when offering choices.

Out of scope:

- Backend/API/MCP changes.
- Supporting other custom block syntaxes beyond `[!options]` with `[!option ...]` lines.
- Persisting selected state across reloads.

## Approach

1. **Add a focused parser utility** in `packages/web/src/client/lib/chat-utils.ts`.
   - Define an exported `OptionDef` type (`key`, `label`, optional `description`).
   - Implement `parseOptionBlocks(text: string): { options: OptionDef[]; cleanText: string }`.
   - Behavior:
     - Detect one or more `[!options]...[/!options]` blocks.
     - Parse each `[!option ...]` line attributes (`key`, `label`, optional `description`) with robust quoted-attribute extraction.
     - Return concatenated valid options and text with successfully parsed blocks removed.
   - Graceful degradation:
     - If no block exists: return unchanged text + empty options.
     - If a block is malformed or yields no valid options: keep original text unchanged so raw tags remain visible.

2. **Introduce an option card component** (`packages/web/src/client/components/ChatOptionCard.tsx`).
   - Props: `options: OptionDef[]`, `onSelect: (key: string) => void`, optional disabled state.
   - Render as a compact card under assistant text with vertically stacked buttons.
   - Use semantic `<button type="button">` (or shared `Button`) for native keyboard support (Tab + Enter/Space).
   - Include optional muted description text under each label.
   - Keep mobile-friendly spacing and hit targets; no fixed widths.

3. **Wire into message rendering in `AgentChatPanel`**.
   - Parse assistant message text before render.
   - If parsed options exist:
     - Render `cleanText` as normal message text.
     - Render `<ChatOptionCard>` below it.
     - Button click calls existing `sendText` with canonical payload: `I choose option ${key}` (or `I choose option [${key}]` if team prefers exact bracketed form; align in implementation).
   - Keep behavior unchanged for user/system messages and assistant messages without option blocks.
   - While `sending` is true, disable option buttons to prevent duplicate sends.

4. **Update manager decision-agent prompt guidance** in `k8s/deploy/agent-config.yaml`.
   - In `manager-decision.md` operator-chat instructions, add explicit rule: when presenting actionable choices, emit the structured options block format.
   - Include a concise canonical example matching the UI parser contract.
   - Preserve existing constraints (no emoji/special characters beyond required tags).

## Acceptance criteria mapping

1. **Structured block renders as buttons**
   - `AgentChatPanel` shows option card for properly formatted assistant message blocks.
2. **Click sends chosen key**
   - `onSelect` delegates to `sendText(...)` and appends a user message through existing flow.
3. **Backward compatibility**
   - Messages with no options render exactly as before.
   - Parse failures leave raw text/tags visible.
4. **Desktop + mobile**
   - Card/button layout uses responsive utility classes and existing bubble width constraints.
5. **Keyboard accessibility**
   - Buttons remain native focusable controls with Enter/Space activation.

## Proposed BUILD task breakdown

1. **Create parser utility and types**
   - Add `packages/web/src/client/lib/chat-utils.ts` with `OptionDef` and `parseOptionBlocks`.
   - Cover attribute parsing edge cases (missing key/label, malformed quotes, extra whitespace).

2. **Add `ChatOptionCard` component**
   - Create `packages/web/src/client/components/ChatOptionCard.tsx`.
   - Implement card structure, button list, optional description, and disabled styling.

3. **Integrate parsing/rendering in `AgentChatPanel`**
   - Import parser and component.
   - Parse assistant text inline during message map.
   - Render clean text + option card; wire `onSelect` to `sendText` and disable during send.

4. **Prompt contract update for manager decision agent**
   - Edit `k8s/deploy/agent-config.yaml` (`manager-decision.md` block) with explicit `[!options]` usage instruction and example.

5. **Verification pass (manual UI checks)**
   - Send/seed assistant message with valid option block.
   - Verify button rendering + click submit behavior.
   - Verify malformed block shows raw tags.
   - Verify keyboard navigation/activation and mobile viewport behavior.

## Risks / open questions

- **Message payload exact string**: spec says equivalent to typing “I choose option [key]”; confirm whether brackets are required (`[key]`) or plain key is preferred for downstream prompt parsing.
- **Multiple option blocks in one message**: plan assumes parser can aggregate all blocks; UI should clarify ordering if multiple cards are needed (single merged card is likely simplest).
- **Quoted attribute escaping**: initial parser can assume simple double-quoted values; escaped quotes inside labels may be unsupported unless explicitly required.
- **Agent prompt location ambiguity**: user referenced `k8s/agents/manager-decision.yaml`, but current source of truth appears to be `k8s/deploy/agent-config.yaml` ConfigMap entry.

## Assumptions

- Interactive option rendering applies to assistant messages in `AgentChatPanel` (manager chat), not session transcript views.
- The parser only needs to support the exact documented tag format and attributes (`key`, `label`, optional `description`).
- No automated frontend test harness currently exists in `packages/web/src/client`; verification is primarily manual unless BUILD chooses to add tests separately.
