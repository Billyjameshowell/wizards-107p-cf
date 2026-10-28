import type { ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import { freshness, type FreshTone } from "@shared/freshness";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * Shared layout pieces. One type scale for the whole site:
 * text-3xl the big number, text-xl page title, text-base card titles and body,
 * text-sm secondary. Spacing steps are 2, 3, 4 and 6.
 */

type Page = "book" | "trends" | "grid";

const NAV: { id: Page; label: string; href: string }[] = [
  { id: "book", label: "Book", href: "/" },
  { id: "trends", label: "Trends", href: "/trends" },
  { id: "grid", label: "Grid", href: "/grid" },
];

export function PageShell({
  title,
  current,
  subtitle,
  updatedAt,
  wide = false,
  children,
}: {
  title: string;
  current: Page;
  subtitle?: ReactNode;
  updatedAt?: string | null;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("mx-auto px-4 pb-16", wide ? "max-w-[1400px]" : "max-w-5xl")}>
      <nav aria-label="Site" className="flex h-14 items-center justify-between gap-3">
        <a href="/" className="text-base font-semibold text-navy">
          Wizards 107P
        </a>
        <div className="flex items-center gap-1">
          {NAV.map((item) =>
            item.id === current && window.location.pathname === item.href ? (
              <span key={item.id} aria-current="page" className="rounded-full bg-navy px-3 py-1.5 text-sm font-medium text-white">
                {item.label}
              </span>
            ) : (
              <a
                key={item.id}
                href={item.href}
                className={cn(
                  "rounded-full px-3 py-1.5 text-sm font-medium hover:text-navy",
                  item.id === current ? "bg-navy/10 text-navy" : "text-muted-foreground",
                )}
              >
                {item.label}
              </a>
            ),
          )}
        </div>
      </nav>
      <header className="mt-4 mb-6">
        <h1 className="text-xl font-semibold leading-tight text-navy sm:text-2xl">{title}</h1>
        {subtitle || updatedAt !== undefined ? (
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
            {subtitle ? <span>{subtitle}</span> : null}
            {subtitle && updatedAt !== undefined ? <span aria-hidden="true">·</span> : null}
            {updatedAt !== undefined ? <Updated at={updatedAt} /> : null}
          </p>
        ) : null}
      </header>
      {children}
    </div>
  );
}

const DOT: Record<FreshTone, string> = {
  fresh: "bg-emerald-500",
  aging: "bg-amber-500",
  stale: "bg-red-500",
};

/** "Updated 3h ago" with a green, amber or red dot. */
export function Updated({ at, prefix = "Updated" }: { at: string | null | undefined; prefix?: string }) {
  const f = freshness(at);
  const title = at
    ? `${new Date(at.length === 10 ? `${at}T16:00:00Z` : at).toLocaleString("en-US", { timeZone: "America/New_York" })} ET`
    : undefined;
  return (
    <span className="inline-flex items-center gap-1.5" title={title}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", DOT[f.tone])} />
      {f.hours == null ? "Not checked yet" : `${prefix} ${f.label}`}
    </span>
  );
}

/** The ticketdata-style number: small label, one big figure, a short unit. */
export function BigNumber({
  label,
  value,
  unit,
  className,
}: {
  label: string;
  value: string;
  unit?: string;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-0.5 flex items-baseline gap-1.5">
        <span className="text-3xl font-semibold tabular-nums tracking-tight text-navy">{value}</span>
        {unit ? <span className="text-sm text-muted-foreground">{unit}</span> : null}
      </p>
    </div>
  );
}

/** Small label-over-value pair for detail lists. */
export function Fact({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className={cn("text-base font-medium tabular-nums text-foreground", tone)}>{value}</dd>
    </div>
  );
}

/** Up / down percent, colored. */
export function Change({ value, className }: { value: number | null; className?: string }) {
  if (value == null || !Number.isFinite(value)) return <span className={cn("text-muted-foreground", className)}>—</span>;
  const rounded = Math.round(value);
  const tone = rounded === 0 ? "text-muted-foreground" : rounded > 0 ? "text-emerald-700" : "text-red-700";
  const text = rounded === 0 ? "Flat" : `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)}%`;
  return <span className={cn("tabular-nums", tone, className)}>{text}</span>;
}

/**
 * Half-circle gauge, ticketdata's forecast dial. `value` runs from -1 (left) to 1 (right).
 */
export function Gauge({ value, left, right, label }: { value: number; left: string; right: string; label: string }) {
  const clamped = Math.max(-1, Math.min(1, value));
  const angle = (clamped * 90 * Math.PI) / 180;
  const x = 60 + Math.sin(angle) * 44;
  const y = 60 - Math.cos(angle) * 44;
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
      <span className="text-right text-sm text-muted-foreground">{left}</span>
      <svg viewBox="0 0 120 66" className="h-16 w-28" role="img" aria-label={label}>
        <defs>
          <linearGradient id="gauge-fill" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#bfdbfe" />
            <stop offset="50%" stopColor="#f5f5f4" />
            <stop offset="100%" stopColor="#fecaca" />
          </linearGradient>
        </defs>
        <path d="M 8 60 A 52 52 0 0 1 112 60" fill="none" stroke="url(#gauge-fill)" strokeWidth="14" />
        <line x1="60" y1="60" x2={x.toFixed(1)} y2={y.toFixed(1)} stroke="#1b2230" strokeWidth="3.5" strokeLinecap="round" />
        <circle cx="60" cy="60" r="4" fill="#1b2230" />
      </svg>
      <span className="text-sm text-muted-foreground">{right}</span>
    </div>
  );
}

/** A collapsed section with a full-width tap target. */
export function Disclosure({
  title,
  children,
  className,
  defaultOpen = false,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className={cn("group/disclosure", className)}>
      <CollapsibleTrigger className="flex min-h-11 w-full items-center justify-between gap-2 text-left text-sm font-medium text-navy">
        {title}
        <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/disclosure:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** The one place a page explains itself. Collapsed by default. */
export function HowThisWorks({ children }: { children: ReactNode }) {
  return (
    <Card className="mt-6 gap-0 px-4 py-1">
      <Disclosure title="How this works">
        <div className="space-y-2 pb-4 text-sm leading-relaxed text-muted-foreground">{children}</div>
      </Disclosure>
    </Card>
  );
}

/** Centered message for loading, errors and missing pages. */
export function Message({ title, body, link }: { title: string; body?: string; link?: { href: string; label: string } }) {
  return (
    <div className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-xl font-semibold text-navy">{title}</h1>
      {body ? <p className="mt-2 text-sm text-muted-foreground">{body}</p> : null}
      {link ? (
        <a href={link.href} className="mt-4 inline-flex min-h-11 items-center text-sm font-medium text-navy underline underline-offset-4">
          {link.label}
        </a>
      ) : null}
    </div>
  );
}

/** Grey placeholder blocks while a page loads. */
export function Loading({ label }: { label: string }) {
  return (
    <div className="mx-auto max-w-5xl px-4 pt-20" aria-busy="true" aria-live="polite">
      <p className="sr-only">{label}</p>
      <div className="h-7 w-48 animate-pulse rounded-lg bg-muted" />
      <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((key) => (
          <div key={key} className="h-40 animate-pulse rounded-xl bg-card ring-1 ring-foreground/10" />
        ))}
      </div>
    </div>
  );
}
