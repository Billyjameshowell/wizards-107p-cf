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

export function formatShortfall(vs6k: number, seasonCost: number): string {
  const target = formatMoney(seasonCost);
  if (vs6k < 0) return `${formatMoney(Math.abs(vs6k))} short of ${target}`;
  if (vs6k > 0) return `${formatMoney(vs6k)} over ${target}`;
  return `Even with ${target}`;
}

export function formatGameDate(date: string, weekday: string): string {
  const parts = date.split("-");
  if (parts.length !== 3) return `${weekday} ${date}`;
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!month || !day) return `${weekday} ${date}`;
  return `${weekday} ${MONTHS[month - 1]} ${day}`;
}

export function formatYear(date: string): string {
  return date.slice(0, 4);
}
