/**
 * Polling helpers for real-scenario E2E tests.
 */

/**
 * Poll a function until the predicate returns true or timeout.
 */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (result: T) => boolean,
  opts: { intervalMs?: number; maxMs?: number } = {},
): Promise<T> {
  const { intervalMs = 1000, maxMs = 30_000 } = opts;
  const deadline = Date.now() + maxMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `pollUntil timed out after ${maxMs}ms (last value: ${JSON.stringify(last)?.slice(0, 500)})`,
  );
}
