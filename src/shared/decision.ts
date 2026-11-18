/**
 * The comparison on a game card: the price Billy is looking at, against the
 * cheapest Section 107 pair, and the buyer total Ticketmaster would show.
 * The quote still sets the ask. This only describes the number on the card.
 */

import { BUYER_ALL_IN_MULTIPLE, LIST_FLOOR } from "./pricing";
import { formatChance } from "./format";

export type PriceKind = "list" | "price" | "ask";

/**
 * What the number on the card is. A live listing stays a list even when it
 * differs from the model ask. "price" is a number typed on this device.
 */
export function priceKindFor(input: {
  listed: boolean;
  listedAsk: number | null | undefined;
  typeIn: number | null | undefined;
  usingOwn: boolean;
}): PriceKind {
  const typeIn = typeof input.typeIn === "number" && input.typeIn > 0 ? Math.round(input.typeIn) : null;
  const listedAsk =
    typeof input.listedAsk === "number" && input.listedAsk > 0 ? Math.round(input.listedAsk) : null;
  if (input.listed && listedAsk != null && typeIn === listedAsk) return "list";
  if (input.usingOwn || (input.listed && listedAsk != null && typeIn != null && typeIn !== listedAsk)) return "price";
  return "ask";
}

export type PairDecision = {
  gap: string | null;
  board: string | null;
  buyer: string;
  floor: string | null;
};

function dollars(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function pairCount(count: number): string {
  return count === 1 ? "1 pair" : `${count} pairs`;
}

function subject(kind: PriceKind, amount: string): string {
  if (kind === "ask") return `The ${amount} ask`;
  if (kind === "price") return `Your ${amount} price`;
  return `Your ${amount} list`;
}

function countField(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/** Sentences for the price currently on the card. Null when there is no price. */
export function pairDecision(input: {
  ours: number | null | undefined;
  kind: PriceKind;
  cheapest: number | null | undefined;
  sectionCount: number | null | undefined;
  neighborCount: number | null | undefined;
}): PairDecision | null {
  if (typeof input.ours !== "number" || !Number.isFinite(input.ours) || input.ours <= 0) return null;
  const ours = Math.round(input.ours);
  const cheapest =
    typeof input.cheapest === "number" && Number.isFinite(input.cheapest) && input.cheapest > 0
      ? Math.round(input.cheapest)
      : null;
  const section = countField(input.sectionCount);
  const neighbors = countField(input.neighborCount) ?? 0;
  const amount = dollars(ours);

  let gap: string | null = null;
  if (cheapest != null) {
    const compared =
      section === 1
        ? "the only pair in section 107"
        : section != null && section > 1
          ? `the cheapest of ${section} pairs in section 107`
          : "the cheapest pair in section 107";
    const delta = ours - cheapest;
    gap =
      delta === 0
        ? `${subject(input.kind, amount)} matches ${compared}.`
        : `${subject(input.kind, amount)} is ${dollars(Math.abs(delta))} ${delta > 0 ? "over" : "under"} ${compared}.`;
  }

  let board: string | null = null;
  if ((section === 0 || section === 1) && neighbors > 0) {
    const where = `${pairCount(neighbors)} in sections 108, 118 and 119`;
    board =
      section === 0
        ? `Section 107 has no pairs listed, so the ask uses ${where}.`
        : `Section 107 has one pair, so the ask also uses ${where}.`;
  } else if (gap == null && section != null && section > 1) {
    board = `Section 107 has ${pairCount(section)} listed.`;
  }

  return {
    gap,
    board,
    buyer: `Buyers on Ticketmaster would see about ${dollars(ours * BUYER_ALL_IN_MULTIPLE)}.`,
    floor:
      ours < LIST_FLOOR
        ? `That is under the ${dollars(LIST_FLOOR)} floor, which is not added into the ask.`
        : null,
  };
}

/** Full sentence for the model's chance the pair sells before tip. */
export function saleChanceSentence(probability: number): string {
  const label = formatChance(probability);
  if (label.startsWith("over") || label.startsWith("under")) {
    return `The chance this pair sells before tip is ${label}.`;
  }
  return `There is a ${label} chance this pair sells before tip.`;
}
