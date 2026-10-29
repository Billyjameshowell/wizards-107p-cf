const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function formatMoney(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** A model probability for display. Rounding never shows 0% or 100%, since neither is ever certain. */
export function formatChance(probability: number): string {
  if (probability >= 0.995) return "over 99%";
  if (probability < 0.005) return "under 1%";
  return `${Math.round(probability * 100)}%`;
}

export function formatGameDate(date: string, weekday: string): string {
  const parts = date.split("-");
  if (parts.length !== 3) return `${weekday} ${date}`;
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!month || !day) return `${weekday} ${date}`;
  return `${weekday} ${MONTHS[month - 1]} ${day}`;
}
