# Console Principles

1. One shell
- Left navigation, center workspace, right conversation rail.
- The shell must feel persistent even when page content changes.

2. One conversation
- The right rail is not a separate product.
- It shares context with every page and keeps the same session across navigation.

3. Progressive disclosure
- Do not split novice and expert into separate apps.
- Advanced capabilities appear through tabs, drawers, expandable sections, and contextual details.

4. No invisible outcomes
- If chat triggers a run, approval, retry, memory edit, or setting change, the current page must reflect that result.

5. Stable semantics
- The same state meaning uses the same component and token everywhere.

6. Evidence over mystery
- Approvals, incidents, retries, provider issues, and recovery actions need receipts and visible rationale.

7. Internal plumbing stays internal
- Transport, policy chains, idempotency, and storage wiring may surface as evidence or diagnostics.
- They do not become primary navigation items.
