# Code Review Checklist

## Critical (must fix before merge)

- [ ] No hardcoded secrets, tokens, or credentials
- [ ] No SQL injection, XSS, or command injection vectors
- [ ] Error handling covers failure paths (no swallowed exceptions)
- [ ] Resource cleanup (file handles, connections, timers) is guaranteed
- [ ] No unbounded loops or recursion without a termination guarantee

## High (should fix before merge)

- [ ] Functions do one thing; no hidden side effects
- [ ] Input is validated at system boundaries
- [ ] Edge cases handled (empty arrays, null, zero, negative numbers)
- [ ] No duplicated logic that should be extracted
- [ ] Async/await errors are properly propagated
- [ ] Mutable shared state is protected or avoided

## Medium (improve if touching this area)

- [ ] Naming is clear and consistent with surrounding code
- [ ] Complex logic has a brief explanatory comment
- [ ] Public API surface is minimal (no unnecessary exports)
- [ ] Performance-sensitive paths avoid unnecessary allocations
- [ ] Tests cover the new/changed behavior

## Low (nice to have)

- [ ] Consistent formatting with project style
- [ ] No dead code or unused imports
- [ ] Type annotations where inference is ambiguous
