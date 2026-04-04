export function sortNumbers(values) {
  return values
    .filter((value) => typeof value === "number" && Number.isFinite(value))
    .sort((left, right) => left - right);
}

export function percentile(values, p) {
  const sorted = sortNumbers(values);
  if (sorted.length === 0) return undefined;
  if (sorted.length === 1) return sorted[0];
  const clamped = Math.min(100, Math.max(0, p));
  const index = (clamped / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }
  const fraction = index - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

export function summarizeNumbers(values) {
  const sorted = sortNumbers(values);
  if (sorted.length === 0) {
    return {
      count: 0,
      min: undefined,
      max: undefined,
      p50: undefined,
      p95: undefined,
      p99: undefined,
      average: undefined,
    };
  }
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted.at(-1),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    average: total / sorted.length,
  };
}
