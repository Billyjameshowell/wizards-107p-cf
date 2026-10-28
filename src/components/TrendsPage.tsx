import { useEffect, useMemo, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
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
import { formatChance, formatGameDate } from "@shared/format";
import { formatDaysOut } from "@shared/pricing";
import { readScenario, writeScenario, type ScenarioChoice, type ScenarioMap } from "@/lib/scenario";
import { DaysOutChart, PriceTrendChart, Sparkline } from "@/components/TrendChart";
import { BigNumber, Change, Disclosure, Fact, Gauge, HowThisWorks, Loading, Message, PageShell, Updated } from "@/components/kit";
import { SitSellToggle } from "@/components/SitSellToggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { money } from "@/lib/money";

type SortKey = "date" | "opponent" | "ask" | "median" | "change7d" | "changeSinceFirst" | "projection";
type SortDirection = "asc" | "desc";
type HistoryFilter = "upcoming" | "history" | "all";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "date", label: "Date" },
  { key: "opponent", label: "Opponent" },
  { key: "ask", label: "Ask" },
  { key: "median", label: "Similar seats" },
  { key: "change7d", label: "7-day change" },
  { key: "changeSinceFirst", label: "Since first check" },
  { key: "projection", label: "Price by tip" },
];

function gameFromLocation(): string | null {
  const path = window.location.pathname.replace(/\/+$/, "");
  const match = path.match(/^\/trends\/(\d{4}-\d{2}-\d{2})$/);
  if (match?.[1]) return match[1];
  const query = new URLSearchParams(window.location.search).get("game");
  if (query && /^\d{4}-\d{2}-\d{2}$/.test(query)) return query;
  return null;
}

function dollars(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : money(Math.round(value));
}

function bandPhrase(band: string): string {
  return band.charAt(0).toLowerCase() + band.slice(1);
}

function numberOrNull(game: TrendsGame, key: SortKey): number | null {
  if (key === "ask") return game.ask;
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

/** The one number for a game, and what it means. */
function headline(game: TrendsGame, outlook: SeasonOutlook, scenario: ScenarioMap) {
  if (game.sold) return { label: "Sold", value: money(game.banked), unit: "for the pair", chance: null };
  if (game.daysOut != null && game.daysOut < 0) return { label: "Similar seats at tip", value: dollars(game.latestMedian), unit: "per seat", chance: null };
  if (choiceOf(game, scenario) === "Sit") return { label: "Similar seats now", value: dollars(game.latestMedian), unit: "per seat", chance: null };
  if (game.takeInstant && game.instantOffer) {
    return { label: "Take the instant offer", value: money(game.instantOffer.total), unit: "for the pair", chance: null };
  }
  const suggestion = suggestionFor(game, outlook, scenario);
  if (!suggestion?.ask) return { label: "Ask", value: "—", unit: "no price yet", chance: null };
  return { label: "Ask", value: dollars(suggestion.ask), unit: "per seat", chance: suggestion.saleChance };
}

function dateLine(game: TrendsGame, withTime = false): string {
  return [
    formatGameDate(game.date, game.weekday),
    withTime && game.timeEt ? game.timeEt : null,
    game.daysOut != null && game.daysOut >= 0 ? formatDaysOut(game.daysOut) : null,
    game.type === "preseason" ? "Preseason" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function SeasonCard({ outlook }: { outlook: SeasonOutlook }) {
  return (
    <Card className="gap-3 px-4 py-4">
      <BigNumber label={`Chance of reaching the ${dollars(outlook.target)} goal`} value={formatChance(outlook.chance)} />
      <p className="text-sm text-muted-foreground">
        {money(outlook.banked)} is in, and about {dollars(outlook.expectedRest)} more should come from the {outlook.priced} priced games.
      </p>
    </Card>
  );
}

function GameCard({ game, outlook, scenario }: { game: TrendsGame; outlook: SeasonOutlook; scenario: ScenarioMap }) {
  const big = headline(game, outlook, scenario);
  const sit = !game.sold && choiceOf(game, scenario) === "Sit";
  return (
    <a href={`/trends/${game.date}`} className="block rounded-xl focus-visible:ring-2 focus-visible:ring-ring">
      <Card className="h-full gap-4 px-4 py-4 transition-shadow hover:ring-foreground/25">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-snug text-navy">{game.opponent}</h2>
            <p className="text-sm text-muted-foreground">{dateLine(game)}</p>
          </div>
          {game.sold ? <Badge className="bg-emerald-700 text-white">Sold</Badge> : sit ? <Badge variant="secondary">Sit</Badge> : null}
        </div>
        <div className="flex items-end justify-between gap-3">
          <BigNumber label={big.label} value={big.value} unit={big.unit} />
          <Sparkline values={game.series.map((point) => point.median)} label={`${game.opponent} similar-seat prices, ${game.checks} checks`} />
        </div>
        <p className="flex flex-wrap gap-x-1.5 text-sm text-muted-foreground">
          {big.chance != null ? <span>{formatChance(big.chance)} chance to sell ·</span> : null}
          <Change value={game.change7d} />
          <span>this week</span>
        </p>
      </Card>
    </a>
  );
}

function SeasonView({ report }: { report: TrendsReport }) {
  const { scenario } = useScenario();
  const outlook = useMemo(() => planFor(report, scenario), [report, scenario]);
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: "date", direction: "asc" });
  const [filter, setFilter] = useState<HistoryFilter>("upcoming");
  const visible = useMemo(() => {
    const rows = report.games.filter((game) =>
      filter === "upcoming" ? game.daysOut == null || game.daysOut >= 0 : filter === "history" ? game.checks > 0 : true,
    );
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

  return (
    <PageShell title="Price trends" current="trends" subtitle={`Seats like Section ${report.section}, Row ${report.row}`} updatedAt={report.lastPulledAt}>
      <div className="grid gap-4 lg:grid-cols-2">
        <SeasonCard outlook={outlook} />
        <Card className="gap-2 px-4 py-4">
          <h2 className="text-base font-semibold text-navy">How prices move toward tip</h2>
          <DaysOutChart curve={report.daysOutCurve} dots={dots} />
        </Card>
      </div>

      <div className="mt-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-navy">Games</h2>
          <p className="text-sm text-muted-foreground">
            {up} went up and {down} went down this week.
          </p>
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          <Select value={filter} onValueChange={(value) => setFilter(value as HistoryFilter)}>
            <SelectTrigger aria-label="Which games" className="h-11 flex-1 bg-card sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="upcoming">
                Upcoming ({report.games.filter((game) => game.daysOut == null || game.daysOut >= 0).length})
              </SelectItem>
              <SelectItem value="history">Checked ({report.gamesWithChecks})</SelectItem>
              <SelectItem value="all">All games ({report.games.length})</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={sort.key}
            onValueChange={(key) =>
              setSort({ key: key as SortKey, direction: key === "date" || key === "opponent" ? "asc" : "desc" })
            }
          >
            <SelectTrigger aria-label="Sort games" className="h-11 flex-1 bg-card sm:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORTS.map((column) => (
                <SelectItem key={column.key} value={column.key}>
                  {column.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-11 bg-card"
            aria-label={sort.direction === "asc" ? "Sorted ascending, switch to descending" : "Sorted descending, switch to ascending"}
            onClick={() => setSort({ ...sort, direction: sort.direction === "asc" ? "desc" : "asc" })}
          >
            {sort.direction === "asc" ? <ArrowUpIcon /> : <ArrowDownIcon />}
          </Button>
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No price checks yet.</p>
      ) : (
        <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {visible.map((game) => (
            <GameCard key={game.date} game={game} outlook={outlook} scenario={scenario} />
          ))}
        </div>
      )}

      <HowThisWorks>
        <p>{outlook.sentence}</p>
        <p>
          Similar seats are {bandPhrase(report.band)}, pairs or bigger. The chart starts each game at 100% of its first
          check and draws the middle of later checks by days before tip.
        </p>
        <p>{report.modelNote}</p>
        <p>
          Instant offers were last seen <Updated at={report.lastOfferAt} prefix="" />.
        </p>
      </HowThisWorks>
    </PageShell>
  );
}

function GameView({ report, game }: { report: TrendsReport; game: TrendsGame }) {
  const { scenario, choose } = useScenario();
  const outlook = useMemo(() => planFor(report, scenario), [report, scenario]);
  const big = headline(game, outlook, scenario);
  const note = keepingNote(report, game, scenario, outlook);
  const projection = game.projection;
  const shift =
    projection.enough && projection.price != null && projection.todayPrice
      ? projection.price / projection.todayPrice - 1
      : null;

  return (
    <PageShell title={game.opponent} current="trends" subtitle={dateLine(game, true)} updatedAt={game.compsCheckedAt}>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="gap-4 px-4 py-4">
          <div className="flex items-start justify-between gap-4">
            <BigNumber label={big.label} value={big.value} unit={big.unit} />
            <div className="text-right">
              <p className="text-sm text-muted-foreground">7-day change</p>
              <p className="mt-1 text-base font-medium">
                <Change value={game.change7d} />
              </p>
            </div>
          </div>
          {big.chance != null ? (
            <p className="-mt-2 text-sm text-muted-foreground">{formatChance(big.chance)} chance it sells before tip</p>
          ) : null}
          {game.sold || (game.daysOut != null && game.daysOut < 0) ? null : (
            <SitSellToggle
              className="w-40"
              value={choiceOf(game, scenario)}
              opponent={game.opponent}
              onChange={(choice) => choose(game, choice)}
            />
          )}
        </Card>

        {shift != null ? (
          <Card className="gap-3 px-4 py-4">
            <h2 className="text-sm text-muted-foreground">Price forecast</h2>
            <Gauge
              value={shift / 0.25}
              left="Prices will drop"
              right="Prices will rise"
              label={`Similar seats about ${dollars(projection.price)} by tip, from ${dollars(projection.todayPrice)} today`}
            />
            <p className="text-center text-sm text-muted-foreground">
              About {dollars(projection.price)} by tip, from {dollars(projection.todayPrice)} today.
            </p>
          </Card>
        ) : null}
      </div>

      <Card className="mt-4 gap-2 px-4 py-4">
        <h2 className="text-base font-semibold text-navy">Price over time</h2>
        <PriceTrendChart
          points={game.series}
          ask={game.ask}
          today={report.today}
          gameDate={game.date}
          projection={projection}
          floor={game.instantOffer?.perTicket ?? null}
          title={`${game.opponent} similar-seat prices`}
        />
      </Card>

      <Card className="mt-4 gap-0 px-4 py-1">
        <Disclosure title="Details">
          <div className="space-y-4 pb-4 pt-1">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Fact label="Model ask" value={money(game.ask)} />
              <Fact label="You keep, pair" value={money(game.pair)} />
              <Fact label="Similar seats now" value={money(game.latestMedian)} />
              <Fact label="Cheapest similar" value={money(game.latestCheapest)} />
              <Fact label="Since first check" value={<Change value={game.changeSinceFirst} />} />
              <Fact
                label="Range at tip"
                value={projection.enough && projection.low != null && projection.high != null ? `${dollars(projection.low)}–${dollars(projection.high)}` : "—"}
              />
              <Fact label="Instant offer" value={game.instantOffer ? `${money(game.instantOffer.perTicket)} a seat` : "—"} />
              <Fact label="Season expected" value={dollars(outlook.expectedTotal)} />
            </dl>
            {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
          </div>
        </Disclosure>
        <div className="border-t" />
        <Disclosure title="Price checks">
          {game.series.length === 0 ? (
            <p className="pb-4 text-sm text-muted-foreground">No similar-seat prices yet.</p>
          ) : (
            <table className="mb-4 w-full text-left text-sm">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="py-1 font-normal">Date</th>
                  <th className="py-1 text-right font-normal">Similar seats</th>
                  <th className="py-1 text-right font-normal">Cheapest</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {game.series.map((point) => (
                  <tr key={point.date} className="border-t">
                    <td className="py-1.5">{formatGameDate(point.date, "").trim()}</td>
                    <td className="py-1.5 text-right">{money(point.median)}</td>
                    <td className="py-1.5 text-right">{money(point.cheapest)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Disclosure>
      </Card>

      <HowThisWorks>
        {projection.sentence ? <p>{projection.sentence}</p> : null}
        {projection.early ? <p>The forecast is an early estimate until each game has more price history.</p> : null}
        <p>{report.modelNote}</p>
        <p>Prices are per seat unless marked as the pair, and nothing is listed automatically.</p>
      </HowThisWorks>
    </PageShell>
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

  if (error) return <Message title="Price trends" body={error} link={{ href: "/", label: "Back to the book" }} />;
  if (!report) return <Loading label="Opening price trends" />;
  if (!selected) return <SeasonView report={report} />;
  const game = report.games.find((row) => row.date === selected);
  if (!game) return <Message title="That game isn't on this book" link={{ href: "/trends", label: "See all games" }} />;
  return <GameView report={report} game={game} />;
}
