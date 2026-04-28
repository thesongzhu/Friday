# Friday Guide Mode / Guide Lens Design

## Status

Implemented MVP for the macOS native companion path.

The shipped slice includes the read-only Guide Lens domain service, HTTP API,
agent tool, macOS companion guide overlay RPC, native blue focus-frame overlay,
settings-page avatar controls, screenshot-intake heuristics, redaction, target
resolution, optional loopback parser adapter, and verification tests.

Remaining future work is higher-fidelity perception: real Accessibility element
tree harvesting beyond the current system/window snapshot bridge, richer
OmniParser/Midscene health/ranking, and broader Windows/Linux native overlay
ports.

Guide Mode is the user-facing product name. `guide_lens` is the internal
capability name.

Guide Mode lets Friday understand the user's visible interface and guide the
user through human-only actions without clicking, typing, or mutating the
desktop itself.

The product promise is:

```text
Friday can see enough to help, but the user stays in control of the real input.
```

## Why This Exists

Full computer-use agents are useful, but they create a trust gap for ordinary
users. Users worry that an agent may click the wrong control, type into the
wrong app, approve something sensitive, or get stuck in an account, CAPTCHA, or
payment flow.

Guide Mode gives Friday a safer middle mode:

1. Read the screen and local UI metadata.
2. Convert the visible state into a compact UI map.
3. Decide what the user should do next.
4. Draw a non-mutating guide overlay.
5. Let the user perform the real click, typing, approval, or account action.
6. Observe again and verify progress.

This should make Friday feel like it is helping operate the computer while
keeping the physical interaction human-owned.

## Prior Art

- OmniParser parses screenshots into structured UI elements with bounding boxes
  and semantic labels, improving visual grounding for GUI agents:
  https://github.com/microsoft/OmniParser and
  https://arxiv.org/abs/2408.00203
- UI-TARS shows the full automated GUI-agent direction, including screenshot-only
  perception, grounding, and action modeling:
  https://github.com/bytedance/UI-TARS and
  https://arxiv.org/abs/2501.12326
- UI-TARS Desktop and Agent TARS package the native desktop/browser operator
  experience:
  https://github.com/bytedance/UI-TARS-desktop
- Midscene.js provides vision-driven UI automation and emphasizes pure-vision
  localization, caching, and lower token cost by skipping DOM for actions:
  https://github.com/web-infra-dev/midscene
- Driver.js, Shepherd, and React Joyride provide mature product-tour patterns:
  focus overlays, popovers, portals, target tracking, focus handling, and guided
  steps:
  https://driverjs.com/
  https://www.shepherdjs.dev/
  https://react-joyride.com/
- Human-in-the-loop computer-use discussions repeatedly identify CAPTCHA,
  ambiguous UIs, and environment-specific context blindness as practical failure
  points for autonomous agents:
  https://www.reddit.com/r/aiagents/comments/1n3fkf6/human_in_the_loop_for_computer_use_agents_instant/
  https://www.reddit.com/r/LocalLLaMA/comments/1qcfxk0/computer_use_agents_are_smart_but_they_dont_know/

Guide Lens borrows screen parsing and grounding from GUI agents, but deliberately
does not borrow autonomous input control for this mode.

## Product Principles

1. Read deeply, do not mutate.
   Guide Lens may use broad read permissions, including Accessibility metadata,
   screen capture, OCR, window inventory, and app/window state. It must not use
   input injection, clipboard writes, file writes, app launch, app close, or
   destructive system intents inside this mode.

2. Human-owned final action.
   When the task reaches login, CAPTCHA, payment, permission approval, sensitive
   account state, or uncertain UI grounding, Friday asks the user to act and
   shows exactly where.

3. Token thrift by default.
   Friday should avoid sending full screenshots to the LLM unless needed. The
   default context should be a compact UI map plus small cropped regions for
   ambiguous icons.

4. Confidence visible to the system.
   Every suggested target must carry source, confidence, alternatives, and
   verification criteria.

5. Universal first, integrated when possible.
   For web surfaces Friday may use DOM or Playwright snapshots. For native apps
   Friday may use Accessibility. For canvas, remote desktops, videos, and unknown
   apps Friday falls back to screenshot parsing.

6. Ordinary-user UX.
   The user should not need to know whether Friday used OCR, Accessibility,
   screen parsing, DOM, or a model. They should see clear visual guidance and a
   short instruction.

## Resolved Product Decisions

- User-facing name: Guide Mode / 引导模式.
- Internal capability name: `guide_lens`.
- First product target: macOS Native Companion Overlay.
- Default avatar: neutral grey circular avatar with a centered `F`.
- Avatar customization: user may choose a local profile image; this must be
  wired into Friday profile/settings so the same chosen image can be reused by
  the companion bubble.
- Visual tone: restrained premium AI assistant, not playful cartoon UI.
- Permission boundary: read-maximal, write-zero. Accessibility read and Screen
  Recording are allowed; desktop input actions are forbidden in Guide Mode.

## Scope

### In Scope

- Read-only screen capture and window/app inventory.
- Read-only Accessibility element tree and text when available.
- OCR and icon detection for visible screenshots.
- Optional OmniParser-style local parser service.
- Optional Midscene-style visual localization service.
- Compact UI map generation and caching.
- Guide overlay with blue focus frame, virtual cursor, labels, candidate marks, and
  short instructions.
- Agent handoff flow for actions Friday should not perform.
- Post-action read-only verification.
- Audit events and user-visible evidence.

### Out Of Scope For This Mode

- Autonomous click, type, drag, scroll, keypress, clipboard write, file write, app
  launch, app close, notification action, payment, account creation, CAPTCHA
  solving, or permission approval.
- Bypassing platform rules or security controls.
- Hidden screenshots or hidden screen uploads.
- Training model weights from user screens.

Existing Friday desktop control may still support mutating actions under its own
policy gates. Guide Lens is a separate non-mutating capability profile.

## Mode Differences And Generalization

There are three possible surfaces. They should all share the same UI map and
overlay command protocol.

### 1. Web Overlay

Runs inside Friday's own React UI or a browser page that Friday controls.

Pros:

- Easiest to ship.
- Best target precision on Friday pages and controlled browser sessions.
- Can use DOM, accessibility tree, Playwright snapshots, and CSS selectors.
- No native overlay permissions needed.

Cons:

- Does not help in arbitrary native apps.
- Cannot draw over other desktop windows.
- Less magical for ordinary users because it only works in known browser
  contexts.

Best for:

- MVP.
- Friday setup wizard.
- Provider key setup pages opened in a visible browser.
- Browser automation handoff.

### 2. Native Companion Overlay

Runs as part of Friday's desktop companion and draws above the user's active
desktop without consuming real clicks.

Pros:

- Most universal and most "assistant beside me" feeling.
- Works across native apps, browser windows, installers, settings, and account
  dialogs.
- Can guide human-only operations without giving Friday input authority.

Cons:

- Needs platform-specific overlay implementation.
- Needs screen recording and Accessibility permissions.
- More engineering and QA burden across macOS, Windows, and Linux.

Best for:

- The real product experience.
- Login/CAPTCHA/OAuth/payment/permission handoffs.
- Native app setup and troubleshooting.

### 3. Remote Session Overlay

Runs inside a remote browser, VM, sandbox, or mobile stream.

Pros:

- Good for cloud/sandbox workflows.
- Can be recorded and replayed for debugging.
- Easier to test deterministically than a user's live desktop.

Cons:

- Less helpful for the user's actual local app state.
- Needs session streaming infrastructure.

Best for:

- Future cloud agent and QA workflows.
- Training/eval capture.

### Recommendation

Ship in this order:

1. macOS Native Companion Overlay for local desktop guidance.
2. Friday-controlled visible Chrome support through the same native overlay.
3. Friday web overlay only as a lightweight fallback when the native companion is
   unavailable.
4. Windows/Linux native overlays.
5. Remote session overlay.

The product should present all of these as one feature: "Guide me". The runtime
chooses the strongest available surface and explains only when a permission is
missing.

The first real product target is the native companion overlay. Web overlay is
useful for tests and fallback behavior, but it should not define the product
experience. Ordinary users should experience Friday as a small local assistant
that appears on top of the app they are already using.

## Permission Model

Guide Lens uses a read-maximal, write-zero profile.

Allowed permissions:

- Screen Recording / screen capture.
- Accessibility read access: element role, title, value, bounds, enabled state,
  selected state, focused state, hierarchy, and app/window ownership.
- Window inventory and frontmost app detection.
- Browser accessibility/DOM snapshots where Friday owns the browser session.
- OCR on local screenshots.
- Local parser sidecar calls.
- Optional user-approved remote parser/model calls only after explicit
  configuration.

Forbidden in Guide Lens:

- Click, double-click, drag, scroll, type, keypress.
- Clipboard write.
- File write/move/delete/copy.
- App launch, app close, window move, window resize.
- Notification action.
- System settings mutation.
- Shell commands except those required to run the local read-only parser service
  during setup or health checks.

Important implementation rule:

Guide Lens should not call Friday's existing mutating desktop `execute` action.
It should use separate read-only service interfaces and typed tool names so that
policy can enforce the boundary mechanically.

## Architecture

```text
User goal
  -> agent runtime
  -> Guide Lens planner
  -> read-only screen snapshot
  -> UI map builder
  -> target resolver
  -> overlay command
  -> user performs real action
  -> read-only verification
  -> continue task or ask again
```

### Components

1. `guide_lens` agent tool
   Read-only tool exposed to the agent runtime. It returns UI maps, target
   candidates, and overlay command results. It cannot mutate the desktop.

2. Screen Snapshot Service
   Captures current visible screen state and app/window metadata.

3. Accessibility Snapshot Service
   Reads element metadata from the active app/window when OS permissions allow.

4. UI Map Builder
   Merges Accessibility, DOM/Playwright snapshot, OCR, icon parser, and vision
   parser output into a deduplicated list of UI elements.

5. Parser Adapter Registry
   Supports built-in parsers and optional sidecars:
   - `accessibility`
   - `browser_snapshot`
   - `ocr`
   - `omniparser`
   - `midscene_like`
   - `vlm_crop_caption`

6. Target Resolver
   Finds the best target for a user instruction. It returns one primary target,
   alternatives, confidence, and why it chose them.

7. Overlay Renderer
   Draws non-interactive guidance over the target surface.

8. Verification Loop
   Observes after the user acts and checks whether the expected state appeared.

## Data Model

### UI Map

```ts
interface FridayGuideLensUiMap {
  id: string;
  capturedAt: string;
  surface: "friday_web" | "browser" | "native_desktop" | "remote_session";
  platform: "darwin" | "win32" | "linux" | "browser" | "unknown";
  screen: {
    width: number;
    height: number;
    scaleFactor: number;
    activeApp?: string;
    activeWindowTitle?: string;
  };
  elements: FridayGuideLensElement[];
  redactions: FridayGuideLensRedaction[];
  parserStats: FridayGuideLensParserStats[];
}
```

### UI Element

```ts
interface FridayGuideLensElement {
  id: string;
  bbox: { x: number; y: number; width: number; height: number };
  role:
    | "button"
    | "link"
    | "text"
    | "input"
    | "checkbox"
    | "radio"
    | "menu"
    | "menu_item"
    | "tab"
    | "icon"
    | "image"
    | "dialog"
    | "unknown";
  label?: string;
  valuePreview?: string;
  iconCaption?: string;
  state?: {
    enabled?: boolean;
    selected?: boolean;
    focused?: boolean;
    checked?: boolean;
    visible?: boolean;
  };
  source: Array<
    | "accessibility"
    | "browser_snapshot"
    | "ocr"
    | "omniparser"
    | "midscene_like"
    | "vlm_crop"
  >;
  confidence: number;
  interactable: boolean;
  sensitive: boolean;
  stableKey?: string;
}
```

### Target Candidate

```ts
interface FridayGuideLensTargetCandidate {
  elementId: string;
  bbox: { x: number; y: number; width: number; height: number };
  instruction: string;
  reason: string;
  confidence: number;
  alternatives: Array<{
    elementId: string;
    reason: string;
    confidence: number;
  }>;
  verifyAfterUserAction: {
    expectedText?: string;
    expectedElementRole?: string;
    expectedUrlPattern?: string;
    expectedApp?: string;
    timeoutMs: number;
  };
}
```

### Overlay Command

```ts
interface FridayGuideLensOverlayCommand {
  id: string;
  mode:
    | "avatar_bubble"
    | "focus_frame"
    | "cursor_ghost"
    | "speech_bubble"
    | "numbered_marks"
    | "arrow"
    | "scroll_hint"
    | "page_transition"
    | "sidecar"
    | "candidate_picker"
    | "confirm_step"
    | "clear";
  target?: {
    bbox: { x: number; y: number; width: number; height: number };
    elementId?: string;
  };
  message?: string;
  avatar?: {
    imageUri?: string;
    fallbackGlyph: "F";
    source: "default_f" | "friday_profile" | "custom_local";
    status: "idle" | "looking" | "guiding" | "waiting" | "checking" | "blocked";
  };
  step?: {
    index: number;
    total?: number;
    title?: string;
    body: string;
    expectedUserAction?: string;
  };
  tone: "neutral" | "safe" | "warning" | "blocked";
  interactionPolicy: "click_through" | "overlay_controls_only";
  expiresAt?: string;
  style?: FridayGuideLensOverlayStyle;
}
```

### Avatar Preference

```ts
interface FridayGuideLensAvatarPreference {
  source: "default_f" | "friday_profile" | "custom_local";
  localImageUri?: string;
  fallbackGlyph: "F";
  updatedAt: string;
}
```

## Token Budget Strategy

Guide Lens should treat a screenshot as expensive evidence and a UI map as cheap
evidence.

Default LLM context:

```json
{
  "surface": "native_desktop",
  "activeApp": "Safari",
  "activeWindowTitle": "Provider Login",
  "visibleText": ["Email", "Password", "Sign in", "Forgot password?"],
  "elements": [
    {"id":"e1","role":"input","label":"Email","bbox":[421,330,360,42],"confidence":0.96},
    {"id":"e2","role":"input","label":"Password","bbox":[421,389,360,42],"confidence":0.95},
    {"id":"e3","role":"button","label":"Sign in","bbox":[421,456,360,44],"confidence":0.98}
  ]
}
```

Only escalate to images when:

- Labels are missing.
- Multiple similar targets exist.
- The target is an unlabeled icon.
- OCR and Accessibility disagree.
- The expected verification state is visual-only.

When image escalation is needed:

- Send cropped regions first.
- Downscale to the smallest usable size.
- Use local parser/captioner before remote vision.
- Cache parser output by screenshot hash and app/window state.

Suggested budget tiers:

- `cheap`: Accessibility/DOM plus visible text, no screenshot.
- `balanced`: UI map plus OCR/icon parse, no full screenshot to LLM.
- `precise`: UI map plus selected crops.
- `forensic`: full screenshot only with explicit user-visible reason.

## Overlay UX

The overlay must be highly configurable but simple by default.

### Default Ordinary-User Preset

- A small circular Friday avatar appears near the edge of the screen when
  guidance starts.
- One blue glowing focus frame around the target.
- A small virtual cursor moves to the target when motion is enabled.
- A restrained speech bubble gives one short instruction:
  "Click Sign in."
- Optional "I did it" and "Not there" controls appear only when auto-detection
  cannot confidently verify progress.
- The overlay does not dim the whole screen by default.
- The focus frame is click-through so the user clicks the real app.

### Native Guide Bubble

The native companion overlay should be anchored by a small circular avatar
bubble. This is the user's visible mental model for "Friday is helping me now."

Avatar behavior:

- Default image is a neutral grey circular avatar with a centered `F`.
- User may choose any local image as the Guide Mode profile picture.
- If the user has a Friday profile image and explicitly chooses to reuse it,
  Guide Mode uses that profile image for the native bubble.
- The avatar should be circular, masked, and readable at small sizes.
- Default collapsed size: 56 px.
- Active guiding size: 64 px.
- Expanded or attention state: up to 72 px, then return to 64 px.
- Minimum hit target for Friday-owned controls: 44 px.
- The avatar can sit at screen edges or near the guided target, but it must not
  cover the real control the user needs to click.
- The real mouse cursor remains controlled by the user. Any Friday cursor is a
  clearly artificial guide cursor.

Avatar settings integration:

- Settings should expose `Guide Mode Avatar`.
- Available choices: default `F`, reuse Friday profile image, or choose custom
  local image.
- Custom images are copied into Friday-owned local app storage, resized into
  safe variants, and referenced by the companion with a local URI.
- The native companion should continue showing the default `F` if the custom
  image is missing, unreadable, or outside the allowed local storage boundary.
- Avatar changes emit `guide_lens.avatar.updated` and refresh the active bubble
  without restarting Friday.
- The avatar picker belongs in both profile settings and Guide Mode settings so
  users can discover it from either path.

Avatar states:

- `idle`: subtle presence, no active instruction.
- `looking`: Friday is reading the screen and building the UI map.
- `guiding`: Friday has a target and is explaining the next step.
- `waiting`: Friday is waiting for the user to complete the step.
- `checking`: Friday is observing again after the user acted.
- `blocked`: Friday needs clarification or cannot safely infer the next step.

Motion should feel alive but restrained:

- First appearance can use a small bounce or spring from the nearest safe edge.
- Active waiting can use a very slow breathing scale or glow.
- Reduced motion disables bounce and cursor travel.
- Motion must never imply that Friday clicked something.

### Speech Bubble

The speech bubble should borrow the clarity of a comic callout, but the visual
tone should be restrained and premium. It should feel like a quiet AI assistant,
not a playful cartoon sticker or dense system toast. It explains one action at a
time.

Layout:

- Bubble width: 280-380 px on desktop, clamped to available screen space.
- Padding: 14-18 px.
- Border radius: 16-22 px, with a small precise tail pointing to the avatar or
  target.
- Body font: platform system font, 15-16 px, 1.45 line height.
- Step title: 13 px medium weight, muted color, optional.
- One instruction per step, usually under 120 characters.
- Use whitespace and line breaks instead of long paragraphs.
- Important target words can be bolded, for example `Sign in`.

Visual styling:

- Use a translucent light or dark material that matches the system theme.
- Prefer neutral surfaces, soft shadow, crisp border, and calm blue accent color.
- Avoid exaggerated outlines, stickers, sparkles, comic sound effects, and
  saturated playful colors.
- The avatar can breathe subtly, but the speech bubble should stay stable while
  the user reads.

### Focus Frame

Guide Mode should avoid full-screen dimming by default. Users need to keep
orientation inside the real app. The primary target marker is a blue glowing
focus frame:

- Rounded rectangle around the target bounds.
- 2 px blue border plus soft outer glow.
- Optional secondary inner line for high precision.
- No opaque mask over the rest of the screen.
- The frame should never consume clicks.
- When the target is near the edge, the speech bubble should move instead of
  covering the target.
- Full-screen dimming remains an optional accessibility setting for users who
  want stronger focus, not the default.

Controls:

- Primary control: "I did it" only when auto-verification is uncertain.
- Secondary control: "Not there" when the target cannot be found.
- Optional detail expander: "Why?" for users who want more context.
- Sensitive steps use "Review first" language instead of commanding a click.

Examples:

```text
Step 1
Click the highlighted Sign in button.
```

```text
I see a permission prompt.
Review the app name. If it is Friday, click Allow.
```

```text
I cannot tell which Continue button is correct.
I marked the likely choices. Pick the one for Google.
```

### Step Progression

Guide Lens must progress step by step:

1. Friday reads the current screen.
2. Friday shows exactly one next action when confidence is high.
3. User performs the real action.
4. Friday observes again.
5. Friday verifies the expected state.
6. Friday either advances, asks a clarifying question, or marks alternatives.

Friday should not show a long instruction list by default. Long lists make the
user do planning work. The overlay should make the next action obvious.

### New Page And Scroll Flows

Guide Mode must handle navigation and scrolling as first-class guidance steps.
It should not assume that every target is already visible.

Opening a new page or window:

1. Friday highlights the real control that opens the page, such as `Open`,
   `Continue`, `Authorize`, or a provider link.
2. The user clicks it.
3. Friday enters `checking` or `page_transition` state immediately so the user
   sees that Friday is following along.
4. Friday watches for URL, title, app focus, window inventory, tab identity, and
   visible text changes.
5. After the new page is stable, Friday rebuilds the UI map and guides the next
   step.
6. If the new page opens in a different browser/window, Friday re-anchors the
   avatar bubble to that surface and says what changed.

Example copy:

```text
Click Open provider portal. A new page may appear; I will follow it.
```

```text
I see the new provider page. Next, click Continue.
```

Scrolling:

1. Friday first checks whether DOM, Accessibility, or browser snapshot data can
   see offscreen text without needing a screenshot.
2. If the target is known to be below or above the visible area, Friday shows a
   blue scroll hint and asks the user to scroll in that direction.
3. While the user scrolls, Friday runs a lightweight read loop and updates the UI
   map when the viewport changes.
4. Once the target appears, Friday replaces the scroll hint with a blue focus
   frame around the target.
5. If Friday cannot infer the direction, it asks the user to scroll slowly until
   the target appears instead of guessing.

Example copy:

```text
Scroll down slowly. I am watching for the Security section.
```

```text
Found it. Click the highlighted API keys row.
```

For web pages under Friday-controlled Chrome, Guide Mode can use DOM and
Playwright snapshots to find likely offscreen targets quickly. For arbitrary
native apps, it should use Accessibility scroll containers when exposed and fall
back to visible-screen observation when they are not.

### Low-Latency Observation Strategy

Guide Mode should give immediate feedback even when full parsing takes longer.

Latency targets:

- `0-100 ms`: bubble changes to `looking`, `checking`, or `waiting`.
- `100-300 ms`: cheap UI map refresh from Accessibility, browser snapshot, URL,
  title, focus, and window state.
- `300-900 ms`: OCR or local parser result when needed.
- `>900 ms`: show "still looking" copy instead of leaving the user guessing.

Implementation strategy:

- Keep a lightweight local observer active during Guide Mode sessions.
- Subscribe to browser URL/title changes, app/window focus changes, and scroll
  or viewport changes where available.
- Use screenshot hashing and changed-region detection to avoid re-parsing the
  entire screen.
- Run Accessibility/DOM reads first; run OCR and optional parser sidecars only
  when necessary.
- Cache UI maps by app/window/URL/screenshot hash.
- Pre-resolve likely next targets when Friday knows the flow, for example after
  OAuth pages, setup wizards, or permission dialogs.
- Keep the overlay responsive independently from parser completion.
- Degrade gracefully: show a scroll hint, candidate marks, or a short question
  when confidence is low.

### Available Overlay Modes

1. Avatar Bubble
   Shows the Friday profile bubble and current state.

2. Speech Bubble
   Shows one step of human-readable guidance.

3. Focus Frame
   Draws a blue glowing frame around the target bounding box without dimming the
   rest of the screen.

4. Cursor Ghost
   Shows a non-real cursor moving to the target. It must be visually distinct
   from the real cursor.

5. Arrow
   Points from the Friday sidecar to the target.

6. Scroll Hint
   Shows a subtle vertical direction marker when the next target is likely below
   or above the visible viewport.

7. Page Transition
   Shows a waiting/checking state while a new page, tab, window, or app view is
   opening.

8. Numbered Marks
   Places numbers on multiple candidate targets. Useful when Friday is not sure.

9. Candidate Picker
   Shows "1, 2, 3" candidates and asks the user to choose which one matches.

10. Step Checklist
   Shows a compact checklist in the sidecar for multi-step human-only flows.

11. Confirm Step
   Used for sensitive steps. Example:
   "Review this permission dialog. If it matches what you expect, click Allow."

12. Blocked Warning
   Used when Friday cannot safely infer the next action.

13. Clear
   Removes all guidance.

### Customization

User settings should include:

- Overlay intensity: low, medium, high.
- Cursor ghost: off, subtle, animated.
- Motion: full, reduced, none.
- Instruction density: terse, normal, detailed.
- Candidate marks: auto, always, never.
- Sound: off, subtle.
- Avatar image: default, user profile picture, custom local image.
- Avatar size: compact, default, large.
- Position: edge bubble, near target, sidecar left, sidecar right.
- Speech style: comic, compact, high contrast.
- Privacy: blur sensitive fields, hide values, local-only parsing.
- Theme: system, light, dark, high contrast.
- Persistence: auto-clear after click, auto-clear after timeout, manual clear.

### Accessibility Requirements

- Reduced motion support.
- High contrast support.
- Keyboard navigable overlay controls.
- Screen-reader labels for Friday-owned overlay controls.
- Never hide the real app's target behind a non-click-through layer unless the
  overlay is in `overlay_controls_only` mode.

## Parser Strategy

### Built-in Fast Path

The first parser path should be:

```text
Accessibility / browser snapshot
  -> OCR for missing visible text
  -> icon crop captioning only when needed
  -> merged UI map
```

This is cheap and deterministic for common apps.

### Optional OmniParser Adapter

Use OmniParser-style parsing when:

- The app has poor Accessibility metadata.
- The surface is canvas-heavy.
- Icons are unlabeled.
- The UI is remote, streamed, or image-like.

Integration pattern:

```text
Friday companion
  -> local parser sidecar over localhost or stdio
  -> screenshot in
  -> structured element list out
```

Notes:

- Keep it optional because model weights and Python dependencies are heavy.
- Treat license and dependency footprint as a release gate.
- If optional parser dependencies include AGPL components, do not bundle them
  into the default Friday distribution without explicit license review.

### Optional Midscene-Style Adapter

Use Midscene-style visual localization when:

- A browser/mobile/remote session is already available.
- The user enables a supported vision provider.
- The task benefits from cached visual localization.

Guide Lens should consume only locate/extract/assert-style results in this mode,
not interaction APIs.

## Trigger Model

Guide Lens should be available from every place a user can talk to Friday. The
trigger should start one native overlay session on the user's local machine when
the companion is connected and read permissions are available.

Explicit triggers:

- User says "guide me", "show me where", "walk me through this", or equivalent
  Chinese phrases such as "引导我", "告诉我点哪里", or "帮我看这个界面".
- User takes or uploads a screenshot and asks a question, or sends a screenshot
  without enough text context.
- User clicks a "Guide me" button in Friday.
- User chooses "Guide me here" from the companion menu bar.
- User presses a configurable hotkey, suggested default `cmd+shift+g` on macOS.
- User opens a deep link such as `friday://guide`.

Automatic triggers:

- Friday reaches login, OAuth, CAPTCHA, payment, permission approval, API key
  entry, provider setup, or any account-bound step.
- Friday detects that autonomous desktop control is disabled but read-only
  guidance is available.
- Friday has enough confidence to guide the user, but not enough confidence or
  permission to act.
- Friday is contacted from a channel such as Discord, Telegram, Lark, Slack,
  WhatsApp, Signal, QQ, or webchat and determines that the next step must happen
  on the user's local desktop.

Channel-triggered behavior:

1. Friday replies in the channel with a short handoff sentence.
2. If the user has a paired local companion, Friday sends a local Guide Mode
   request to that companion.
3. The bubble enters `looking` state, builds the UI map, and then shows the first
   speech bubble step.
4. If the companion is not connected, Friday replies with the exact setup or
   permission blocker instead of pretending guidance is active.

Recommended channel safety policy:

- First use from each channel/device pair requires a local native confirmation:
  "Open Guide Mode on this Mac?"
- After confirmation, the user may mark the channel/device pair as trusted.
- Trusted low-risk guide requests may pop the native avatar bubble immediately.
- Sensitive screens, remote parsing, account permissions, payments, password
  managers, and system password prompts still require local confirmation before
  screen reading begins.
- Channel messages should never silently start screen capture. The channel should
  say that a Guide Mode request was sent to the Mac.
- The native confirmation includes "Always allow from this channel", "Allow once",
  and "Deny".
- Trust can be revoked from Settings.
- Rate limit repeated channel-triggered popups and respect Do Not Disturb or a
  paused Guide Mode state.

Example channel response:

```text
I need you for the account step. I sent a Guide Mode request to your Mac and
will show the next step there after you approve it.
```

Session lifecycle:

```text
requested -> looking -> guiding -> waiting_for_user -> checking
  -> verified -> next_step
  -> completed
```

Failure states:

- `needs_permission`: Screen Recording or Accessibility read access is missing.
- `needs_focus`: Friday cannot determine which app/window the user means.
- `low_confidence`: target confidence is too low.
- `ambiguous_target`: several targets look plausible.
- `sensitive_remote_blocked`: remote parsing is disabled for the current screen.
- `user_cancelled`: user dismissed the bubble or disabled Guide Mode.

## Screenshot Intake

Screenshots are a first-class Guide Mode intake path. When the user captures,
uploads, drags, pastes, or sends a screenshot to Friday, Friday should analyze
both the image and the likely user intent before deciding whether to answer in
chat, ask a question, or start Guide Mode.

Default behavior:

1. Detect screenshot input from chat attachments, channel attachments, paste,
   drag-and-drop, or OS screenshot handoff when available.
2. Run local image understanding first: OCR, visible UI element detection,
   app/window cues, sensitive field redaction, and screenshot metadata if
   available.
3. Infer the user intent:
   - "What is this?"
   - "What should I click?"
   - "Why is this error happening?"
   - "Help me fill this in."
   - "Continue this task from here."
4. If the answer is explanatory, answer directly in the existing chat.
5. If the screenshot implies a next UI action on the current desktop, offer or
   start Guide Mode depending on trust and permissions.
6. If intent is ambiguous, open a compact chatbox near the avatar bubble and ask
   one short question.

Screenshot-specific chatbox:

- The chatbox is not always required.
- Use it when Friday needs missing context, for example:
  "What are you trying to finish on this screen?"
- Do not ask if the screenshot and task are obvious, for example a visible error
  dialog with a clear "Retry" button.
- The chatbox should stay visually tied to the Guide Mode avatar, not become a
  separate full chat app.
- For channel screenshots, Friday can ask the clarifying question in the same
  channel unless the answer requires local screen reading.

Examples:

```text
User sends screenshot only.
Friday: I see a provider setup page with an Allow access button. Do you want me
to guide you through connecting it?
```

```text
User sends screenshot: "what now?"
Friday: Click the highlighted Allow access button. I can open Guide Mode on your
Mac if you want me to follow the next page.
```

```text
User sends screenshot of an error.
Friday: This looks like a missing API key error. Open Settings -> Providers and
paste the key there. I can guide you if you want.
```

Important privacy rule:

Screenshots supplied by the user can be analyzed as task input, but they still
follow the same privacy policy: local-first, redact sensitive fields, do not save
long-term by default, and ask before remote vision/crop upload.

## Agent Runtime Behavior

The agent should enter Guide Lens when:

- The task is explicitly "show me where" or "guide me".
- Friday reaches login, OAuth, CAPTCHA, payment, permission approval, or account
  setup.
- A desktop/browser action is high risk or uncertain.
- The user has disabled autonomous desktop control.
- The target confidence is below the action threshold but above the guidance
  threshold.
- Friday can explain the next human action better than it can safely perform it.

Confidence thresholds:

- `>= 0.90`: show one target.
- `0.70 - 0.89`: show primary target plus alternatives if ambiguity matters.
- `0.45 - 0.69`: use numbered candidate picker.
- `< 0.45`: ask user to describe what they see or request a better view.

The agent response should be short:

```text
I need you for this login step. I highlighted the Sign in button. Click it, then
I will check the next screen.
```

It should not dump parser internals unless the user asks.

## User Understanding Guardrails

Guide Lens should be understandable without documentation.

Rules:

- Show one next action, not the whole plan.
- Use verbs that map to user actions: click, type, choose, review, wait.
- Name the exact visible target when possible.
- Highlight the target at the same time as the instruction.
- Use the avatar state to show what Friday is doing: looking, waiting, checking.
- Show progress only when helpful, for example "Step 2 of 4".
- Do not use implementation words such as OCR, Accessibility, parser, bbox, or
  confidence in the default UI.
- For sensitive actions, ask the user to review instead of telling them to
  approve blindly.
- When uncertain, show numbered choices and ask the user to pick rather than
  guessing.

Copy style:

- Good: "Click the highlighted Sign in button."
- Good: "Type your email in the highlighted field. I will not read the value."
- Good: "Review this permission. If the app name is Friday, click Allow."
- Bad: "Interact with element e3."
- Bad: "The parser confidence is 0.73."
- Bad: "Authorize this now."

The overlay should also provide a quiet escape hatch:

- Pause Guide Mode.
- Hide for 10 seconds.
- Stop guiding this task.
- Report "wrong place" so Friday re-reads the screen.

## Verification

After the user acts, Friday should observe again and verify:

- URL changed.
- Expected text appeared.
- Dialog disappeared.
- New step became visible.
- Button state changed.
- App/window focus changed.
- Screenshot hash or UI map changed enough to indicate progress.

If verification fails:

1. Clear stale overlay.
2. Refresh UI map.
3. Re-resolve target.
4. Ask one clarifying question or show candidate marks.

Do not assume the user clicked the wrong thing unless evidence supports it.

## Privacy And Data Handling

Default policy:

- Local UI maps stay local.
- Screenshots stay local unless the user configures a remote vision provider.
- Sensitive text fields are redacted before model calls.
- Password-like values are never sent to parser/model prompts.
- Crops around sensitive fields are blocked unless explicitly needed and
  approved.
- UI maps and screenshots are not written into long-term memory by default.
- Audit logs record action categories and element metadata, not secrets.

User-visible settings:

- Local-only screen understanding.
- Allow remote parser/model for Guide Lens.
- Store no screenshots.
- Store screenshots for debugging for N hours.
- Always ask before sending screen crops to a provider.

## Implementation Risks And Defaults

These risks should be handled as defaults, not left to later product decisions.

1. Permission wording.
   macOS permission prompts can make read-only guidance look like control. Friday
   settings must explain that Guide Mode uses Accessibility to read button/text
   positions and does not click or type.

2. Screenshot privacy.
   Screenshots and full-screen captures are not saved by default. Debug capture
   requires an explicit setting and automatic expiry.

3. Remote vision.
   Remote vision is off by default. The first crop upload requires a user-visible
   explanation. Password fields and nearby crops are blocked by default.

4. Performance and battery.
   Guide Mode should be event-driven, not constant high-frequency capture. It can
   temporarily increase observation rate during active target search, navigation,
   or scroll guidance, then return to idle.

5. Scroll unreliability.
   Some native apps do not expose scroll state. When direction is uncertain,
   Friday should say "Scroll slowly; I will highlight it when I see it" instead
   of pretending to know.

6. Coordinate drift.
   Retina scale, multiple displays, browser zoom, and window movement can shift
   bounding boxes. The implementation must normalize coordinate systems and add
   screenshot-pixel calibration tests.

7. Overlay obstruction.
   Avatar and speech bubble must auto-avoid the target. If avoidance fails, the
   bubble collapses to the edge and leaves only the blue focus frame and a short
   arrow.

8. Navigation delay.
   New pages and windows may load slowly. The bubble should immediately enter
   `Opening` or `Checking`, then show "still loading" after a few seconds rather
   than appearing stuck.

9. User clicked the wrong thing.
   Friday should not blame the user. It should re-observe and say "I do not see
   the next step yet; I will mark it again."

10. Multilingual UI.
    The speech bubble follows the user's conversation language, but visible
    target labels should preserve the page's exact text, for example "点击高亮的
    `Allow access`".

11. Channel safety.
    Group chat or remote channel messages cannot silently start screen reading.
    First use requires local confirmation and trusted channel/device binding.

12. Audit records.
    Audit logs record that Guide Mode read the screen, showed a target, and
    verified a user step. They do not record sensitive field values or full
    screenshots by default.

13. Emergency escape.
    `Esc`, the companion menu, and the bubble menu must provide pause/hide/stop.
    A stuck overlay is a product safety issue.

## Friday Integration Points

Current Friday already has relevant foundations:

- `docs/desktop.md` documents desktop runtime enablement and OS permissions.
- `src/system/companion/*` already models companion state and overlay visibility.
- `src/system/model/friday-system.types.ts` already has system intents, companion
  capabilities, permission grants, and system events.
- `src/desktop/*` already separates desktop actions, element inspection,
  permission checks, and session management.
- `packages/friday-operator-client` exposes system state and intent APIs to the
  UI.

Guide Lens should add new read-only types rather than widening existing mutating
desktop actions.

Suggested new modules:

```text
src/guide-lens/model/friday-guide-lens.types.ts
src/guide-lens/engine/screenshot-intake.ts
src/guide-lens/engine/ui-map-builder.ts
src/guide-lens/engine/target-resolver.ts
src/guide-lens/engine/parser-adapter.ts
src/guide-lens/engine/redaction.ts
src/guide-lens/engine/verification.ts
src/agent/tools/friday-agent-guide-lens-tool.ts
apps/macos/FridayCompanion/Sources/FridayCompanion/main.swift
ui/src/routes/settings-page.tsx
```

Suggested new API routes:

```text
GET  /v1/guide-lens/state
POST /v1/guide-lens/snapshot
POST /v1/guide-lens/screenshots/analyze
POST /v1/guide-lens/targets/resolve
POST /v1/guide-lens/overlay
DELETE /v1/guide-lens/overlay
POST /v1/guide-lens/verifications
PATCH /v1/guide-lens/preferences
POST /v1/guide-lens/avatar
```

Suggested new events:

```text
guide_lens.snapshot.captured
guide_lens.screenshot.received
guide_lens.screenshot.intent_inferred
guide_lens.ui_map.built
guide_lens.target.resolved
guide_lens.overlay.shown
guide_lens.overlay.cleared
guide_lens.user_step.awaiting
guide_lens.user_step.verified
guide_lens.user_step.failed
guide_lens.avatar.updated
```

## MVP Plan

### Phase 1: macOS Native Guide Bubble MVP

- Build shared Guide Lens types.
- Extend the companion overlay payload beyond `overlayVisible`.
- Build a click-through native avatar bubble with default grey `F` avatar and
  custom local image support.
- Build native speech bubble, blue focus frame, cursor ghost, numbered marks, and
  blocked/permission states.
- Add macOS read-only Accessibility snapshot.
- Add screen capture hashing and OCR hook.
- Add screenshot intake from attachments/paste/drag-and-drop with intent
  inference and optional compact chatbox.
- Add `guide_lens` agent tool with read-only enforcement.
- Add auto-verification plus "I did it" fallback.
- Add tests for target resolution, redaction, overlay command rendering, and
  forbidden mutating actions.

### Phase 2: Friday-Controlled Browser Coverage

- Build UI map from Friday-controlled visible Chrome sessions.
- Reuse the native overlay over the visible browser window.
- Add DOM/Playwright snapshot merging when available.
- Add fallback React web overlay for cases where native companion is
  unavailable.
- Add Guide Mode entry points in Friday UI, menu bar, hotkey, and channel
  handoffs.

### Phase 3: Optional Parser Sidecars

- Add parser registry.
- Add OmniParser-compatible local sidecar protocol.
- Add Midscene-style visual locate/extract/assert adapter.
- Add parser health checks and fallback ranking.

### Phase 4: Production Hardening

- Add privacy settings.
- Add audit events.
- Add multi-monitor support.
- Add Windows/Linux overlays.
- Add eval tasks for login, OAuth, CAPTCHA handoff, ambiguous buttons, and
  icon-only UI.

## Open Decisions

These need product confirmation before implementation:

1. Remote vision policy:
   Should remote vision parsing be opt-in globally, opt-in per session, or
   prompted per crop?

2. Screenshot retention:
   Should debug screenshots default to never saved, saved for the current run
   only, or saved for a short retention window?

3. Confirmation UX:
   Should Friday wait for the user to click "I did it", or should it auto-detect
   screen changes and verify?

4. Parser packaging:
   Should optional OmniParser-style parsing be documented as user-installed
   sidecar only, or should Friday offer a guided installer?

5. Sensitive screens:
   Should Guide Lens automatically disable remote parsing on password managers,
   banking sites, system password prompts, and private browsing windows?

## Recommended Defaults

Product defaults for broad adoption:

1. User-facing name: "Guide Mode".
   Internally keep `guide_lens` because it describes the technical capability.

2. MVP target: macOS Native Companion Overlay first.
   This matches the intended ordinary-user product: Friday appears on top of the
   app the user is actually using.

3. Permissions: Accessibility read plus Screen Recording, no input permissions.
   Input Monitoring should not be required for Guide Lens.

4. Avatar default: neutral grey circular avatar with centered `F`.
   The user may switch it to a custom local image or explicitly reuse the Friday
   profile image from profile/settings.

5. Overlay default: avatar bubble plus restrained speech bubble plus blue focus frame.
   Enable subtle cursor ghost by default when reduced motion is off.

6. Verification: auto-detect first, with an "I did it" fallback.
   This reduces user friction but still works on static screens.

7. Remote vision: local-only by default; prompt before sending crops.
   Users who want speed can enable a trusted remote provider globally.

8. Screenshot retention: no long-term retention by default.
   Debug retention should be an explicit setting.

9. Parser packaging: optional sidecar, not bundled by default.
   This keeps install size and license risk low.

10. Channel handoff: first use from each channel/device pair requires local
    confirmation; later trusted low-risk requests can pop the bubble
    automatically, while sensitive screens still require local confirmation.
