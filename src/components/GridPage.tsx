import { useEffect, useMemo, useState } from "react";
import { pairFromTypeIn } from "@shared/book";
import { formatGameDate, formatMoney } from "@shared/format";
import { freshness, type FreshTone } from "@shared/freshness";
import {
  formatEtClock,
  gridToCsv,
  GRID_METRICS,
  pointCaption,
  type GridMetricId,
  type GridPoint,
  type PriceGrid,
} from "@shared/grid";
import { SiteNav } from "@/components/SiteNav";
import { gameMatchesQuery } from "@/lib/game-search";

const METRIC_KEY = "wizards-107p-grid-metrics";
const KEEP_KEY = "wizards-107p-grid-keep";
const DEFAULT_METRICS: GridMetricId[] = ["suggested", "median", "high", "get_in", "comps"];

const TONE: Record<FreshTone, string> = {
  fresh: "fresh",
  aging: "aging",
  stale: "stale",
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

function dayLabel(ymd: string): string {
  const parts = ymd.split("-");
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  if (!month || !day) return ymd;
  return `${names[month - 1]} ${day}`;
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

function MetricLine({
  point,
  label,
  showName,
  showKeep,
  kind,
  now,
  onPick,
}: {
  point: GridPoint;
  label: string;
  showName: boolean;
  showKeep: boolean;
  kind: "price" | "count";
  now: Date;
  onPick: (caption: string) => void;
}) {
  const tone = TONE[freshness(point.pulledAt, now).tone];
  const caption = pointCaption(point);
  const clock = formatEtClock(point.pulledAt);
  const price = kind === "price" ? formatMoney(point.value) : String(point.value);
  return (
    <div className={`grid-val ${tone}`}>
      {showName ? <span className="grid-metric-name">{label}</span> : null}
      <span className="grid-price">{price}</span>
      {showKeep && kind === "price" ? <span className="grid-keep">keep {formatMoney(pairFromTypeIn(point.value))}</span> : null}
      <button type="button" className="grid-time" title={caption} aria-label={caption} onClick={() => onPick(caption)}>
        {clock || "time"}
      </button>
    </div>
  );
}

export function GridPage() {
  const [grid, setGrid] = useState<PriceGrid | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<GridMetricId[]>(readMetrics);
  const [keep, setKeep] = useState(readKeep);
  const [team, setTeam] = useState("");
  const [detail, setDetail] = useState<string | null>(null);
  const now = useMemo(() => new Date(), []);

  useEffect(() => {
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
      try {
        localStorage.setItem(METRIC_KEY, JSON.stringify(stored));
      } catch {
        // Private mode can block storage. The choice still lasts for this view.
      }
      return stored;
    });
  }

  function toggleKeep() {
    setKeep((current) => {
      const next = !current;
      try {
        localStorage.setItem(KEEP_KEY, next ? "1" : "0");
      } catch {
        // Same as the metric choice.
      }
      return next;
    });
  }

  const selected = GRID_METRICS.filter((metric) => metrics.includes(metric.id));
  const visible = useMemo(() => {
    if (!grid) return [];
    const query = team.trim();
    if (!query) return grid.games;
    return grid.games.filter((game) =>
      gameMatchesQuery({ date: game.date, weekday: game.weekday, opponent: game.opponent }, query),
    );
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

  if (error) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="font-heading text-2xl text-navy">Price grid</h1>
        <p className="mt-3 text-muted-foreground">{error}</p>
        <a href="/" className="mt-4 inline-flex min-h-11 items-center font-semibold text-navy underline">
          Back to the book
        </a>
      </div>
    );
  }

  if (!grid) {
    return (
      <div className="mx-auto max-w-[1180px] px-3 pt-4 sm:px-4" aria-busy="true" aria-live="polite">
        <p className="sr-only">Opening the price grid</p>
        <div className="h-28 animate-pulse rounded-2xl bg-navy/90" />
        <div className="mt-3 h-16 animate-pulse rounded-xl bg-white ring-1 ring-line" />
        <div className="mt-3 h-80 animate-pulse rounded-xl bg-white ring-1 ring-line" />
      </div>
    );
  }

  const showName = selected.length > 1;

  return (
    <div className="mx-auto max-w-[1400px] px-3 pb-16 pt-4 sm:px-4 sm:pt-5">
      <header className="rounded-2xl bg-navy px-4 py-3 text-navy-foreground sm:px-5 sm:py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="m-0 text-[13px] font-medium leading-snug text-[#f3e6c8]">Per seat · newest day first</p>
          <SiteNav current="grid" admin />
        </div>
        <h1 className="font-heading mt-0.5 text-[24px] leading-none tracking-tight sm:text-[30px]">Price grid</h1>
        <p className="mt-1.5 text-sm leading-snug text-[#e4eaf3]">
          {grid.games.length} games · {grid.days.length} days · type-in prices
        </p>
      </header>

      <div className="mt-3 flex flex-col gap-3">
        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Metrics</legend>
          <div className="flex flex-wrap gap-1.5">
            {GRID_METRICS.map((metric) => {
              const on = metrics.includes(metric.id);
              return (
                <label
                  key={metric.id}
                  className={
                    on
                      ? "inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full bg-navy px-3 text-sm font-semibold text-white"
                      : "inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full bg-white px-3 text-sm font-semibold text-navy ring-1 ring-line"
                  }
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-navy"
                    checked={on}
                    onChange={() => toggleMetric(metric.id)}
                  />
                  {metric.label}
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <label className="block min-w-0 flex-1 text-sm font-semibold text-navy">
            Team
            <input
              type="search"
              value={team}
              onChange={(event) => setTeam(event.target.value)}
              placeholder="Bucks, Lakers…"
              className="mt-1 w-full min-h-11 rounded-lg border border-line bg-white px-3 text-base font-medium text-navy outline-none focus-visible:ring-2 focus-visible:ring-navy/40"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-white px-3 text-sm font-semibold text-navy ring-1 ring-line">
              <input type="checkbox" className="size-4 accent-navy" checked={keep} onChange={toggleKeep} />
              Show keep
            </label>
            <button
              type="button"
              onClick={download}
              className="inline-flex min-h-11 items-center rounded-lg bg-navy px-3 text-sm font-semibold text-white"
            >
              Download CSV
            </button>
          </div>
        </div>
        <p className="m-0 text-xs leading-snug text-muted-foreground">
          Each price is the per-seat number to type in. Keep is that number × 2 × 0.95, what both seats pay after the 5% fee.
          Green is under 24 hours, amber under 72, red is older. A dash means no pull that day.
        </p>
        <p className="m-0 min-h-6 text-sm font-medium text-navy" role="status">
          {detail ?? "Tap a time for the exact pull, in ET, and the source."}
        </p>
      </div>

      <div className="price-grid-scroll mt-2">
        <table className="price-grid">
          <caption className="sr-only">Prices by game and day, newest day first</caption>
          <thead>
            <tr>
              <th scope="col" className="game">
                Game
              </th>
              {grid.days.map((day) => (
                <th key={day} scope="col" className="day" title={day}>
                  {dayLabel(day)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td className="game" colSpan={Math.max(1, grid.days.length + 1)}>
                  No games match this team.
                </td>
              </tr>
            ) : (
              visible.map((game) => (
                <tr key={game.date}>
                  <th scope="row" className="game">
                    <a href={`/trends/${game.date}`} className="font-semibold text-navy underline-offset-2 hover:underline">
                      {game.opponent}
                    </a>
                    <span className="mt-0.5 block text-xs font-medium text-muted-foreground">
                      {formatGameDate(game.date, game.weekday)}
                    </span>
                  </th>
                  {grid.days.map((day) => {
                    const cell = game.cells[day];
                    return (
                      <td key={day} className="day">
                        {selected.map((metric) => {
                          const point = cell?.[metric.id];
                          if (!point) {
                            return (
                              <div key={metric.id} className="grid-miss">
                                {showName ? <span className="grid-metric-name">{metric.label}</span> : null}
                                <span aria-label={`${metric.label} not pulled`}>—</span>
                              </div>
                            );
                          }
                          return (
                            <MetricLine
                              key={metric.id}
                              point={point}
                              label={metric.label}
                              showName={showName}
                              showKeep={keep}
                              kind={metric.kind}
                              now={now}
                              onPick={setDetail}
                            />
                          );
                        })}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
