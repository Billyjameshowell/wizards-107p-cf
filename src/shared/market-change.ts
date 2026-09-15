/** Compare prices only when both snapshots contain usable values. */
export function percentChange(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous) || current < 0 || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

export function formatPercentChange(change: number): string {
  const rounded = Math.round(change * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${(Object.is(rounded, -0) ? 0 : rounded).toFixed(1)}%`;
}
