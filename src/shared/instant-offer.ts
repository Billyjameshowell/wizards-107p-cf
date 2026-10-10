/** A guaranteed "sell now" payout Billy logs by hand. Append-only. */

export const INSTANT_OFFER_SOURCE = "tm_instant_offer";

export type LoggedInstantOffer = {
  gameDate: string;
  total: number;
  perTicket: number;
  observedAt: string;
  note: string | null;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parseInstantOffer(
  input: {
    game?: unknown;
    offeredTotal?: unknown;
    perTicket?: unknown;
    note?: unknown;
    observedAt?: string;
  },
  now = new Date(),
): { ok: true; offer: LoggedInstantOffer } | { ok: false; error: string } {
  const gameDate = typeof input.game === "string" ? input.game.trim() : "";
  if (!DAY.test(gameDate)) return { ok: false, error: "Game date must look like 2026-11-15." };

  const total = moneyOrNull(input.offeredTotal);
  const perTicket = moneyOrNull(input.perTicket);
  if (total == null && perTicket == null) {
    return { ok: false, error: "Enter the pair total, the per-ticket amount, or both." };
  }
  const resolvedPer = perTicket ?? (total as number) / 2;
  const resolvedTotal = total ?? resolvedPer * 2;
  if (resolvedPer <= 0 || resolvedTotal <= 0) return { ok: false, error: "The offer has to be more than zero." };
  if (Math.abs(resolvedTotal - resolvedPer * 2) > 0.02) {
    return { ok: false, error: "Per ticket should be half the pair total." };
  }

  const note = typeof input.note === "string" ? input.note.trim().slice(0, 200) : "";
  const observedAt = input.observedAt && !Number.isNaN(Date.parse(input.observedAt)) ? input.observedAt : now.toISOString();
  return {
    ok: true,
    offer: {
      gameDate,
      total: Math.round(resolvedTotal * 100) / 100,
      perTicket: Math.round(resolvedPer * 100) / 100,
      observedAt,
      note: note.length > 0 ? note : null,
    },
  };
}

/** Latest logged offer for a game on or before `on` (a day, YYYY-MM-DD). */
export function offerAsOf(
  offers: readonly LoggedInstantOffer[],
  gameDate: string,
  on: string,
): LoggedInstantOffer | null {
  let best: LoggedInstantOffer | null = null;
  for (const offer of offers) {
    if (offer.gameDate !== gameDate) continue;
    const day = offer.observedAt.slice(0, 10);
    if (!DAY.test(day) || day > on) continue;
    if (!best || offer.observedAt > best.observedAt) best = offer;
  }
  return best;
}

function moneyOrNull(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : value === 0 ? 0 : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/[$,]/g, "");
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}
