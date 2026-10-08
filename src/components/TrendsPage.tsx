import { useEffect, useMemo, useState } from "react";
import type { TrendsGame, TrendsReport } from "@shared/trends";
import { formatGameDate, formatMoney, formatYear } from "@shared/format";
import { formatDaysOut } from "@shared/pricing";
import { DaysOutChart, PriceTrendChart, Sparkline } from "@/components/TrendChart";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type SortKey = "date" | "opponent" | "median" | "change7d" | "changeSinceFirst" | "projection";
type SortDirection = "asc" | "desc";
type HistoryFilter = "history" | "all";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "date", label: "Date" },
  { key: "opponent", label: "Opponent" },
  { key: "median", label: "Median" },
  { key: "change7d", label: "7-day" },
  { key: "changeSinceFirst", label: "Since first check" },
  { key: "projection", label: "By tip" },
];

const navLink =
  "inline-flex min-h-11 items-center rounded-lg px-1 text-sm font-semibold text-[#f3e6c8] underline decoration-[#f3e6c8]/70 underline-offset-4";

function gameFromLocation(): string | null {
  const path = window.location.pathname.replace(/\/+$/, "");
  const match = path.match(/^\/trends\/(\d{4}-\d{2}-\d{2})$/);
  if (match?.[1]) return match[1];
  const query = new URLSearchParams(window.location.search).get("game");
  if (query && /^\d{4}-\d{2}-\d{2}$/.test(query)) return query;
  return null;
}

function formatSignedPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) return "0%";
  const sign = rounded > 0 ? "+" : "−";
  const abs = Math.abs(rounded);
  const text = Number.isInteger(abs) ? abs.toFixed(0) : abs.toFixed(1);
  return `${sign}${text}%`;
}

function percentClass(value: number | null): string {
  if (value == null || !Number.isFinite(value) || Math.round(value * 10) === 0) return "text-muted-foreground";
  return value > 0 ? "text-sit-ink" : "text-sell-ink";
}

function bandPhrase(band: string): string {
  return band.charAt(0).toLowerCase() + band.slice(1);
}

function monthDay(ymd: string | null): string {
  if (!ymd) return "";
  return formatGameDate(ymd, "").replace(/^\s+/, "");
}

function numberOrNull(game: TrendsGame, key: SortKey): number | null {
  if (key === "median") return game.latestMedian;
  if (key === "change7d") return game.change7d;
  if (key === "changeSinceFirst") return game.changeSinceFirst;
  if (key === "projection") return game.projection.price;
  return null;
}

function compareGames(a: TrendsGame, b: TrendsGame, key: SortKey, direction: SortDirection): number {
  if (key === "date") {
    const result = a.date.localeCompare(b.date);
    return direction === "asc" ? result : -result;
  }
  if (key === "opponent") {
    const result = a.opponent.localeCompare(b.opponent);
    if (result !== 0) return direction === "asc" ? result : -result;
    return a.date.localeCompare(b.date);
  }
  const left = numberOrNull(a, key);
  const right = numberOrNull(b, key);
  if (left == null && right == null) return a.date.localeCompare(b.date);
  if (left == null) return 1;
  if (right == null) return -1;
  const sign = direction === "asc" ? 1 : -1;
  const result = (left - right) * sign;
  return result === 0 ? a.date.localeCompare(b.date) : result;
}

function SiteNav({ trendsCurrent }: { trendsCurrent: boolean }) {
  return (
    <nav aria-label="Site" className="flex shrink-0 items-center gap-3">
      <a href="/" className={navLink}>
        Book
      </a>
      {trendsCurrent ? (
        <span className="inline-flex min-h-11 items-center text-sm font-semibold text-white" aria-current="page">
          Trends
        </span>
      ) : (
        <a href="/trends" className={navLink}>
          Trends
        </a>
      )}
    </nav>
  );
}

function ChangeText({ value, large = false }: { value: number | null; large?: boolean }) {
  return (
    <span className={cn("font-semibold tabular-nums", large ? "text-lg" : "text-base", percentClass(value))}>
      {formatSignedPercent(value)}
    </span>
  );
}

function GameSentence({ game }: { game: TrendsGame }) {
  return <p className="text-sm leading-snug text-[#3d4654]">{game.projection.sentence}</p>;
}

function SortableHead({
  label,
  column,
  sort,
  onSort,
}: {
  label: string;
  column: SortKey;
  sort: { key: SortKey; direction: SortDirection };
  onSort: (key: SortKey) => void;
}) {
  const active = sort.key === column;
  const direction = active ? sort.direction : null;
  return (
    <TableHead
      aria-sort={direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none"}
      className="bg-thead"
    >
      <button
        type="button"
        className="inline-flex items-center gap-1 text-left text-xs font-semibold text-navy"
        onClick={() => onSort(column)}
      >
        {label}
        <span aria-hidden="true" className={cn("text-[10px]", direction ? "text-navy" : "text-muted-foreground/70")}>
          {direction === "asc" ? "▲" : direction === "desc" ? "▼" : "↕"}
        </span>
      </button>
    </TableHead>
  );
}

function SeasonTable({
  games,
  sort,
  onSort,
}: {
  games: TrendsGame[];
  sort: { key: SortKey; direction: SortDirection };
  onSort: (key: SortKey) => void;
}) {
  return (
    <Card className="hidden min-w-0 overflow-hidden border-line py-0 shadow-[0_10px_30px_rgba(11,31,58,0.12)] lg:flex">
      <div className="max-h-[min(72vh,860px)] w-full overflow-auto">
        <Table className="ticket-table trends-table min-w-[880px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <SortableHead label="Game" column="date" sort={sort} onSort={onSort} />
              <TableHead className="bg-thead text-xs font-semibold text-navy">Trend</TableHead>
              <SortableHead label="Median" column="median" sort={sort} onSort={onSort} />
              <SortableHead label="7-day" column="change7d" sort={sort} onSort={onSort} />
              <SortableHead label="Since first check" column="changeSinceFirst" sort={sort} onSort={onSort} />
              <SortableHead label="By tip" column="projection" sort={sort} onSort={onSort} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {games.map((game) => (
              <TableRow key={game.date} className="hover:bg-transparent [&>td]:align-top [&>td]:py-3">
                <TableCell className="whitespace-normal bg-card">
                  <a href={`/trends/${game.date}`} className="font-semibold text-navy underline-offset-2 hover:underline">
                    {game.opponent}
                  </a>
                  <span className="mt-0.5 block text-xs font-medium text-muted-foreground">
                    {formatGameDate(game.date, game.weekday)} {formatYear(game.date)}
                    {game.daysOut != null ? ` · ${formatDaysOut(game.daysOut)}` : ""}
                  </span>
                  <div className="mt-1.5 max-w-sm">
                    <GameSentence game={game} />
                  </div>
                </TableCell>
                <TableCell>
                  <Sparkline
                    values={game.series.map((point) => point.median)}
                    label={`${game.opponent} median, ${game.checks} price checks`}
                  />
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm font-semibold tabular-nums">
                  {formatMoney(game.latestMedian)}
                  <span className="mt-0.5 block text-xs font-medium text-muted-foreground">
                    {game.checks === 1 ? "1 check" : `${game.checks} checks`}
                  </span>
                </TableCell>
                <TableCell>
                  <ChangeText value={game.change7d} />
                </TableCell>
                <TableCell>
                  <ChangeText value={game.changeSinceFirst} />
                </TableCell>
                <TableCell className="whitespace-normal text-sm font-semibold tabular-nums text-navy">
                  {game.projection.enough ? formatMoney(game.projection.price) : "Not enough data yet."}
                  {game.projection.enough && game.projection.low != null && game.projection.high != null ? (
                    <span className="mt-0.5 block text-xs font-medium text-muted-foreground">
                      {formatMoney(game.projection.low)} – {formatMoney(game.projection.high)}
                    </span>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

function SeasonCards({ games }: { games: TrendsGame[] }) {
  return (
    <div className="space-y-3 lg:hidden">
      {games.map((game) => (
        <article key={game.date} className="rounded-2xl border border-line bg-card p-3.5 shadow-[0_1px_2px_rgba(12,35,64,0.06)]">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-[1.15rem] font-semibold leading-tight text-navy">
                <a href={`/trends/${game.date}`} className="underline-offset-2 hover:underline">
                  {game.opponent}
                </a>
              </h2>
              <p className="mt-1 text-sm text-[#3d4654]">
                {formatGameDate(game.date, game.weekday)} {formatYear(game.date)}
                {game.daysOut != null ? ` · ${formatDaysOut(game.daysOut)}` : ""}
              </p>
            </div>
            <Sparkline
              values={game.series.map((point) => point.median)}
              label={`${game.opponent} median, ${game.checks} price checks`}
            />
          </div>
          <div className="mt-2">
            <GameSentence game={game} />
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-2">
            <div className="rounded-xl bg-[#faf8f4] px-3 py-2">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Median</dt>
              <dd className="text-base font-semibold tabular-nums">{formatMoney(game.latestMedian)}</dd>
            </div>
            <div className="rounded-xl bg-[#faf8f4] px-3 py-2">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">7-day</dt>
              <dd>
                <ChangeText value={game.change7d} large />
              </dd>
            </div>
            <div className="rounded-xl bg-[#faf8f4] px-3 py-2">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Since first check</dt>
              <dd>
                <ChangeText value={game.changeSinceFirst} large />
              </dd>
            </div>
            <div className="rounded-xl bg-[#faf8f4] px-3 py-2">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">By tip</dt>
              <dd className="text-base font-semibold tabular-nums text-navy">
                {game.projection.enough ? formatMoney(game.projection.price) : "Not enough data yet."}
              </dd>
            </div>
          </dl>
          <a
            href={`/trends/${game.date}`}
            className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-navy underline underline-offset-2"
          >
            Open chart
          </a>
        </article>
      ))}
    </div>
  );
}

function SeasonView({ report }: { report: TrendsReport }) {
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: "date", direction: "asc" });
  const [filter, setFilter] = useState<HistoryFilter>("history");
  const visible = useMemo(() => {
    const rows = report.games.filter((game) => (filter === "history" ? game.checks > 0 : true));
    return rows.slice().sort((a, b) => compareGames(a, b, sort.key, sort.direction));
  }, [report.games, sort, filter]);
  const dots = useMemo(() => {
    const points: { daysOut: number; index: number }[] = [];
    for (const game of report.games) {
      const first = game.series[0]?.median;
      if (first == null || first <= 0) continue;
      for (const point of game.series) {
        if (point.daysOut < 0) continue;
        points.push({ daysOut: point.daysOut, index: point.median / first });
      }
    }
    return points;
  }, [report.games]);
  const up = report.games.filter((game) => game.change7d != null && game.change7d > 0).length;
  const down = report.games.filter((game) => game.change7d != null && game.change7d < 0).length;

  function chooseSort(key: SortKey) {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "date" || key === "opponent" ? "asc" : "desc" },
    );
  }

  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-16 pt-4 sm:px-4 sm:pt-5">
      <header className="rounded-2xl bg-navy px-4 py-3 text-navy-foreground sm:px-5 sm:py-4">
        <div className="flex items-start justify-between gap-3">
          <p className="m-0 text-[13px] font-medium leading-snug text-[#f3e6c8]">
            Capital One Arena · Section {report.section} Row {report.row} · seats {report.seats.join("–")}
          </p>
          <SiteNav trendsCurrent />
        </div>
        <h1 className="font-heading mt-0.5 text-[24px] leading-none tracking-tight sm:text-[30px]">Price trends</h1>
        <p className="mt-1.5 text-sm leading-snug text-[#e4eaf3]">
          Similar seats: {bandPhrase(report.band)}. Prices are per seat.
        </p>
      </header>

      <section
        aria-label="Trend summary"
        className="sticky top-0 z-40 -mx-3 mt-3 border-y border-line bg-[#f4f1ea]/95 px-3 py-2 shadow-[0_8px_18px_rgba(12,35,64,0.06)] backdrop-blur-md sm:-mx-4 sm:px-4"
      >
        <p className="text-[15px] font-semibold leading-snug text-navy">
          {report.gamesWithChecks} {report.gamesWithChecks === 1 ? "game has" : "games have"} price checks
          {report.firstCheck && report.lastCheck
            ? ` · ${monthDay(report.firstCheck)} through ${monthDay(report.lastCheck)}`
            : ""}
        </p>
        <p className="text-sm leading-snug text-[#3d4654]">
          {down} down and {up} up over the last 7 days
          <span className="text-muted-foreground"> · green is up, red is down</span>
        </p>
      </section>

      <section aria-labelledby="days-out-heading" className="mt-4 rounded-2xl border border-line bg-card px-3 py-3 sm:px-4">
        <h2 id="days-out-heading" className="text-base font-semibold text-navy">
          How prices move as tip gets closer
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {dots.length} price {dots.length === 1 ? "check" : "checks"} across {report.gamesWithChecks}{" "}
          {report.gamesWithChecks === 1 ? "game" : "games"}.
        </p>
        <div className="mt-2">
          <DaysOutChart curve={report.daysOutCurve} dots={dots} />
        </div>
      </section>

      <div className="my-3 flex flex-col gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Which games">
          <Button
            type="button"
            size="sm"
            variant={filter === "history" ? "default" : "outline"}
            aria-pressed={filter === "history"}
            className="h-11 px-3.5 lg:h-8"
            onClick={() => setFilter("history")}
          >
            With price checks
          </Button>
          <Button
            type="button"
            size="sm"
            variant={filter === "all" ? "default" : "outline"}
            aria-pressed={filter === "all"}
            className="h-11 px-3.5 lg:h-8"
            onClick={() => setFilter("all")}
          >
            All {report.games.length} games
          </Button>
        </div>
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:hidden" role="group" aria-label="Sort games">
          {SORTS.map((column) => {
            const active = sort.key === column.key;
            return (
              <Button
                key={column.key}
                type="button"
                size="sm"
                variant={active ? "default" : "outline"}
                aria-pressed={active}
                className="h-11 shrink-0 px-3"
                onClick={() => chooseSort(column.key)}
              >
                {column.label}
                <span aria-hidden="true" className="text-[10px]">
                  {active ? (sort.direction === "asc" ? "▲" : "▼") : "↕"}
                </span>
              </Button>
            );
          })}
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line bg-card px-4 py-8 text-center text-sm text-muted-foreground">
          No price checks yet.
        </p>
      ) : (
        <>
          <SeasonCards games={visible} />
          <SeasonTable games={visible} sort={sort} onSort={chooseSort} />
        </>
      )}

      <details className="mt-4 rounded-xl border border-line bg-card px-4 py-3 text-sm leading-relaxed text-[#3d4654]">
        <summary className="flex min-h-11 cursor-pointer items-center font-semibold text-navy">How to read this</summary>
        <div className="mt-3 space-y-2">
          <p>
            Similar seats are {bandPhrase(report.band)}, at least two together. The median is the middle of those
            prices. The cheapest line is the lowest of those same seats. Your ask is the number to type today. You keep
            95% of it, and both seats pay twice that.
          </p>
          <p>
            7-day change compares the latest median with the one from about a week earlier. Since first check compares
            it with the first median we saved. By tip is only a rough sketch from this game’s recent pace. It is not a
            promise. A game without enough checks says so instead of guessing.
          </p>
        </div>
      </details>
    </div>
  );
}

function GameView({ report, game }: { report: TrendsReport; game: TrendsGame }) {
  const checksLabel = game.checks === 1 ? "1 price check" : `${game.checks} price checks`;
  const span =
    game.series.length > 0
      ? `${monthDay(game.series[0]?.date ?? null)} through ${monthDay(game.series[game.series.length - 1]?.date ?? null)}`
      : null;
  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-16 pt-4 sm:px-4 sm:pt-5">
      <header className="rounded-2xl bg-navy px-4 py-3 text-navy-foreground sm:px-5 sm:py-4">
        <div className="flex items-start justify-between gap-3">
          <p className="m-0 text-[13px] font-medium leading-snug text-[#f3e6c8]">
            Capital One Arena · Section {report.section} Row {report.row}
          </p>
          <SiteNav trendsCurrent={false} />
        </div>
        <h1 className="font-heading mt-0.5 text-[24px] leading-none tracking-tight sm:text-[30px]">{game.opponent}</h1>
        <p className="mt-1.5 text-sm leading-snug text-[#e4eaf3]">
          {formatGameDate(game.date, game.weekday)} {formatYear(game.date)}
          {game.timeEt ? ` · ${game.timeEt} ET` : ""}
          {game.daysOut != null ? ` · ${formatDaysOut(game.daysOut)}` : ""}
          {game.type === "preseason" ? " · Preseason" : ""}
        </p>
      </header>

      <p className="mt-3">
        <a href="/trends" className="inline-flex min-h-11 items-center text-sm font-semibold text-navy underline underline-offset-2">
          All games
        </a>
      </p>

      <section className="mt-1 rounded-2xl border border-line bg-card px-4 py-4">
        <p className="text-lg font-medium leading-snug text-navy">{game.projection.sentence}</p>
        {game.projection.enough && game.projection.low != null && game.projection.high != null ? (
          <p className="mt-2 text-sm text-[#3d4654]">
            Rough range {formatMoney(game.projection.low)} to {formatMoney(game.projection.high)} per seat. This is a
            pace sketch, not a promise.
          </p>
        ) : null}
      </section>

      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="Median" value={formatMoney(game.latestMedian)} />
        <Stat label="Cheapest similar seat" value={formatMoney(game.latestCheapest)} />
        <Stat label="Your ask" value={formatMoney(game.ask)} />
        <Stat label="You keep" value={formatMoney(game.keep)} />
        <Stat label="Both seats" value={formatMoney(game.pair)} />
        <Stat label="7-day" value={formatSignedPercent(game.change7d)} tone={percentClass(game.change7d)} />
      </dl>

      <section aria-labelledby="game-chart-heading" className="mt-4 rounded-2xl border border-line bg-card px-3 py-3 sm:px-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="game-chart-heading" className="text-base font-semibold text-navy">
            Price over time
          </h2>
          <p className="text-sm text-muted-foreground">
            {checksLabel}
            {span ? ` · ${span}` : ""}
          </p>
        </div>
        <div className="mt-2">
          <PriceTrendChart
            points={game.series}
            ask={game.ask}
            today={report.today}
            gameDate={game.date}
            projection={game.projection}
            title={`${game.opponent} similar-seat prices`}
          />
        </div>
      </section>

      <details className="mt-4 rounded-xl border border-line bg-card px-4 py-3 text-sm leading-relaxed text-[#3d4654]">
        <summary className="flex min-h-11 cursor-pointer items-center font-semibold text-navy">Numbers behind the chart</summary>
        {game.series.length === 0 ? (
          <p className="mt-3">No similar-seat prices yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[280px] text-left">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-1 pr-3 font-semibold">Date</th>
                  <th className="py-1 pr-3 font-semibold">Median</th>
                  <th className="py-1 font-semibold">Cheapest</th>
                </tr>
              </thead>
              <tbody>
                {game.series.map((point) => (
                  <tr key={point.date} className="border-t border-line">
                    <td className="py-1.5 pr-3">{monthDay(point.date)}</td>
                    <td className="py-1.5 pr-3 tabular-nums">{formatMoney(point.median)}</td>
                    <td className="py-1.5 tabular-nums">{formatMoney(point.cheapest)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-line bg-card px-3 py-2.5">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 text-base font-semibold tabular-nums text-navy", tone)}>{value}</dd>
    </div>
  );
}

export function TrendsPage() {
  const selected = gameFromLocation();
  const [report, setReport] = useState<TrendsReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = selected ? "Game trend · Wizards 107P" : "Price trends · Wizards 107P";
  }, [selected]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/trends")
      .then((res) => {
        if (!res.ok) throw new Error("unavailable");
        return res.json() as Promise<TrendsReport>;
      })
      .then((data) => {
        if (!cancelled) setReport(data);
      })
      .catch(() => {
        if (!cancelled) setError("Price history is unavailable right now. Try again in a minute.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="font-heading text-2xl text-navy">Price trends</h1>
        <p className="mt-3 text-muted-foreground">{error}</p>
        <a href="/" className="mt-4 inline-flex min-h-11 items-center font-semibold text-navy underline">
          Back to the book
        </a>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="mx-auto max-w-[1180px] px-3 pt-4 sm:px-4" aria-busy="true" aria-live="polite">
        <p className="sr-only">Opening price trends</p>
        <div className="h-28 animate-pulse rounded-2xl bg-navy/90" />
        <div className="mt-3 h-16 animate-pulse rounded-xl bg-white ring-1 ring-line" />
        <div className="mt-4 h-56 animate-pulse rounded-2xl bg-white ring-1 ring-line" />
        <p className="mt-4 text-center text-sm text-muted-foreground">Opening price trends…</p>
      </div>
    );
  }

  if (!selected) return <SeasonView report={report} />;
  const game = report.games.find((row) => row.date === selected);
  if (!game) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="font-heading text-2xl text-navy">That game is not on this book</h1>
        <a href="/trends" className="mt-4 inline-flex min-h-11 items-center font-semibold text-navy underline">
          All games
        </a>
      </div>
    );
  }
  return <GameView report={report} game={game} />;
}
