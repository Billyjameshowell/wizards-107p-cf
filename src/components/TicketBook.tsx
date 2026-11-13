import { useMemo, useState } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "@ui-sdk/react/button";
import { Checkbox, CheckboxIndicator } from "@ui-sdk/react/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { Progress, ProgressIndicator, ProgressTrack } from "@ui-sdk/react/progress";
import type { Book, FilterId, Game, ListingOverride, ListingStatusMap } from "@shared/book";
import { formatChance, formatGameDate } from "@shared/format";
import { daysUntil, etYmd, formatDaysOut, seatPriceForGame, type SeatPriceView } from "@shared/pricing";
import { latestOf } from "@shared/freshness";
import { soldKeepTotalOf, startingTypeIn } from "@shared/book-pricing";
import { ConfirmButton, GameSearch, NamedLink, OptionSelect, SortDirection, textButtonClass } from "@/components/controls";
import { SeatPrice } from "@/components/SeatPrice";
import { SitSellToggle } from "@/components/SitSellToggle";
import { BigNumber, Disclosure, Fact, HowThisWorks, PageShell, Updated } from "@/components/kit";
import { readPriceOverrides, writePriceOverrides, type PriceOverrideMap } from "@/lib/price-overrides";
import { DEFAULT_GAME_SORT, SORT_COLUMNS, sortGameRows, type GameSort } from "@/lib/sort-games";
import { buildingPrices } from "@/lib/building-prices";
import {
  readScenario,
  scenarioChoice,
  scenarioSummary,
  withScenarioChoice,
  writeScenario,
  type ScenarioChoice,
  type ScenarioMap,
} from "@/lib/scenario";
import { buildExportMap, mergeGameStatus, readLocalStatus, writeLocalStatus } from "@/lib/status";
import { gameMatchesQuery } from "@/lib/game-search";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { money } from "@/lib/money";

type BookFilter = FilterId | "upcoming";

const FILTERS: { id: BookFilter; label: string }[] = [
  { id: "upcoming", label: "Upcoming" },
  { id: "all", label: "All games" },
  { id: "sell", label: "Sell" },
  { id: "sit", label: "Sit" },
  { id: "not-listed", label: "Not listed" },
  { id: "listed", label: "Listed" },
  { id: "sold", label: "Sold" },
];

/** Book sorts that still mean something on a card. */
const SORTS = SORT_COLUMNS.filter((column) =>
  ["date", "opponent", "sit_or_sell", "advised_ask", "cash", "get_in", "central"].includes(column.key),
);

function wholeDollars(value: number): string {
  return money(Math.round(value));
}

/** How the all-sell plan sits against the season cost, said once. */
function planLine(sellCash: number, vs: number): string {
  const plan = `Selling every Sell game would bring in about ${wholeDollars(sellCash)}`;
  if (vs > 0) return `${plan}, which covers it with ${wholeDollars(vs)} to spare.`;
  if (vs < 0) return `${plan}, which leaves you ${wholeDollars(Math.abs(vs))} short.`;
  return `${plan}, which covers it exactly.`;
}

type Row = { game: Game; status: ListingOverride; view: SeatPriceView };

type RowHandlers = {
  onListed: (checked: boolean) => void;
  onSold: (checked: boolean) => void;
  onDecision: (choice: ScenarioChoice) => void;
  onTypeIn: (typeIn: number) => void;
  onClearPrice: () => void;
};

function matchesFilter({ game, status }: Row, id: BookFilter, todayEt: string): boolean {
  if (id === "upcoming") return game.date >= todayEt;
  if (id === "sit") return game.sit_or_sell === "Sit";
  if (id === "sell") return game.sit_or_sell === "Sell";
  if (id === "listed") return status.listed;
  if (id === "sold") return status.sold;
  if (id === "not-listed") return !status.listed && !status.sold;
  return true;
}

/** The one number on a card, and what it means. */
function headline(game: Game, status: ListingOverride, view: SeatPriceView, todayEt: string) {
  if (status.sold) {
    const total = soldKeepTotalOf({ sold: true, sold_keep_total: game.sold_keep_total });
    return { label: "Sold", value: total != null ? money(total) : "Sold", unit: total != null ? "for the pair" : undefined };
  }
  if (game.date < todayEt) return { label: "Tip has passed", value: "—", unit: "not sold" };
  if (view.typeIn == null) return { label: "Ask", value: "—", unit: "no price yet" };
  const label = status.listed ? "Listed at" : view.usingOwn ? "Your price" : "Ask";
  return { label, value: wholeDollars(view.typeIn), unit: "per seat" };
}

function StatusBadge({ status }: { status: ListingOverride }) {
  if (status.sold) return <Badge className="bg-emerald-700 text-white">Sold</Badge>;
  if (status.listed) return <Badge>Listed</Badge>;
  return null;
}

function StatusCheck({ label, name, checked, onChange }: { label: string; name: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm">
      <Checkbox checked={checked} onCheckedChange={(next) => onChange(next === true)} aria-label={`${label} for ${name}`}>
        <CheckboxIndicator>
          <CheckIcon aria-hidden="true" className="size-3.5" />
        </CheckboxIndicator>
      </Checkbox>
      {label}
    </label>
  );
}

function tmLine(game: Game): string | null {
  const tm = game.tm_portal;
  if (!tm || (tm.suggested == null && tm.listed_price == null)) return null;
  const range = tm.range_low != null && tm.range_high != null ? ` (range $${tm.range_low}–$${tm.range_high})` : "";
  return tm.suggested != null ? `$${tm.suggested}${range}` : `listed $${tm.listed_price}`;
}

function GameCard({ game, status, view, todayEt, ...on }: Row & RowHandlers & { todayEt: string }) {
  const prices = buildingPrices(game);
  const days = daysUntil(game.date, todayEt);
  const big = headline(game, status, view, todayEt);
  const past = game.date < todayEt;
  const chance = view.suggestion?.saleChance;
  const similar = view.suggestion?.listedMedian;
  const secondary = [
    !status.sold && !past && chance != null ? `${formatChance(chance)} chance to sell` : null,
    !status.sold && similar != null ? `similar seats ${wholeDollars(similar)}` : null,
  ].filter(Boolean);
  const tm = tmLine(game);

  return (
    <Card className="gap-4 px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold leading-snug text-navy">
            <a href={`/trends/${game.date}`} className="hover:underline">
              {game.opponent}
            </a>
          </h2>
          <p className="text-sm text-muted-foreground">
            {formatGameDate(game.date, game.weekday)} · {game.time_et}
            {days != null && days >= 0 ? ` · ${formatDaysOut(days)}` : ""}
          </p>
        </div>
        <StatusBadge status={status} />
      </div>

      <div>
        <BigNumber label={big.label} value={big.value} unit={big.unit} />
        {secondary.length ? <p className="mt-1 text-sm text-muted-foreground first-letter:uppercase">{secondary.join(" · ")}</p> : null}
      </div>

      <Collapsible className="group/details border-t pt-3">
        <div className="flex items-center justify-between gap-3">
          {status.sold || past ? (
            <span />
          ) : (
            <SitSellToggle className="w-36" value={game.sit_or_sell} opponent={game.opponent} onChange={on.onDecision} />
          )}
          <CollapsibleTrigger className="inline-flex min-h-11 items-center gap-1 rounded-md text-sm font-medium text-navy">
            Details
            <span className="sr-only"> for {game.opponent}</span>
            <ChevronDownIcon aria-hidden="true" className="size-4 text-muted-foreground transition-transform group-data-open/details:rotate-180" />
          </CollapsibleTrigger>
        </div>
        <CollapsiblePanel keepMounted>
          <div className="space-y-4 pt-3">
            {status.sold || past ? null : (
              <SeatPrice opponent={game.opponent} view={view} onTypeIn={on.onTypeIn} onClear={on.onClearPrice} />
            )}
            <dl className="grid grid-cols-2 gap-3">
              <Fact label="Cheapest in arena" value={money(prices.getIn)} />
              <Fact label={prices.centralKind === "mean" ? "Arena average" : "Arena median"} value={money(prices.central)} />
              {tm ? <Fact label="Ticketmaster suggests" value={tm} /> : null}
              <Fact label="Prices checked" value={<Updated at={game.comp_checked_at} prefix="" />} />
            </dl>
            {status.notes ? <p className="text-sm text-muted-foreground">{status.notes}</p> : null}
            <div className="flex flex-wrap items-center gap-x-4">
              <StatusCheck label="Listed" name={game.opponent} checked={status.listed} onChange={on.onListed} />
              <StatusCheck label="Sold" name={game.opponent} checked={status.sold} onChange={on.onSold} />
              <span className="ml-auto flex gap-4 text-sm font-medium">
                <a href={`/trends/${game.date}`} className="inline-flex min-h-11 items-center text-navy underline underline-offset-4">
                  Trend
                </a>
                {game.ticketdata_url ? (
                  <a
                    href={game.ticketdata_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-11 items-center text-navy underline underline-offset-4"
                  >
                    TicketData
                  </a>
                ) : null}
              </span>
            </div>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </Card>
  );
}

export function TicketBook({ book, repoStatus }: { book: Book; repoStatus: ListingStatusMap }) {
  const [localStatus, setLocalStatus] = useState<ListingStatusMap>(() => readLocalStatus());
  const [scenario, setScenario] = useState<ScenarioMap>(() => readScenario());
  const [overrides, setOverrides] = useState<PriceOverrideMap>(() => readPriceOverrides());
  const [filter, setFilter] = useState<BookFilter>("upcoming");
  const [query, setQuery] = useState("");
  const [copyLabel, setCopyLabel] = useState("Copy status");
  const [sort, setSort] = useState<GameSort>(DEFAULT_GAME_SORT);
  const todayEt = useMemo(() => etYmd(new Date()), []);

  const games = useMemo(() => [...book.games].sort((a, b) => a.date.localeCompare(b.date)), [book.games]);

  const priced = useMemo(
    () =>
      games.map((game) => {
        const status = mergeGameStatus(game, repoStatus, localStatus);
        const live = { ...game, listed: status.listed, sold: status.sold, listed_ask: status.listed_ask };
        const view = seatPriceForGame(game, startingTypeIn(live, overrides[game.date] ?? null), todayEt);
        const soldTotal = soldKeepTotalOf(live);
        // A game already played and never sold brings nothing; keep it out of the plan.
        if (soldTotal == null && !live.sold && game.date < todayEt) live.sold = true;
        return {
          source: game,
          view,
          soldTotal,
          priced: {
            ...game,
            advised_ask: soldTotal != null ? soldTotal / 2 : live.sold ? null : view.keep,
            cash_both_after_fee: soldTotal != null ? soldTotal : live.sold ? null : view.pair,
          },
        };
      }),
    [games, overrides, todayEt, repoStatus, localStatus],
  );

  const summary = useMemo(
    () => scenarioSummary(priced.map((item) => item.priced), scenario, book.season_cost),
    [priced, scenario, book.season_cost],
  );

  // Season cash is money already in from sold pairs; the Sell plan adds the rest.
  const banked = useMemo(
    () => Math.round(priced.reduce((sum, item) => sum + (item.soldTotal ?? 0), 0) * 100) / 100,
    [priced],
  );

  const rows: Row[] = useMemo(
    () =>
      priced.map((item) => ({
        game: { ...item.priced, sit_or_sell: scenarioChoice(item.priced, scenario) },
        status: mergeGameStatus(item.source, repoStatus, localStatus),
        view: item.view,
      })),
    [priced, scenario, repoStatus, localStatus],
  );


  const visible = useMemo(() => {
    const filtered = rows.filter(
      (row) =>
        matchesFilter(row, filter, todayEt) &&
        gameMatchesQuery(
          {
            date: row.game.date,
            weekday: row.game.weekday,
            opponent: row.game.opponent,
            type: row.game.type,
            notes: row.status.notes || row.game.notes,
            sitOrSell: row.game.sit_or_sell,
          },
          query,
        ),
    );
    return sortGameRows(filtered, sort);
  }, [rows, filter, sort, query, todayEt]);

  function setDecision(date: string, choice: ScenarioChoice) {
    const next = withScenarioChoice(games, scenario, date, choice);
    setScenario(next);
    writeScenario(next);
  }

  function resetScenario() {
    setScenario({});
    writeScenario({});
  }

  function saveTypeIn(date: string, typeIn: number) {
    const rounded = Math.max(1, Math.round(typeIn));
    const game = games.find((item) => item.date === date);
    const suggestion = game ? seatPriceForGame(game, null, todayEt).suggestion : null;
    if (overrides[date] === rounded) return;
    if (overrides[date] == null && suggestion?.typeIn === rounded) return;
    const next = { ...overrides, [date]: rounded };
    setOverrides(next);
    writePriceOverrides(next);
  }

  function clearPrice(date: string) {
    if (overrides[date] == null) return;
    const next = { ...overrides };
    delete next[date];
    setOverrides(next);
    writePriceOverrides(next);
  }

  function patchStatus(date: string, patch: Partial<{ listed: boolean; sold: boolean }>) {
    const game = games.find((item) => item.date === date);
    if (!game) return;
    const current = mergeGameStatus(game, repoStatus, localStatus);
    const nextLocal = { ...localStatus, [date]: { ...current, ...patch } };
    setLocalStatus(nextLocal);
    writeLocalStatus(nextLocal);
  }

  async function copyStatus() {
    const payload = buildExportMap(games, repoStatus, localStatus);
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopyLabel("Copied");
    } catch {
      setCopyLabel("Copy failed");
    }
    window.setTimeout(() => setCopyLabel("Copy status"), 1600);
  }

  function clearLocal() {
    setLocalStatus({});
    writeLocalStatus({});
  }

  function handlersFor(date: string): RowHandlers {
    return {
      onListed: (checked) => patchStatus(date, { listed: checked }),
      onSold: (checked) => patchStatus(date, { sold: checked }),
      onDecision: (choice) => setDecision(date, choice),
      onTypeIn: (typeIn) => saveTypeIn(date, typeIn),
      onClearPrice: () => clearPrice(date),
    };
  }

  const progress = book.season_cost > 0 ? Math.min(100, (banked / book.season_cost) * 100) : 0;

  return (
    <PageShell
      title="Ticket book"
      current="book"
      subtitle={`Section ${book.section}, Row ${book.row}`}
      updatedAt={latestOf(book.games.map((g) => g.comp_checked_at))}
    >
      <Card className="gap-3 px-4 py-4">
        <BigNumber label="In so far" value={money(banked)} unit={`of the ${wholeDollars(book.season_cost)} season cost`} />
        <Progress value={progress} aria-label="Cash in toward the season cost">
          <ProgressTrack>
            <ProgressIndicator />
          </ProgressTrack>
        </Progress>
        {summary.sellCash > 0 ? (
          <p className="text-sm text-muted-foreground">
            {planLine(summary.sellCash, summary.vsSeason)}
          </p>
        ) : null}
      </Card>

      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        <GameSearch value={query} onValueChange={setQuery} />
        <div className="flex gap-2">
          <OptionSelect
            label="Which games"
            value={filter}
            onValueChange={setFilter}
            className="flex-1 sm:w-44 sm:flex-none"
            options={FILTERS.map((item) => ({
              value: item.id,
              label: `${item.label} (${rows.filter((row) => matchesFilter(row, item.id, todayEt)).length})`,
            }))}
          />
          <OptionSelect
            label="Sort games"
            value={sort.key}
            onValueChange={(key) => setSort({ key, direction: "asc" })}
            className="flex-1 sm:w-36 sm:flex-none"
            options={SORTS.map((column) => ({ value: column.key, label: column.label }))}
          />
          <SortDirection direction={sort.direction} onChange={(direction) => setSort({ ...sort, direction })} />
        </div>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {visible.map((row) => (
          <GameCard key={row.game.date} {...row} {...handlersFor(row.game.date)} todayEt={todayEt} />
        ))}
      </div>
      {visible.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No games match.</p> : null}

      <HowThisWorks>
        <p>
          The ask is the price model&apos;s per-seat number to type into Account Manager, the same one Trends and the grid
          show. You keep 95% of it, and a number you type stays put until you clear it.
        </p>
        <p>
          Similar seats means pairs or more in sections 107, 108, 118 and 119, rows J to T. Sit or Sell, Listed and Sold
          only change this book on this device.
        </p>
      </HowThisWorks>
      <Card className="mt-3 gap-0 px-4 py-1">
        <Disclosure title="Book tools">
        <div className="flex flex-wrap gap-2 pb-4">
          <Button type="button" className={textButtonClass} onClick={copyStatus}>
            {copyLabel}
          </Button>
          <ConfirmButton
            label="Clear listed and sold"
            title="Clear listed and sold?"
            description="Clears the listed and sold marks saved on this device. Prices stay."
            confirm="Clear marks"
            onConfirm={clearLocal}
          />
          <ConfirmButton
            label="Reset Sit and Sell"
            title="Reset Sit and Sell?"
            description="Puts every game back to the book's Sit or Sell."
            confirm="Reset choices"
            disabled={Object.keys(scenario).length === 0}
            onConfirm={resetScenario}
          />
          <NamedLink href="/admin">Admin</NamedLink>
        </div>
        </Disclosure>
      </Card>
    </PageShell>
  );
}
