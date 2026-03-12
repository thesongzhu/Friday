### Fix Summary for calc.js

**Change Made**:
- Updated the `add` function to correctly return the sum of the two parameters instead of their difference.

**Original Code**:
```javascript
export function add(a, b) {
  return a - b;
}
```

**Updated Code**:
```javascript
export function add(a, b) {
  return a + b;
}
```

**Verification Result**:
- The command `node check.mjs` returned **PASS**.