import { useEffect, useMemo, useState } from "react";
import { cashGamesFor, type TrendsGame, type TrendsReport } from "@shared/trends";
import {
  keepingSentence,
  planSeason,
  soldSuggestion,
  suggestionFromOffer,
  takeInstantSuggestion,
  withKeeping,
  type ListSuggestion,
  type SeasonOutlook,
} from "@shared/price-model";
import { formatChance, formatGameDate, formatMoney, formatYear } from "@shared/format";
import { formatDaysOut } from "@shared/pricing";
import { readScenario, writeScenario, type ScenarioChoice, type ScenarioMap } from "@/lib/scenario";
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
import { CheckedBadge } from "@/components/CheckedBadge";
import { FreshBadge, FreshRow } from "@/components/FreshBadge";
import { SiteNav } from "@/components/SiteNav";
import { SitSellToggle } from "@/components/SitSellToggle";
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

function ChangeText({ value, large = false }: { value: number | null; large?: boolean }) {
  return (
    <span className={cn("font-semibold tabular-nums", large ? "text-lg" : "text-base", percentClass(value))}>
      {formatSignedPercent(value)}
    </span>
  );
}

function GameSentence({ game }: { game: TrendsGame }) {
  return game.projection.sentence ? <p className="text-sm leading-snug text-[#3d4654]">{game.projection.sentence}</p> : null;
}

function choiceOf(game: TrendsGame, scenario: ScenarioMap): string {
  const override = scenario[game.date];
  if (override === "Sit" || override === "Sell") return override;
  return game.sitOrSell || "TBD";
}

function useScenario(): { scenario: ScenarioMap; choose: (game: TrendsGame, choice: ScenarioChoice) => void } {
  const [scenario, setScenario] = useState<ScenarioMap>(() => readScenario());
  function choose(game: TrendsGame, choice: ScenarioChoice) {
    const next = { ...scenario };
    if ((game.sitOrSell || "TBD") === choice) delete next[game.date];
    else next[game.date] = choice;
    writeScenario(next);
    setScenario(next);
  }
  return { scenario, choose };
}

function planFor(report: TrendsReport, scenario: ScenarioMap): SeasonOutlook {
  return planSeason(cashGamesFor(report.games, (game) => choiceOf(game, scenario) === "Sit"), {
    breakEven: report.outlook.breakEven,
    cushion: report.outlook.cushion,
  });
}

function suggestionFor(game: TrendsGame, outlook: SeasonOutlook, scenario: ScenarioMap): ListSuggestion | null {
  if (game.sold) return soldSuggestion(game.banked);
  if (choiceOf(game, scenario) === "Sit") return null;
  if (game.takeInstant && game.instantOffer) {
    return takeInstantSuggestion(game.instantOffer.total, game.instantOffer.perTicket);
  }
  const chosen = outlook.asks[game.date];
  if (!chosen) return null;
  return suggestionFromOffer(chosen);
}

function keepingNote(report: TrendsReport, game: TrendsGame, scenario: ScenarioMap, outlook: SeasonOutlook): string | null {
  if (game.sold || (game.daysOut != null && game.daysOut < 0)) return null;
  const keeping = choiceOf(game, scenario) === "Sit";
  const cash = cashGamesFor(report.games, (item) => choiceOf(item, scenario) === "Sit");
  const flipped = planSeason(withKeeping(cash, game.date, !keeping), {
    breakEven: outlook.breakEven,
    cushion: outlook.cushion,
  });
  return keepingSentence(outlook, flipped, keeping);
}

function CashPlan({ outlook }: { outlook: SeasonOutlook }) {
  return (
    <section aria-labelledby="cash-plan-heading" className="mt-4 rounded-2xl border border-line bg-card px-4 py-4">
      <h2 id="cash-plan-heading" className="text-base font-semibold text-navy">
        Season cash
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-[#3d4654]">{outlook.sentence}</p>
      <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="rounded-xl bg-[#faf8f4] px-3 py-2">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Already in</dt>
          <dd className="text-lg font-semibold tabular-nums text-navy">{formatMoney(outlook.banked)}</dd>
        </div>
        <div className="rounded-xl bg-[#faf8f4] px-3 py-2">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Still to come</dt>
          <dd className="text-lg font-semibold tabular-nums text-navy">{formatMoney(outlook.expectedRest)}</dd>
        </div>
        <div className="rounded-xl bg-[#faf8f4] px-3 py-2">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            Odds of {formatMoney(outlook.target)}
          </dt>
          <dd className="text-lg font-semibold tabular-nums text-navy">{formatChance(outlook.chance)}</dd>
        </div>
      </dl>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {outlook.kept} on Sit · {outlook.forSale} for sale · {outlook.priced} priced · Sit takes a game out of the plan
      </p>
    </section>
  );
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
  scenario,
  outlook,
  onChoose,
}: {
  games: TrendsGame[];
  sort: { key: SortKey; direction: SortDirection };
  onSort: (key: SortKey) => void;
  scenario: ScenarioMap;
  outlook: SeasonOutlook;
  onChoose: (game: TrendsGame, choice: ScenarioChoice) => void;
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
                    <AskLine game={game} outlook={outlook} scenario={scenario} />
                  </div>
                  {game.sold ? null : (
                    <div className="mt-2">
                      <SitSellToggle className="max-w-[11.5rem]" value={choiceOf(game, scenario)} opponent={game.opponent} onChange={(choice) => onChoose(game, choice)} />
                    </div>
                  )}
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
                  {game.projection.enough ? formatMoney(game.projection.price) : "Not enough data"}
                  {game.projection.enough && game.projection.low != null && game.projection.high != null ? (
                    <span className="mt-0.5 block text-xs font-medium text-muted-foreground">
                      {formatMoney(game.projection.low)} – {formatMoney(game.projection.high)}
                    </span>
                  ) : null}
                  {game.projection.early ? (
                    <span className="mt-0.5 block text-xs font-medium text-muted-foreground">Early estimate</span>
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

function AskLine({ game, outlook, scenario }: { game: TrendsGame; outlook: SeasonOutlook; scenario: ScenarioMap }) {
  if (game.sold) return <p className="mt-1 text-xs font-medium text-muted-foreground">Sold</p>;
  if (choiceOf(game, scenario) === "Sit") {
    return <p className="mt-1 text-xs font-medium text-muted-foreground">Sit · left out of the cash plan</p>;
  }
  if (game.takeInstant && game.instantOffer) {
    return (
      <p className="mt-1 text-xs font-medium text-navy">
        Take the instant offer · {formatMoney(game.instantOffer.total)} for the pair
      </p>
    );
  }
  const suggestion = suggestionFor(game, outlook, scenario);
  if (!suggestion?.ask) return null;
  return (
    <p className="mt-1 text-xs font-medium text-navy">
      Suggested ask {formatMoney(suggestion.ask)}
      {suggestion.saleChance != null ? ` · ${formatChance(suggestion.saleChance)} chance` : ""}
    </p>
  );
}

function SeasonCards({
  games,
  scenario,
  outlook,
  onChoose,
}: {
  games: TrendsGame[];
  scenario: ScenarioMap;
  outlook: SeasonOutlook;
  onChoose: (game: TrendsGame, choice: ScenarioChoice) => void;
}) {
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
            <AskLine game={game} outlook={outlook} scenario={scenario} />
          </div>
          {game.sold ? null : (
            <div className="mt-2">
              <SitSellToggle className="max-w-[11.5rem]" value={choiceOf(game, scenario)} opponent={game.opponent} onChange={(choice) => onChoose(game, choice)} />
            </div>
          )}
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
                {game.projection.enough ? formatMoney(game.projection.price) : "Not enough data"}
                {game.projection.early ? (
                  <span className="mt-0.5 block text-xs font-medium text-muted-foreground">Early estimate</span>
                ) : null}
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
  const { scenario, choose } = useScenario();
  const outlook = useMemo(() => planFor(report, scenario), [report, scenario]);
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-heading text-[24px] leading-none tracking-tight sm:text-[30px]">Price trends</h1>
          <SiteNav current="trends" />
        </div>
        <p className="mt-1.5 text-sm leading-snug text-[#e4eaf3]">Prices are per seat, for seats like Section {report.section}, Row {report.row}.</p>
        <FreshRow className="mt-2">
          <FreshBadge source="Comps" at={report.lastPulledAt} />
          <FreshBadge source="Instant offers" at={report.lastOfferAt} />
        </FreshRow>
      </header>

      <section
        aria-label="Trend summary"
        className="sticky top-0 z-40 -mx-3 mt-3 border-y border-line bg-[#f4f1ea]/95 px-3 py-2 shadow-[0_8px_18px_rgba(12,35,64,0.06)] backdrop-blur-md sm:-mx-4 sm:px-4"
      >
        <p className="text-[15px] font-semibold leading-snug text-navy">
          {report.gamesWithChecks} games checked
          {report.firstCheck && report.lastCheck
            ? ` · ${monthDay(report.firstCheck)}–${monthDay(report.lastCheck)}`
            : ""}
        </p>
        <p className="text-sm leading-snug text-[#3d4654]">
          7 days: <span className="text-emerald-700">{up} up</span>, <span className="text-red-700">{down} down</span>
        </p>
      </section>

      <CashPlan outlook={outlook} />

      <section aria-labelledby="days-out-heading" className="mt-4 rounded-2xl border border-line bg-card px-3 py-3 sm:px-4">
        <h2 id="days-out-heading" className="text-base font-semibold text-navy">
          How prices move toward tip
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {dots.length} checks · {report.gamesWithChecks} games
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
            Checked
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
          <SeasonCards games={visible} scenario={scenario} outlook={outlook} onChoose={choose} />
          <SeasonTable games={visible} sort={sort} onSort={chooseSort} scenario={scenario} outlook={outlook} onChoose={choose} />
        </>
      )}

      <details className="mt-4 rounded-xl border border-line bg-card px-4 py-3 text-sm leading-relaxed text-[#3d4654]">
        <summary className="flex min-h-11 cursor-pointer items-center font-semibold text-navy">How to read this</summary>
        <div className="mt-3 space-y-2">
          <p>
            Similar seats are {bandPhrase(report.band)}, pairs or bigger, since a buyer of this pair compares pairs.
            Median is the middle price; cheapest is the low end of those same seats. Your ask is what to type today:
            you keep 95%, both seats pay double.
          </p>
          <p>
            7-day compares today&apos;s median with a week ago, and by tip is where the model expects the price to land on game day.
          </p>
        </div>
      </details>
      <section className="mt-4 rounded-xl border border-line bg-card px-4 py-3 text-sm leading-relaxed text-[#3d4654]">
        <h2 className="text-base font-semibold text-navy">How the model works</h2>
        <p className="mt-2">{report.modelNote}</p>
      </section>
    </div>
  );
}

function GameView({ report, game }: { report: TrendsReport; game: TrendsGame }) {
  const { scenario, choose } = useScenario();
  const outlook = useMemo(() => planFor(report, scenario), [report, scenario]);
  const suggestion = suggestionFor(game, outlook, scenario);
  const note = keepingNote(report, game, scenario, outlook);
  const checksLabel = game.checks === 1 ? "1 check" : `${game.checks} checks`;
  const span =
    game.series.length > 0
      ? `${monthDay(game.series[0]?.date ?? null)}–${monthDay(game.series[game.series.length - 1]?.date ?? null)}`
      : null;
  const suggested = game.sold
    ? "Sold"
    : suggestion?.takeInstant
      ? "Take offer"
      : suggestion?.hold
        ? choiceOf(game, scenario) === "Sit"
          ? "Sit"
          : "—"
        : formatMoney(suggestion?.ask ?? null);
  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-16 pt-4 sm:px-4 sm:pt-5">
      <header className="rounded-2xl bg-navy px-4 py-3 text-navy-foreground sm:px-5 sm:py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-heading text-[24px] leading-none tracking-tight sm:text-[30px]">{game.opponent}</h1>
          <SiteNav current="trends" />
        </div>
        <p className="mt-1.5 text-sm leading-snug text-[#e4eaf3]">
          {formatGameDate(game.date, game.weekday)} {formatYear(game.date)}
          {game.timeEt ? ` · ${game.timeEt} ET` : ""}
          {game.daysOut != null ? ` · ${formatDaysOut(game.daysOut)}` : ""}
          {game.type === "preseason" ? " · Preseason" : ""}
        </p>
        <FreshRow className="mt-2">
          <CheckedBadge at={game.compsCheckedAt} />
          {game.instantOffer ? <FreshBadge source="Instant offer" at={game.instantOffer.seenAt} /> : null}
        </FreshRow>
      </header>

      <p className="mt-2">
        <a href="/trends" className="inline-flex min-h-11 items-center text-sm font-semibold text-navy underline underline-offset-2">
          ← Price trends
        </a>
      </p>

      <section className="mt-1 rounded-2xl border border-line bg-card px-4 py-4">
        {game.projection.early ? (
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">Early estimate</p>
        ) : null}
        {game.projection.sentence ? <p className="text-lg font-medium leading-snug text-navy">{game.projection.sentence}</p> : null}
        {suggestion ? <p className="mt-2 text-sm text-[#3d4654]">{suggestion.sentence}</p> : null}
        {note ? <p className="mt-2 text-sm text-[#3d4654]">{note}</p> : null}
        {game.sold ? null : (
          <div className="mt-3">
            <SitSellToggle className="max-w-[11.5rem]" value={choiceOf(game, scenario)} opponent={game.opponent} onChange={(choice) => choose(game, choice)} />
          </div>
        )}
      </section>

      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Suggested ask" value={suggested} emphasis />
        <Stat label="Model ask" value={formatMoney(game.ask)} />
        <Stat label="You keep, both" value={formatMoney(game.pair)} />
        <Stat
          label="Instant offer"
          value={game.instantOffer ? `${formatMoney(game.instantOffer.perTicket)}/seat` : "—"}
        />
        <Stat label="Median now" value={formatMoney(game.latestMedian)} />
        <Stat label="Model today" value={formatMoney(game.projection.todayPrice)} />
        <Stat label="Cheapest similar" value={formatMoney(game.latestCheapest)} />
        <Stat label="7-day" value={formatSignedPercent(game.change7d)} tone={percentClass(game.change7d)} />
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">
        Per seat unless noted · season: {formatMoney(outlook.expectedTotal)} expected,{" "}
        {formatChance(outlook.chance)} odds of {formatMoney(outlook.target)} · suggestions only, nothing is listed
        automatically
      </p>

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
            floor={game.instantOffer?.perTicket ?? null}
            title={`${game.opponent} similar-seat prices`}
          />
        </div>
      </section>

      <details className="mt-4 rounded-xl border border-line bg-card px-4 py-3 text-sm leading-relaxed text-[#3d4654]">
        <summary className="flex min-h-11 cursor-pointer items-center font-semibold text-navy">How the model works</summary>
        <p className="mt-3">{report.modelNote}</p>
      </details>

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

function Stat({ label, value, tone, emphasis = false }: { label: string; value: string; tone?: string; emphasis?: boolean }) {
  return (
    <div className={cn("rounded-xl border border-line bg-card px-3 py-2.5", emphasis && "border-navy/30 bg-navy/[0.04]")}>
      <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 font-semibold tabular-nums text-navy", emphasis ? "text-xl" : "text-base", tone)}>{value}</dd>
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
          Price trends
        </a>
      </div>
    );
  }
  return <GameView report={report} game={game} />;
}
