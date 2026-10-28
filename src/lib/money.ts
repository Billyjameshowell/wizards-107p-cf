/** Dollars with cents only when there are cents: $57, $28.50, $12,255. */
export function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const cents = Math.round(value * 100) % 100 !== 0;
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });
}
