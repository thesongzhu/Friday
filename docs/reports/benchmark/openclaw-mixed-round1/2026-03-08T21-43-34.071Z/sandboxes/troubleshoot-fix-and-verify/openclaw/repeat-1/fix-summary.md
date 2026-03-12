# Fix Summary

## Issue
`add` function in `calc.js` was subtracting instead of adding.

## Fix
Changed `return a - b;` → `return a + b;`

## Verification
```
$ node check.mjs
PASS
```

✅ Fix verified successfully.
