export const PRICE_OVERRIDE_KEY = "wizards-107p-price-overrides";

/** Whole-dollar “Set Your Price” he saved, keyed by game date. */
export type PriceOverrideMap = Record<string, number>;

export function parsePriceOverrides(raw: unknown): PriceOverrideMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const next: PriceOverrideMap = {};
  for (const [date, value] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    next[date] = Math.max(1, Math.round(value));
  }
  return next;
}

export function readPriceOverrides(): PriceOverrideMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PRICE_OVERRIDE_KEY);
    if (!raw) return {};
    return parsePriceOverrides(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

export function writePriceOverrides(map: PriceOverrideMap): void {
  try {
    window.localStorage.setItem(PRICE_OVERRIDE_KEY, JSON.stringify(map));
  } catch {
    // The number stays on screen for this visit if the browser refuses storage.
  }
}
