import { Badge } from "@/components/ui/badge";
import { freshness, type FreshTone } from "@shared/freshness";
import { cn } from "@/lib/utils";

const TONE: Record<FreshTone, string> = {
  fresh: "border-emerald-300 bg-emerald-50 text-emerald-800",
  aging: "border-amber-300 bg-amber-50 text-amber-800",
  stale: "border-red-300 bg-red-50 text-red-800",
};

const DOT: Record<FreshTone, string> = {
  fresh: "bg-emerald-500",
  aging: "bg-amber-500",
  stale: "bg-red-500",
};

/** "Comps · 3h ago", green / amber / red by age. */
export function FreshBadge({
  source,
  at,
  now,
  className,
}: {
  source: string;
  at: string | null | undefined;
  now?: Date;
  className?: string;
}) {
  const f = freshness(at, now);
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 font-semibold", TONE[f.tone], className)}
      title={at ? `${source} updated ${new Date(at.length === 10 ? `${at}T16:00:00Z` : at).toLocaleString("en-US", { timeZone: "America/New_York" })} ET` : `${source}: no data yet`}
      aria-label={`${source} updated ${f.label}`}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", DOT[f.tone])} />
      {source} · {f.label}
    </Badge>
  );
}

export function FreshRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-1.5", className)}>{children}</div>;
}
