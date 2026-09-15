import { formatPercentChange, percentChange } from "@shared/market-change";

export function PriceChange({ current, previous, hasPrevious }: { current: number | null | undefined; previous: number | null | undefined; hasPrevious: boolean }) {
  const change = percentChange(current, previous);
  const label = current == null ? "—" : !hasPrevious ? "baseline" : change == null ? "—" : `${change > 0 ? "▲ " : change < 0 ? "▼ " : ""}${formatPercentChange(change)}`;
  return <span className={`price-change ${change != null && hasPrevious ? change > 0 ? "change-up" : change < 0 ? "change-down" : "change-flat" : "baseline"}`} title="Change since the previous comparable pull">{label}</span>;
}
