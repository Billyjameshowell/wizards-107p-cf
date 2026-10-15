import { checkedAgo } from "@shared/freshness";

/** "checked 5h ago". Colors match the freshness pills: green, amber, red. */
export function CheckedBadge({
  at,
  now,
}: {
  at: string | null | undefined;
  now?: Date;
}) {
  const f = checkedAgo(at, now);
  const title =
    f.hours == null || !at
      ? "Not checked yet"
      : `Checked ${new Date(at.length === 10 ? `${at}T16:00:00Z` : at).toLocaleString("en-US", { timeZone: "America/New_York" })} ET`;
  return (
    <span className={`checked-badge ${f.tone}`} title={title} aria-label={f.label}>
      <i aria-hidden="true" />
      {f.label}
    </span>
  );
}
