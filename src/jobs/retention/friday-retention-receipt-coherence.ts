import type { CategoryRetention, FridayRetentionContentPolicy } from "./friday-retention.types.js";
import { FRIDAY_RETENTION_CONTENT_CATEGORIES } from "./friday-retention.types.js";

/**
 * RETENTION-R3d round-9 — shared, PURE retention write-path derivations.
 *
 * These functions are the SINGLE source of truth for the receipt's derived facts,
 * so the HTTP write path (which produces `changedCategories` at write time) and the
 * receipt-store decode path (which re-derives them to CROSS-FIELD-VALIDATE a
 * persisted receipt) compute IDENTICAL values — zero drift. They were previously
 * private to `friday-retention-settings-routes.ts`; extracting them to the jobs
 * layer lets the receipt repository reuse the EXACT write-path logic without a
 * routes→jobs layering inversion (the routes file re-imports them unchanged, so its
 * public behavior is byte-identical).
 *
 * All three are pure (no I/O, no clock, no randomness) and operate ONLY on the
 * receipt's own fields — coherence is INTERNAL to a receipt and never compares
 * against the current authoritative policy, so a legitimately STALE receipt (whose
 * `after` differs from a now-current policy a later write changed) stays coherent.
 */

/** True when two per-category retention values are effectively identical. */
export function retentionEquals(a: CategoryRetention, b: CategoryRetention): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === "after_days" && b.mode === "after_days") return a.days === b.days;
  return true;
}

/**
 * The content categories whose EFFECTIVE policy differs between the authoritative
 * before- and after-states. Derived from the two authoritative policies (never from
 * a request), so it reports what actually changed. Sorted for a stable
 * receipt/audit payload — this SORTED array is the authoritative diff the decode
 * path compares a persisted `changedCategories` against.
 */
export function computeChangedCategories(
  before: FridayRetentionContentPolicy,
  after: FridayRetentionContentPolicy,
): string[] {
  const categories = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const category of categories) {
    const b = (before as Record<string, CategoryRetention>)[category];
    const a = (after as Record<string, CategoryRetention>)[category];
    if (!b || !a || !retentionEquals(b, a)) {
      changed.push(category);
    }
  }
  return changed.sort();
}

/**
 * Overlay the validated per-category `appliedUpdates` onto the authoritative
 * `before` policy to reconstruct the `after` policy the write path would have
 * committed: for each of the seven canonical content categories, take
 * `appliedUpdates[category]` when present else `before[category]`. This mirrors the
 * store's apply semantics exactly — `applyOwnerContentPolicyOnConnection` upserts an
 * `after_days` window and removes an override for `permanent`, so the resulting
 * effective `after[category]` is precisely the update when the category was in the
 * batch, and the unchanged `before[category]` otherwise. The decode path deep-equals
 * this reconstruction against the stored `after` (per-category `retentionEquals`) to
 * reject a tampered after-state.
 */
export function applyContentPolicyOverlay(
  before: FridayRetentionContentPolicy,
  appliedUpdates: Record<string, CategoryRetention>,
): FridayRetentionContentPolicy {
  const overlaid = {} as FridayRetentionContentPolicy;
  for (const category of FRIDAY_RETENTION_CONTENT_CATEGORIES) {
    overlaid[category] = Object.prototype.hasOwnProperty.call(appliedUpdates, category)
      ? appliedUpdates[category]
      : before[category];
  }
  return overlaid;
}
