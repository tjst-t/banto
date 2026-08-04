# Auto-Scroll & Streaming Chat Specification
> Extracted from Vercel AI SDK `@ai-sdk/react` and `ai-elements` package, plus the underlying
> `use-stick-to-bottom` library (v1.1.6, copyright StackBlitz).

---

## 1. Architecture Overview

The Vercel AI SDK 5.0 **no longer manages scroll state internally** in `useChat`. The hook is now a thin
state wrapper using `useSyncExternalStore`. Scroll behavior is delegated entirely to the **`use-stick-to-bottom`**
library, which `ai-elements` exports as `Conversation`, `ConversationContent`, and `ConversationScrollButton`.

```
useChat (state, messages, sendMessage)
  └─ → use-stick-to-bottom (scroll coordination)
        ├─ ScrollLock (follow content)
        ├─ User scroll detection
        ├─ Resizer (content growth/shrinkage)
        └─ Spring animation (velocity-based)
```

---

## 2. Auto-Scroll: `use-stick-to-bottom`

### 2.1 Core Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `STICK_TO_BOTTOM_OFFSET_PX` | `70` | "Near bottom" threshold in pixels |
| `SIXTY_FPS_INTERVAL_MS` | `1000/60 ≈ 16.67` | Target frame interval for spring animation |
| `RETAIN_ANIMATION_DURATION_MS` | `350` | Hold-at-bottom duration after content resize |

### 2.2 Spring Animation Parameters (Default)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `damping` | `0.7` | 0 = no damping, 1 = fully damped. Controls energy loss per tick. |
| `stiffness` | `0.05` | Acceleration toward target per frame. |
| `mass` | `1.25` | Inertial mass, higher = slower animation. |

The velocity update per frame:

```
velocity = (damping * velocity + stiffness * scrollDifference) / mass
scrollTop += accumulated_accumulated
accumulated = velocity * (frameDelta / 16.67)
if scrollTop changed this frame: accumulated = 0
```

This is a **custom velocity-based spring solver**, not CSS `scroll-behavior: smooth` or easing-based durations.

### 2.3 Animation Modes

| Mode | `scrollTop` Assignment | Use Case |
|------|------------------------|----------|
| `"smooth"` | Spring animation (velocity-based) | Streaming new content |
| `"instant"` | Direct assignment | Scroll-to-bottom button |
| Custom object | Uses provided damping/stiffness/mass | Special timing needs |

The `Conversation` component sets **both** `initial="smooth"` and `resize="smooth"`.

### 2.4 Scroll Lock / Unlock Logic

The hook maintains these boolean flags:

- **`escapedFromLock`** — `false` = auto-scroll is enforced (locked to bottom), `true` = user took over
- **`isAtBottom`** — `true` = at bottom OR within 70px of bottom (`isNearBottom`)
- **`isNearBottom`** — `scrollDifference <= 70px` where `scrollDifference = calculatedTargetScrollTop - scrollTop`

**User scroll DOWN** → `escapedFromLock = false` (re-lock if `isNearBottom`)

**User scroll UP** → `escapedFromLock = true`, `isAtBottom = false`

**Mouse wheel DOWN** (inside scroll container) → `escapedFromLock = true`, `isAtBottom = false`
*(deliberately: browser-wheel up cancels stickiness even if logically scrolling down)*

**Programmatic scroll** → Sets `ignoreScrollToTop` to prevent false "user scroll" detection

### 2.5 Resize Handling (ResizeObserver)

When content height increases (`difference >= 0`):

1. `scrollToBottom({ animation, wait: true, preserveScrollPosition: true, duration: 350ms })`
   - The animation type is `"resize"` on subsequent grows, `"initial"` on first grow
   - `preserveScrollPosition: true` means `isAtBottom` is NOT forced to `true` — it follows the user
   - `wait: true` queues the scroll for next animation frame

When content height decreases (`difference < 0`):

1. If `isNearBottom` → `escapedFromLock = false`, `isAtBottom = true` (un-cancel lock)

**Important**: `resizeDifference` is tracked as a guard — if `scrollTop` arrives at the scroll handler while
a resize difference is still pending, the scroll event is ignored (1ms setTimeout delay resolves the race
between ResizeObserver and scroll events per WICG/resize-observer#25).

### 2.6 Text Selection Protection

`isSelecting()` returns `true` when:
1. `mouseDown` is `true` (set on `mousedown` / cleared on `mouseup` / `click`)
2. A text selection exists that intersects the scroll element

When selecting, the scroll lock is **not broken**. This prevents the auto-scroll from fighting text selection.

### 2.7 `scrollToBottom()` Options

| Option | Type | Default | Effect |
|--------|------|---------|--------|
| `animation` | `"smooth"` / `"instant"` / SpringAnimation object | Merged default | How to animate |
| `wait` | `true` / number (ms) / false | `false` | Defer scroll execution (next frame, or after delay) |
| `preserveScrollPosition` | boolean | `false` | If `true`, don't set `isAtBottom = true` (user position preserved) |
| `ignoreEscapes` | boolean | `false` | Don't let user scroll-up cancel the animation once started |
| `duration` | number (ms) \| Promise | `0` | After reaching bottom, stay there for this additional duration |

Returns `Promise<boolean>` — resolves `true` if scroll completed, `false` if cancelled (by user escape or re-trigger).

### 2.8 Edge Cases

1. **Safari**: Does not support `overflow-anchor` CSS. The use-stick-to-bottom library implements a custom
   scroll anchoring simulation, so it works on Safari.

2. **Race between scroll and resize events**: The `setTimeout(1ms)` guard in `handleScroll` prevents
   scroll events arriving before ResizeObserver updates from incorrectly triggering up-down cycles.

3. **Cascading scrolls**: If `scrollTop < calculatedTargetScrollTop` at the end of one animation tick,
   it schedules another `scrollToBottom` with the **resize** animation type to keep following content.

4. **Multiple simultaneous calls**: If `state.animation?.behavior === behavior`, the same promise is returned
   (`state.animation.promise`) — subsequent calls wait on the existing animation.

---

## 3. Streaming Content Rendering

### 3.1 `MessageResponse` (ai-elements)

```tsx
// From: packages/elements/src/message.tsx
export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn("size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
      plugins={streamdownPlugins}
      {...props}
    />
  ),
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    nextProps.isAnimating === prevProps.isAnimating
);
```

- Wraps the **Streamdown** markdown renderer
- Renders **every text part** from `useChat.messages` (incremental `part.text` chunks on each SSE arrival)
- Memoization compares: `(prev.children === next.children) && (next.isAnimating === prev.isAnimating)`
  - The `isAnimating` flag comes from Streamdown and tracks whether streaming is in progress
  - During streaming, memoization is bypassed because `isAnimating` changes every frame/tick
- Plugins: `cjk` (CJK text segmentation), `code` (syntax highlighting), `math` (KaTeX), `mermaid` (diagrams)
- Renders **complete markdown** on each tick (includes `parseIncompleteMarkdown: true` by default)

### 3.2 Text Wrapping

From the GeistDocs example chat implementation:

```tsx
<MessageResponse className="text-wrap">
  {part.text}
</MessageResponse>
```

The canonical example wraps text with `text-wrap` (Tailwind CSS `text-wrap: wrap`). Individual `UIMessage` parts are:

```tsx
message.parts
  .filter(part => part.type === "text")
  .map(part => <MessageResponse>{part.text}</MessageResponse>)
```

Each SSE token → text part update → full re-render of message content including partial text.

### 3.3 Message List Structure (Canonical Pattern)

```tsx
<Conversation>
  <ConversationContent>
    {messages.map(msg => (
      <Message from={msg.role} key={msg.id}>
        {msg.parts
          .filter(p => p.type === "text")
          .map(part => (
            <MessageContent key={part.type}>
              <MessageResponse>{part.text}</MessageResponse>
            </MessageContent>
          ))}
      </Message>
    ))}
    {status === "submitted" && <Spinner />}  {/* pending indicator */}
  </ConversationContent>
  <ConversationScrollButton />
</Conversation>
```

- Each message gets a single `Message` wrapper with `key={message.id}` (stable, from `generateId`)
- Assistant messages render `MessageResponse` in a loop over text parts
- The `Spinner` shows in place of an assistant message during `status === "submitted"` (request sent, stream not yet started)

---

## 4. User Scroll vs. Auto-Scroll Interaction

### 4.1 State Machine

```
                    ┌────────────────────┐
                    │  initialized       │
                    │  locked=false      │ ← initial state per `options.initial`
                    └────────┬───────────┘
                             │ user scrolls up
                    ┌────────▼───────────┐
                    │  LOCKED (auto)     │
                    │  isAtBottom=true   │
                    └────────┬───────────┘
                    ▲        │ user scrolls UP (past 70px)
                    │        ▼
                    │    ┌────────────────────┐
                    │    │  UNLOCKED (user)   │
                    │    │  escaped=true      │
                    │    │  isAtBottom=false  │
                    │    └────────┬───────────┘
                    │             │ user scrolls DOWN
                    │             │ within 70px
                    └─────────────┘
                             re-lock (if isNearBottom)
```

### 4.2 Scroll-to-Bottom Button (`ConversationScrollButton`)

```tsx
// Shown only when NOT at bottom
{!isAtBottom && (
  <Button onClick={scrollToBottom} variant="outline">
    <ArrowDownIcon />
  </Button>
)}
```

Calling `scrollToBottom()` from the button:
- Defaults to `animation: "instant"` (the button calls without params, which uses the default merged animation, typically instant)
- Sets `isAtBottom = true` (overrides preserved position)
- Does NOT set `preserveScrollPosition` (unlike resize handling)

### 4.3 Distinguishing Auto-Scroll from User-Sscroll

The library tracks this via the `ignoreScrollToTop` state:

1. When `state.scrollTop = target` (programmatic), it saves the old value to `state.ignoreScrollToTop`
2. In `handleScroll`, if `scrollTop >= ignoreScrollToTop`, it treats the scroll as belonging to the animation, not the user
3. This prevents "user escaped the lock" during the animation period

### 4.4 Scroll Events Race Guard

```
ResizeObserver fires → sets resizeDifference = Δheight
  ↓ (setTimeout 1ms delay)
Scroll event arrives → checks:
  - resizeDifference ≠ 0 → ignore (resize not yet processed)
  - scrollTop == ignoreScrollToTop → ignore (this scroll came from animation)
  - isSelecting() → break lock
  - isScrollingUp → break lock
  - isScrollingDown → restore lock if isNearBottom
```

---

## 5. Composer / Input Area

### 5.1 `PromptInputTextarea` Sizing

```tsx
<InputGroupTextarea
  className="field-sizing-content max-h-48 min-h-16"  // ≈ 192px max, 64px min
  name="message"
/>
```

- Uses CSS `field-sizing-content` (expands naturally)
- Max 3rem (48 × 4px = 192px) → ~10 rows
- Min 4rem (48px ≈ 64px) → 2 rows initially

### 5.2 Keyboard Behavior

| Key | Behavior |
|-----|----------|
| `Enter` | Submit form (`form.requestSubmit()`). Checks submit button is not disabled first. |
| `Shift+Enter` | New line (default textarea behavior preserved). |
| `Backspace` at empty textarea | Remove last attachment. |

IME (Input Method Editor) composition handled:
```tsx
// Composing → Enter does NOT submit
if (isComposing || e.nativeEvent.isComposing) { return; }
```

### 5.3 Paste Behavior

```tsx
onPaste: (event) => {
  for each item in clipboardData.items:
    if item.kind === "file":
      extract file → push to attachments array → event.preventDefault()
}
```

Pasted images are captured as `FileUIPart` objects (converted to `blob:` URLs, then to `data:` URLs on submit).

### 5.4 Attachments Flow

1. **Add**: Drag-and-drop on form, or file dialog, or paste → `FileUIPart[]` with `blob:` URLs in state
2. **Submit**: `onSubmit` handler:
   ```tsx
   // 1. Convert blob: → data: URLs (async, in parallel via Promise.all)
   const convertedFiles = await Promise.all(files.map(async ({ url }) => {
     if url.startsWith("blob:") url = await convertBlobUrlToDataUrl(url)
     return { ...file, url }
   }))
   // 2. Clear attachment state immediately (don't wait for response)
   clear()
   // 3. Call user-provided onSubmit({ text, files: convertedFiles }, event)
   ```

3. **Global drop**: `globalDrop` prop accepts files anywhere on `document` (not just form boundary)

### 5.5 `PromptInputProvider` (Optional Global State)

When wrapping multiple `PromptInput` instances (e.g., for switching models):

```tsx
<PromptInputProvider initialInput="pre-filled text">
  <PromptInput ... />
  {/* PromptInput can be remounted by key change to reset input */}
</PromptInputProvider>
```

- Exposes `controller.textInput.value`, `controller.textInput.setInput()`, `controller.textInput.clear()` globally
- Used by the `ChatInner` example to sync external prompt changes (e.g. from sidebar) to the input

### 5.6 `PromptInputSubmit` Button State

| Chat Status | Button Icon | Button Type | Disabled |
|-------------|-------------|-------------|----------|
| `ready` | CornerDownLeft (send) | `submit` | `!text` |
| `submitted` | Spinner | `submit` | N/A |
| `streaming` | Square (stop) | `button` (calls `stop()`) | N/A |
| `error` | X (close) | `submit` | N/A |

---

## 6. State Management Summary

### 6.1 `useChat` State (AI SDK 5.0)

```
messages: UIMessage[]           -- set via useSyncExternalStore on Chat store
status: ChatStatus              -- "ready" | "submitted" | "streaming" | "error"
error: Error | undefined        -- set via useSyncExternalStore on Chat store

setMessages(UIMessage[] | fn)   -- direct mutation of Chat.messages (for history restore, optimistic update)
sendMessage(msg, options?)      -- POST to transport API (triggers "submitted" → "streaming" → "ready")
stop()                          -- aborts current HTTP request
regenerate(options?)            -- re-sends all messages to regenerate last assistant response
resumeStream()                  -- reconnects to interrupted stream
addToolOutput(...)              -- provides tool result (may trigger sendAutomaticallyWhen)
```

The throttle mechanism:
```
throttle: number (ms)  -- callbacks to messages/status/error store are debounced
                        -- default: undefined (immediate)
```

### 6.2 StickToBottom State

```
scrollTop: number                    -- current scroll position
targetScrollTop: number              -- scrollHeight - 1 - clientHeight (theoretical bottom)
calculatedTargetScrollTop: number    -- may be customized via GetTargetScrollTop callback
scrollDifference: number             -- target - current
resizeDifference: number             -- current content height - previous content height

velocity: number                     -- spring animation velocity
accumulated: number                  -- spring animation accumulator
animation?: {                        -- active animation
  behavior: "smooth" | "instant" | SpringAnimation
  ignoreEscapes: boolean
  promise: Promise<boolean>
}
lastTick: number                     -- performance.now() of last animation tick

isAtBottom: boolean                  -- true if at bottom OR within 70px
isNearBottom: boolean                -- scrollDifference <= 70
escapedFromLock: boolean             -- false = auto-scroll is active
```

### 6.3 Conversation Content Wrapper

The `<Conversation>` component wraps content in `StickToBottom` with these defaults:

```tsx
<StickToBottom
  initial="smooth"    // first content growth uses spring animation
  resize="smooth"     // subsequent content growth uses spring animation
  className="relative flex-1 overflow-y-hidden"
  role="log"          // ARIA live region for screen readers
>
```

CSS on the viewport element (`ConversationContent` / `StickToBottom.Content`):
```css
scrollbarGutter: "stable both-edges"  /* reserve space for scrollbar to prevent layout shift */
```

---

## 7. Complete Integration Example

The canonical pattern (from `ai-elements` docs) is:

```tsx
// Frontend:
const { messages, sendMessage, status } = useChat({ /* options */ });

<Conversation>
  <ConversationContent>
    {messages.map(msg => (
      <Message from={msg.role} key={msg.id}>
        <MessageContent>
          {msg.parts.filter(p => p.type === 'text').map(part => (
            <MessageResponse key={part.type}>{part.text}</MessageResponse>
          ))}
        </MessageContent>
      </Message>
    ))}
    {status === 'submitted' && <Spinner />}
  </ConversationContent>
  <ConversationScrollButton />
</Conversation>

<PromptInput onSubmit={(msg) => sendMessage({ text: msg.text })}>
  {/* textarea, attachments, submit button */}
</PromptInput>
```

**Resulting behavior:**
1. On mount → auto-scroll to bottom (spring animation)
2. On SSE token arrival → new message content → content grows → ResizeObserver fires → spring animation scrolls to bottom (if locked)
3. On user scroll up past 70px → lock broken, scroll-to-bottom button appears
4. On user scroll down within 70px → lock restored, auto-scroll resumes
5. On scroll-to-bottom button click → instant snap to bottom
6. On `stop()` call → stream aborts, no scroll animation disruption
