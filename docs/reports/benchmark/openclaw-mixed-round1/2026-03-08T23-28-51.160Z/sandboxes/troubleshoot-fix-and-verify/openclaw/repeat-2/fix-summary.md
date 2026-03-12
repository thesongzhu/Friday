# Fix Summary

## Issue
`add` function subtracted instead of adding.

## Fix
Changed `return a - b;` → `return a + b;`

## Verification
```
$ node check.mjs
PASS
```

✅ Fix verified.
