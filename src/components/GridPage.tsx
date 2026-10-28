import { useEffect, useMemo, useState } from "react";
import { SearchIcon } from "lucide-react";
import { pairFromTypeIn, SELLER_KEEP_RATE } from "@shared/book";
import { formatGameDate } from "@shared/format";
import { freshness, type FreshTone } from "@shared/freshness";
import {
  formatEtClock,
  gridToCsv,
  GRID_METRICS,
  pointCaption,
  type GridGame,
  type GridMetricId,
  type GridPoint,
  type PriceGrid,
} from "@shared/grid";
import { gameMatchesQuery } from "@/lib/game-search";
import { Disclosure, HowThisWorks, Loading, Message, PageShell } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { money } from "@/lib/money";

const METRIC_KEY = "wizards-107p-grid-metrics";
const KEEP_KEY = "wizards-107p-grid-keep";
const DEFAULT_METRICS: GridMetricId[] = ["suggested", "median", "high", "get_in", "comps"];
type Metric = (typeof GRID_METRICS)[number];

/** Green under 24 hours, amber under 72, red older. */
const CELL_TONE: Record<FreshTone, string> = {
  fresh: "bg-emerald-50 text-emerald-900",
  aging: "bg-amber-50 text-amber-900",
  stale: "bg-red-50 text-red-900",
};

const DOT: Record<FreshTone, string> = {
  fresh: "bg-emerald-500",
  aging: "bg-amber-500",
  stale: "bg-red-500",
};

function readMetrics(): GridMetricId[] {
  try {
    const raw = localStorage.getItem(METRIC_KEY);
    if (!raw) return DEFAULT_METRICS;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_METRICS;
    const known = new Set(GRID_METRICS.map((metric) => metric.id));
    const picked = parsed.filter((id): id is GridMetricId => typeof id === "string" && known.has(id as GridMetricId));
    return picked.length > 0 ? picked : DEFAULT_METRICS;
  } catch {
    return DEFAULT_METRICS;
  }
}

function readKeep(): boolean {
  try {
    return localStorage.getItem(KEEP_KEY) === "1";
  } catch {
    return false;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode can block storage. The choice still lasts for this view.
  }
}

function dayLabel(ymd: string): string {
  return formatGameDate(ymd, "").trim();
}

function downloadCsv(text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "wizards-107p-grid.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function valueText(point: GridPoint, metric: Metric): string {
  return metric.kind === "price" ? money(point.value) : String(point.value);
}

function pulledOn(game: GridGame, day: string): boolean {
  const cell = game.cells[day];
  return cell != null && Object.values(cell).some(Boolean);
}

/** Price plus pull time; tapping the time shows the exact pull and source. */
function PointValue({
  point,
  metric,
  keep,
  onPick,
}: {
  point: GridPoint;
  metric: Metric;
  keep: boolean;
  onPick: (caption: string) => void;
}) {
  const caption = pointCaption(point);
  return (
    <>
      <span className="font-medium tabular-nums">{valueText(point, metric)}</span>
      {keep && metric.kind === "price" ? (
        <span className="block text-xs tabular-nums opacity-80">keep {money(pairFromTypeIn(point.value))}</span>
      ) : null}
      <button type="button" className="block text-xs underline underline-offset-2 opacity-80" title={caption} aria-label={caption} onClick={() => onPick(caption)}>
        {formatEtClock(point.pulledAt) || "time"}
      </button>
    </>
  );
}

/** Phone: one card per game for the chosen day. */
function GameDayCard({
  game,
  day,
  metrics,
  keep,
  now,
  onPick,
}: {
  game: GridGame;
  day: string;
  metrics: Metric[];
  keep: boolean;
  now: Date;
  onPick: (caption: string) => void;
}) {
  const cell = game.cells[day];
  return (
    <Card className="gap-3 px-4 py-4">
      <div>
        <h2 className="text-base font-semibold leading-snug text-navy">
          <a href={`/trends/${game.date}`} className="hover:underline">
            {game.opponent}
          </a>
        </h2>
        <p className="text-sm text-muted-foreground">{formatGameDate(game.date, game.weekday)}</p>
      </div>
      <dl className="grid grid-cols-2 gap-3">
        {metrics.map((metric) => {
          const point = cell?.[metric.id];
          return (
            <div key={metric.id} className="min-w-0">
              <dt className="flex items-center gap-1.5 text-sm text-muted-foreground">
                {point ? <span aria-hidden="true" className={cn("size-1.5 rounded-full", DOT[freshness(point.pulledAt, now).tone])} /> : null}
                {metric.label}
              </dt>
              <dd className="text-base">
                {point ? <PointValue point={point} metric={metric} keep={keep} onPick={onPick} /> : <span className="text-muted-foreground">—</span>}
              </dd>
            </div>
          );
        })}
      </dl>
    </Card>
  );
}

export function GridPage() {
  const [grid, setGrid] = useState<PriceGrid | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<GridMetricId[]>(readMetrics);
  const [keep, setKeep] = useState(readKeep);
  const [team, setTeam] = useState("");
  const [day, setDay] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const now = useMemo(() => new Date(), []);

  useEffect(() => {
    document.title = "Price grid · Wizards 107P";
    let cancelled = false;
    fetch("/api/grid")
      .then((res) => {
        if (!res.ok) throw new Error("unavailable");
        return res.json() as Promise<PriceGrid>;
      })
      .then((data) => {
        if (!cancelled) setGrid(data);
      })
      .catch(() => {
        if (!cancelled) setError("The price grid is unavailable right now. Try again in a minute.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function toggleMetric(id: GridMetricId) {
    setMetrics((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
      const stored = next.length > 0 ? next : current;
      store(METRIC_KEY, JSON.stringify(stored));
      return stored;
    });
  }

  function toggleKeep(next: boolean) {
    setKeep(next);
    store(KEEP_KEY, next ? "1" : "0");
  }

  const selected = GRID_METRICS.filter((metric) => metrics.includes(metric.id));
  const visible = useMemo(() => {
    if (!grid) return [];
    const query = team.trim();
    if (!query) return grid.games;
    return grid.games.filter((game) => gameMatchesQuery({ date: game.date, weekday: game.weekday, opponent: game.opponent }, query));
  }, [grid, team]);

  function download() {
    if (!grid) return;
    const filtered = {
      ...grid,
      metrics: selected.map((metric) => ({ id: metric.id, label: metric.label, kind: metric.kind })),
      games: visible,
    };
    downloadCsv(gridToCsv(filtered, { keep }));
  }

  if (error) return <Message title="Price grid" body={error} link={{ href: "/", label: "Back to the book" }} />;
  if (!grid) return <Loading label="Opening the price grid" />;

  const shownDay = day ?? grid.days[0] ?? "";
  const quiet = visible.filter((game) => !pulledOn(game, shownDay)).length;

  return (
    <PageShell title="Price grid" current="grid" subtitle={`${grid.games.length} games over ${grid.days.length} days`} updatedAt={grid.asof} wide>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div role="search" className="min-w-0 flex-1">
          <InputGroup className="h-11 bg-card">
            <InputGroupAddon align="inline-start">
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={team}
              onChange={(event) => setTeam(event.target.value)}
              placeholder="Search team or date"
              aria-label="Search games"
              className="text-base"
            />
          </InputGroup>
        </div>
        <Select value={shownDay} onValueChange={setDay}>
          <SelectTrigger aria-label="Day" className="h-11 bg-card sm:w-40 md:hidden">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {grid.days.map((item) => (
              <SelectItem key={item} value={item}>
                {dayLabel(item)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card className="mt-3 gap-0 px-4 py-1">
        <Disclosure title={`Metrics (${selected.length} shown)`}>
          <div className="space-y-3 pb-4">
            <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-5">
              {GRID_METRICS.map((metric) => (
                <label key={metric.id} className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm">
                  <Checkbox checked={metrics.includes(metric.id)} onCheckedChange={() => toggleMetric(metric.id)} />
                  {metric.label}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-4 border-t pt-3">
              <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm">
                <Checkbox checked={keep} onCheckedChange={(next) => toggleKeep(next === true)} />
                Show what you keep
              </label>
              <Button type="button" variant="outline" className="h-11" onClick={download}>
                Download CSV
              </Button>
            </div>
          </div>
        </Disclosure>
      </Card>

      {detail ? (
        <p className="mt-3 text-sm text-navy" role="status">
          {detail}
        </p>
      ) : null}

      {visible.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No games match.</p> : null}

      <div className="mt-4 grid gap-4 md:hidden">
        {visible.filter((game) => pulledOn(game, shownDay)).map((game) => (
          <GameDayCard key={game.date} game={game} day={shownDay} metrics={selected} keep={keep} now={now} onPick={setDetail} />
        ))}
      </div>

      {quiet > 0 ? (
        <p className="mt-4 text-sm text-muted-foreground md:hidden">
          {quiet} {quiet === 1 ? "game had" : "games had"} no pull on {dayLabel(shownDay)}.
        </p>
      ) : null}

      {visible.length > 0 ? (
        <Card className="mt-4 hidden max-h-[calc(100dvh-6rem)] overflow-auto p-0 md:block">
          <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
            <caption className="sr-only">Prices by game and day, newest day first</caption>
            <thead>
              <tr>
                <th scope="col" className="sticky top-0 left-0 z-30 bg-muted px-3 py-2 text-left font-medium shadow-[inset_-1px_-1px_0_var(--border)]">
                  Game
                </th>
                {grid.days.map((item) => (
                  <th key={item} scope="col" title={item} className="sticky top-0 z-20 bg-muted px-3 py-2 text-left font-medium whitespace-nowrap shadow-[inset_0_-1px_0_var(--border)]">
                    {dayLabel(item)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((game) => (
                <tr key={game.date} className="align-top">
                  <th scope="row" className="sticky left-0 z-10 min-w-36 bg-card px-3 py-2 text-left font-normal shadow-[inset_-1px_-1px_0_var(--border)]">
                    <a href={`/trends/${game.date}`} className="font-medium text-navy hover:underline">
                      {game.opponent}
                    </a>
                    <span className="block text-muted-foreground">{formatGameDate(game.date, game.weekday)}</span>
                  </th>
                  {grid.days.map((item) => {
                    const cell = game.cells[item];
                    return (
                      <td key={item} className="min-w-24 space-y-1 px-2 py-2 shadow-[inset_0_-1px_0_var(--border)]">
                        {selected.map((metric) => {
                          const point = cell?.[metric.id];
                          return (
                            <div
                              key={metric.id}
                              className={cn("rounded-md px-1.5 py-1 leading-tight", point ? CELL_TONE[freshness(point.pulledAt, now).tone] : "text-muted-foreground")}
                            >
                              {selected.length > 1 ? <span className="block text-xs opacity-80">{metric.label}</span> : null}
                              {point ? <PointValue point={point} metric={metric} keep={keep} onPick={setDetail} /> : <span aria-label={`${metric.label} not pulled`}>—</span>}
                            </div>
                          );
                        })}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      <HowThisWorks>
        <p>
          Each price is the per-seat number to type in, and you keep it × 2 × {SELLER_KEEP_RATE} for both seats after the{" "}
          {Math.round((1 - SELLER_KEEP_RATE) * 100)}% fee. The dot or tint is green under 24 hours old, amber under 72 and red
          when older, and a dash means no pull that day. Tap a time to see the exact pull and its source.
        </p>
      </HowThisWorks>
    </PageShell>
  );
}
