# Auto-Scroll & Streaming Chat Specification
> Extracted from Vercel AI SDK `@ai-sdk/react` and `ai-elements` package, plus the underlying
> `use-stick-to-bottom` library (v1.1.6, copyright StackBlitz).

> **2026-08-04：実物のソースと突き合わせて訂正済み**（`use-stick-to-bottom@1.1.6` の dist、
> ai-elements レジストリ 1.9.0、`@ai-sdk/react` の型定義）。突き合わせで見つかった誤りは
> 本文に反映した（選択中の扱い・ホイールの向き・初期状態・↓ボタンのアニメーション・
> `MessageResponse` の memo 比較）。
>
> **この文書は「参考にした実装の記録」であって、banto の仕様ではない。** §3（Streaming
> Content Rendering）・§5.3-5.5（PromptInput の内部）・§6.1（`useChat`）は AI SDK の
> transport 前提で、banto は独自 WS のため採らない。banto 側の仕様は
> [`docs/spec/chat-ui.md`](../spec/chat-ui.md) を見ること。

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
accumulated += velocity * (frameDelta / 16.67)
scrollTop += accumulated
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
*(閾値は無い。1px でも上へ動けばその場で外れる。70px は**再ロック**側の条件)*

**Mouse wheel UP** (`deltaY < 0`, inside scroll container) → `escapedFromLock = true`, `isAtBottom = false`
*(アニメーション中にホイールを上へ回すと、ブラウザ側がスクロールを取り消すことがあるため、
先に追従を外す。下へ回したときは何もしない)*

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

選択中の扱いは**経路によって違う**（訂正）:

- **スクロールイベント側**（`handleScroll`）: 選択中なら `escapedFromLock = true`, `isAtBottom = false`
  ——つまり**ロックは切れる**。選択しようとしているのに文字が流れ続けると、選択範囲がずれる
- **アニメーション側**（`scrollToBottom` の tick）: 選択中はスクロールを進めず次フレームへ回す
  （`if (isSelecting()) return next()`）。走っている追従が選択と喧嘩しない

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
// From: registry/default/ai-elements/message.tsx（1.9.0 の実物）
export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn("size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
      {...props}
    />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children
);
```

- Wraps the **Streamdown** markdown renderer
- Renders **every text part** from `useChat.messages` (incremental `part.text` chunks on each SSE arrival)
- 比較は `prevProps.children === nextProps.children` **だけ**（訂正。`isAnimating` の比較も
  `plugins` の指定も実物には無い）。文字が増えれば children が変わるので、そのときだけ再描画される
- Streamdown 側の依存に `remend`（未完 Markdown の補完）と `marked`（ブロック分割）が入っており、
  **ストリーミング中に記号が生で見えたり段落が崩れたりしない**のはこの2つによる
- Tailwind v4 前提（`tailwind-merge` / `clsx`）。banto は素の CSS なので Streamdown 本体は採らず、
  `remend` だけを react-markdown の前段に置いた

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
                    │  isAtBottom=true   │ ← 既定でロック済み
                    └────────┬───────────┘   (`useState(options.initial !== false)`。
                             │                `initial` はアニメーション種別で、
                    ┌────────▼───────────┐    false を渡したときだけ初期追従を切る)
                    │  LOCKED (auto)     │
                    │  isAtBottom=true   │
                    └────────┬───────────┘
                    ▲        │ user scrolls UP（閾値なし。上へ動いた時点で）
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
- **引数なしで呼ぶので、既定の spring アニメーション**（instant ではない。訂正）。0.3秒ほどかけて滑り降りる
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
- `max-h-48` = 12rem = **192px**（訂正）
- `min-h-16` = 4rem = **64px**（訂正）

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
