# Friday Roadmap Tracker

This roadmap tracks the active product direction for Friday.

The core direction is a local-first personal AI that can execute user goals, acquire missing capabilities safely, verify its work, and improve through auditable memory and reusable artifacts.

## Now

- Make setup land cleanly on Home after completion.
- Keep provider truth aligned with the actual live route.
- Keep capability status visible: available, missing, human blocker, needs review, or deferred.
- Keep generated/imported skills unroutable until verification passes.
- Keep multi-channel control under the same approval and audit model as the web UI.
- Keep user-facing speech direct, human, and non-generic.

## Near Term

1. **Capability acquisition closure**
   - goal-to-capability detection
   - candidate discovery
   - sandbox verification
   - approval gates
   - install/register
   - doctor verification

2. **Standing goals and agenda**
   - user-authorized long-term goals
   - agenda generation
   - low-risk execution
   - high-risk approval
   - run evidence
   - pause/delete controls

3. **Visible memory and self-improvement**
   - learned facts
   - provider routing lessons
   - setup recipes
   - failure lessons
   - eval cases
   - generated skill quality signals

4. **Provider and channel reliability**
   - OpenAI and China-provider setup paths
   - web search provider verification
   - OCR/vision/PDF/TTS capability checks
   - Discord and other channel control verification

## Later

- Richer cross-device control.
- More provider recipes.
- More channel setup wizards.
- More visual evidence for browser/desktop tasks.
- Better workflow editing and approval UX.
- Wider marketplace/catalog trust model.
- Stronger rollback and dependency isolation for generated capabilities.

## Non-Goals

- No promise of universal automation.
- No hidden model-weight training by default.
- No bypass of login, CAPTCHA, payment, provider limits, or platform rules.
- No high-risk action without approval.
- No treating missing credentials as a successful capability.

## Completion Signal

Friday reaches the target experience when it can answer and close the loop for:

```text
Do I have the capability?
If not, what is missing?
Where does the user configure it?
Can Friday verify it after configuration?
Can Friday execute the original goal?
What evidence and learning did the run produce?
```
