# Right Rail Chat Model

The right rail is the persistent Friday control panel.

Fixed structure:
- top bar: session title, active context source, collapse control
- message stream: canonical conversation history
- activity stack: current run activity, approval reminders, evidence summary, page context chips
- composer: input, command completion, fast actions

Behavior rules:
- navigating pages does not reset the session
- the page injects context such as current workflow, provider, incident, device, or memory record
- chat actions can start or mutate work, but results must flow back into the visible page module
- the `/chat` page is the expanded conversation workspace, not a different chat system

Context contract examples:
- `Home`: live runs, pending approvals, pinned packs
- `Workflows`: selected workflow, recent runs, retryable failures
- `Settings`: current provider, secret scope, routing mode
- `Observability`: active incident, latest diagnosis, failed checks

Do not allow:
- separate chat-only state that diverges from page state
- chat-generated runs without visible receipts
- page-specific mini chats with disconnected history
