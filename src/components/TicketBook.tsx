import { useMemo, useState } from "react";
import { SearchIcon, XIcon } from "lucide-react";
import type { Book, FilterId, Game, ListingOverride, ListingStatusMap } from "@shared/book";
import { formatGameDate, formatMoney, formatShortfall, formatYear } from "@shared/format";
import { daysUntil, etYmd, formatDaysOut, seatPriceForGame, type SeatPriceView } from "@shared/pricing";
import { SeatPrice } from "@/components/SeatPrice";
import {
  readPriceOverrides,
  writePriceOverrides,
  type PriceOverrideMap,
} from "@/lib/price-overrides";
import {
  DEFAULT_GAME_SORT,
  SORT_COLUMNS,
  sortGameRows,
  toggleSort,
  type GameSort,
  type SortDirection,
  type SortKey,
} from "@/lib/sort-games";
import { buildingPrices, centralColumnLabel } from "@/lib/building-prices";
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
import { MAX_TABLE_SCALE, MIN_TABLE_SCALE, stepTableScale } from "@/lib/table-zoom";
import { usePinchZoom } from "@/lib/use-pinch-zoom";
import { gameMatchesQuery } from "@/lib/game-search";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const FILTERS: { id: FilterId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "sit", label: "Sit" },
  { id: "sell", label: "Sell" },
  { id: "not-listed", label: "Not listed" },
  { id: "listed", label: "Listed" },
  { id: "sold", label: "Sold" },
];

function decisionTone(value: string): "sit" | "sell" | "tbd" {
  const key = value.toLowerCase();
  if (key === "sit" || key === "sell") return key;
  return "tbd";
}

function toneRowClass(value: string): string {
  const tone = decisionTone(value);
  if (tone === "sit") return "bg-sit hover:bg-sit";
  if (tone === "sell") return "bg-sell hover:bg-sell";
  return "bg-tbd hover:bg-tbd";
}

function ScenarioToggle({
  value,
  opponent,
  onChange,
  wide = false,
}: {
  value: string;
  opponent: string;
  onChange: (choice: ScenarioChoice) => void;
  wide?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={`Sit or sell for ${opponent}`}
      className={cn(
        "grid grid-cols-2 gap-1 rounded-xl bg-white p-1 shadow-[0_1px_1px_rgba(12,35,64,0.05)] ring-1 ring-[#d5cfc3]",
        wide ? "w-full max-w-sm" : "w-[11.5rem]",
      )}
    >
      {(["Sit", "Sell"] as const).map((choice) => {
        const selected = value === choice;
        return (
          <button
            key={choice}
            type="button"
            aria-pressed={selected}
            className={cn(
              "min-h-12 rounded-lg px-2 text-base font-bold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/40 lg:min-h-10 lg:text-sm",
              selected && choice === "Sit" && "bg-sit-ink text-white shadow-sm",
              selected && choice === "Sell" && "bg-sell-ink text-white shadow-sm",
              !selected && "text-[#243044] hover:bg-[#f4f1ea]",
            )}
            onClick={() => onChange(choice)}
          >
            {choice}
          </button>
        );
      })}
    </div>
  );
}

function PreseasonMark({ type }: { type: string }) {
  if (type !== "preseason") return null;
  return (
    <span className="rounded-full bg-navy/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-navy">
      Preseason
    </span>
  );
}

function StatusCheck({
  label,
  name,
  checked,
  onChange,
  showLabel = false,
}: {
  label: string;
  name: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  showLabel?: boolean;
}) {
  return (
    <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 whitespace-nowrap lg:min-h-8">
      <input
        type="checkbox"
        className="size-4 accent-navy"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        {showLabel ? `${label} ` : null}
        {checked ? "Yes" : "No"}
      </span>
      <span className="sr-only">
        {label} {name}
      </span>
    </label>
  );
}

function formatType(type: string): string {
  if (!type) return "—";
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function SortMark({ direction }: { direction: SortDirection | null }) {
  const glyph = direction === "asc" ? "▲" : direction === "desc" ? "▼" : "↕";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block min-w-3 text-center text-[10px] leading-none",
        direction ? "text-navy" : "text-muted-foreground/70",
      )}
    >
      {glyph}
    </span>
  );
}

function SortableHead({
  column,
  sort,
  onSort,
  className,
  label,
}: {
  column: SortKey;
  sort: GameSort;
  onSort: (column: SortKey) => void;
  className?: string;
  label?: string;
}) {
  const heading = label ?? SORT_COLUMNS.find((item) => item.key === column)?.label ?? column;
  const active = sort.key === column;
  const direction = active ? sort.direction : null;
  return (
    <TableHead
      aria-sort={direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none"}
      className={className}
    >
      <button
        type="button"
        className="inline-flex items-center gap-1 text-left text-xs font-semibold text-navy select-none"
        onClick={() => onSort(column)}
      >
        {heading}
        <SortMark direction={direction} />
        <span className="sr-only">
          {direction === "asc" ? ", sorted ascending" : direction === "desc" ? ", sorted descending" : ", not sorted"}
        </span>
      </button>
    </TableHead>
  );
}

function TicketDataLink({ href }: { href: string | null }) {
  if (!href) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <a
      className="text-sm font-semibold text-navy underline underline-offset-2"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      TicketData
    </a>
  );
}

function PriceStat({
  label,
  caption,
  value,
}: {
  label: string;
  caption?: string;
  value: number | null;
}) {
  return (
    <div className="min-w-0 bg-[#faf8f4] px-3.5 py-2.5">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{label}</dt>
      {caption ? <p className="text-[11px] leading-tight text-muted-foreground">{caption}</p> : null}
      <dd className="mt-0.5 text-sm font-semibold tabular-nums text-foreground/80">{formatMoney(value)}</dd>
    </div>
  );
}

function DaysOut({ date, todayEt }: { date: string; todayEt: string }) {
  const days = daysUntil(date, todayEt);
  if (days == null) return null;
  return <span className="block text-xs font-semibold text-navy">{formatDaysOut(days)}</span>;
}

function cardAccent(value: string): string {
  const tone = decisionTone(value);
  if (tone === "sit") return "border-l-[5px] border-l-sit-ink";
  if (tone === "sell") return "border-l-[5px] border-l-sell-ink";
  return "border-l-[5px] border-l-tbd-ink";
}

function GameCard({
  game,
  status,
  view,
  todayEt,
  onListed,
  onSold,
  onDecision,
  onTypeIn,
  onClearPrice,
}: {
  game: Game;
  status: ListingOverride;
  view: SeatPriceView;
  todayEt: string;
  onListed: (checked: boolean) => void;
  onSold: (checked: boolean) => void;
  onDecision: (choice: ScenarioChoice) => void;
  onTypeIn: (typeIn: number) => void;
  onClearPrice: () => void;
}) {
  const prices = buildingPrices(game);
  return (
    <article
      className={cn(
        "overflow-hidden rounded-2xl border border-line bg-card shadow-[0_1px_2px_rgba(12,35,64,0.06)]",
        cardAccent(game.sit_or_sell),
      )}
    >
      <div className={cn("px-3.5 py-3", toneRowClass(game.sit_or_sell))}>
        <h2 className="text-[1.2rem] font-semibold leading-tight tracking-tight text-navy">
          {game.opponent}
        </h2>
        <p className="mt-1 text-sm text-[#3d4654]">
          {formatGameDate(game.date, game.weekday)} {formatYear(game.date)} · {game.time_et} ET
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <DaysOut date={game.date} todayEt={todayEt} />
          <PreseasonMark type={game.type} />
          <a
            href={`/trends/${game.date}`}
            className="text-sm font-semibold text-navy underline underline-offset-2"
          >
            Price trend
          </a>
        </div>
        <div className="mt-2.5">
          <ScenarioToggle wide value={game.sit_or_sell} opponent={game.opponent} onChange={onDecision} />
        </div>
      </div>

      <div className="border-t border-line bg-white px-3.5 py-3.5">
        <SeatPrice
          opponent={game.opponent}
          view={view}
          showPair
          onTypeIn={onTypeIn}
          onClear={onClearPrice}
        />
      </div>

      <dl className="grid grid-cols-2 gap-px border-t border-line bg-line">
        <PriceStat label="Cheapest in the arena" caption="Not your seats" value={prices.getIn} />
        <PriceStat
          label={prices.centralKind === "mean" ? "Arena average" : "Middle of the arena"}
          caption="Whole building"
          value={prices.central}
        />
      </dl>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-3.5 py-2 text-sm">
        <StatusCheck
          label="Listed"
          name={game.opponent}
          checked={status.listed}
          onChange={onListed}
          showLabel
        />
        <StatusCheck
          label="Sold"
          name={game.opponent}
          checked={status.sold}
          onChange={onSold}
          showLabel
        />
        <TicketDataLink href={game.ticketdata_url} />
      </div>

      {status.notes ? (
        <p className="border-t border-line px-3.5 py-2.5 text-sm leading-snug text-muted-foreground">
          {status.notes}
        </p>
      ) : null}
    </article>
  );
}

export function TicketBook({
  book,
  repoStatus,
}: {
  book: Book;
  repoStatus: ListingStatusMap;
}) {
  const [localStatus, setLocalStatus] = useState<ListingStatusMap>(() => readLocalStatus());
  const [scenario, setScenario] = useState<ScenarioMap>(() => readScenario());
  const [overrides, setOverrides] = useState<PriceOverrideMap>(() => readPriceOverrides());
  const [filter, setFilter] = useState<FilterId>("all");
  const [query, setQuery] = useState("");
  const [copyLabel, setCopyLabel] = useState("Copy status");
  const [sort, setSort] = useState<GameSort>(DEFAULT_GAME_SORT);
  const { scale, setScale, bind } = usePinchZoom();
  const todayEt = useMemo(() => etYmd(new Date()), []);

  const games = useMemo(
    () => [...book.games].sort((a, b) => a.date.localeCompare(b.date)),
    [book.games],
  );

  const priced = useMemo(
    () =>
      games.map((game) => {
        const view = seatPriceForGame(game, overrides[game.date] ?? null, todayEt);
        return {
          source: game,
          view,
          priced: {
            ...game,
            advised_ask: view.keep,
            cash_both_after_fee: view.pair,
          },
        };
      }),
    [games, overrides, todayEt],
  );

  const summary = useMemo(
    () => scenarioSummary(
      priced.map((item) => item.priced),
      scenario,
      book.season_cost,
    ),
    [priced, scenario, book.season_cost],
  );

  const rows = useMemo(
    () =>
      priced.map((item) => ({
        game: { ...item.priced, sit_or_sell: scenarioChoice(item.priced, scenario) },
        status: mergeGameStatus(item.source, repoStatus, localStatus),
        view: item.view,
      })),
    [priced, scenario, repoStatus, localStatus],
  );

  const visible = useMemo(() => {
    const filtered = rows.filter(({ game, status }) => {
      if (filter === "sit" && game.sit_or_sell !== "Sit") return false;
      if (filter === "sell" && game.sit_or_sell !== "Sell") return false;
      if (filter === "listed" && !status.listed) return false;
      if (filter === "sold" && !status.sold) return false;
      if (filter === "not-listed" && (status.listed || status.sold)) return false;
      return gameMatchesQuery(
        {
          date: game.date,
          weekday: game.weekday,
          opponent: game.opponent,
          type: game.type,
          notes: status.notes || game.notes,
          sitOrSell: game.sit_or_sell,
        },
        query,
      );
    });
    return sortGameRows(filtered, sort);
  }, [rows, filter, sort, query]);

  const centralLabel = centralColumnLabel(visible.map((row) => row.game));

  function chooseSort(column: SortKey) {
    setSort((current) => toggleSort(current, column));
  }

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
      window.setTimeout(() => setCopyLabel("Copy status"), 1600);
    } catch {
      setCopyLabel("Copy failed");
      window.setTimeout(() => setCopyLabel("Copy status"), 1600);
    }
  }

  function clearLocal() {
    setLocalStatus({});
    writeLocalStatus({});
  }

  const nextGame = games.find((game) => game.date >= todayEt) ?? null;
  const openSell = rows.filter(
    (row) => row.game.sit_or_sell === "Sell" && row.view.typeIn == null,
  ).length;
  const cashLine =
    summary.sellCash === 0
      ? `Nothing in yet toward ${formatMoney(book.season_cost)}`
      : `${formatMoney(summary.sellCash)} toward ${formatMoney(book.season_cost)}`;

  const emptyMessage =
    visible.length === 0 ? (
      <div className="px-4 py-7 text-center text-muted-foreground">No games match this filter.</div>
    ) : null;

  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-16 pt-4 sm:px-4 sm:pt-5">
      <header className="rounded-2xl bg-navy px-4 py-3 text-navy-foreground sm:px-5 sm:py-4">
        <div className="flex items-start justify-between gap-3">
          <p className="m-0 text-[13px] font-medium leading-snug text-[#f3e6c8]">
            Capital One Arena · Section {book.section} Row {book.row} · seats {book.seats.join("–")}
          </p>
          <nav aria-label="Site" className="flex shrink-0 items-center gap-1">
            <a
              href="/trends"
              className="inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-semibold text-[#f3e6c8] underline decoration-[#f3e6c8]/70 underline-offset-4"
            >
              Trends
            </a>
            <a
              href="/admin"
              className="inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-semibold text-[#f3e6c8] underline decoration-[#f3e6c8]/70 underline-offset-4"
            >
              Admin
            </a>
          </nav>
        </div>
        <h1 className="font-heading mt-0.5 text-[24px] leading-none tracking-tight sm:text-[30px]">Wizards 107P</h1>
        <p className="mt-1.5 text-sm leading-snug text-[#e4eaf3]">
          Prices as of {book.asof_et} ET · {book.games.length} home games
        </p>
      </header>

      <section
        aria-label="Season summary"
        className="sticky top-0 z-40 -mx-3 mt-3 border-y border-line bg-[#f4f1ea]/95 px-3 py-2 shadow-[0_8px_18px_rgba(12,35,64,0.06)] backdrop-blur-md sm:-mx-4 sm:px-4 lg:static lg:rounded-xl lg:border lg:px-4 lg:py-3 lg:shadow-none lg:backdrop-blur-none"
      >
        <div className="flex flex-col gap-1 lg:flex-row lg:flex-wrap lg:items-baseline lg:justify-between lg:gap-x-6">
          <p className="text-[15px] font-semibold leading-snug text-navy">
            {summary.sellCount} {summary.sellCount === 1 ? "game" : "games"} on Sell
            <span className="font-medium text-muted-foreground">
              {" "}
              · {summary.sitCount} Sit
              {summary.tbdCount > 0 ? ` · ${summary.tbdCount} TBD` : ""}
              {openSell > 0 ? ` · ${openSell} without a price` : ""}
            </span>
          </p>
          <p className="text-sm leading-snug text-[#3d4654]">
            <span className="text-lg font-bold tabular-nums text-navy">{cashLine}</span>
            {summary.sellCash > 0 ? (
              <span className="text-muted-foreground"> · {formatShortfall(summary.vsSeason, book.season_cost)}</span>
            ) : null}
          </p>
          {nextGame ? (
            <p className="text-sm leading-snug text-muted-foreground">
              Next tip{" "}
              <span className="font-semibold text-foreground">
                {formatGameDate(nextGame.date, nextGame.weekday)} · {nextGame.opponent}
              </span>
              {" · "}
              {nextGame.time_et} ET
            </p>
          ) : null}
        </div>
      </section>

      <div className="my-3 flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between">
        <div
          className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0"
          role="group"
          aria-label="Filter games"
        >
          {FILTERS.map((item) => (
            <Button
              key={item.id}
              type="button"
              size="sm"
              variant={filter === item.id ? "default" : "outline"}
              aria-pressed={filter === item.id}
              className="h-11 shrink-0 px-3.5 lg:h-8"
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0">
          <span className="text-sm text-muted-foreground">
            {visible.length} of {book.games.length}
          </span>
          <Button type="button" size="sm" variant="outline" onClick={copyStatus}>
            {copyLabel}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={clearLocal}>
            Clear listed and sold
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={resetScenario}
            disabled={Object.keys(scenario).length === 0}
          >
            Reset Sit and Sell
          </Button>
        </div>
      </div>

      <div role="search" className="mb-3">
        <InputGroup className="h-11 min-h-11 bg-background">
          <InputGroupAddon align="inline-start" className="pl-3">
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search games (team, date, notes)"
            aria-label="Search games"
            className="h-11 text-base md:text-sm [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
          />
          {query ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                aria-label="Clear search"
                size="icon-sm"
                className="size-11"
                onClick={() => setQuery("")}
              >
                <XIcon />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </div>

      <div
        className={cn(
          "mb-3 flex-wrap items-center justify-between gap-2",
          scale === 1 ? "hidden lg:flex" : "flex",
        )}
      >
        <p className="text-xs text-muted-foreground">Pinch or Ctrl+scroll to resize. Scroll still moves the list.</p>
        <div className="flex items-center gap-1.5" role="group" aria-label="Table size">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label="Zoom out"
            disabled={scale <= MIN_TABLE_SCALE}
            onClick={() => setScale(stepTableScale(scale, -1))}
          >
            −
          </Button>
          <span className="min-w-12 text-center text-sm tabular-nums">{Math.round(scale * 100)}%</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label="Zoom in"
            disabled={scale >= MAX_TABLE_SCALE}
            onClick={() => setScale(stepTableScale(scale, 1))}
          >
            +
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setScale(1)} disabled={scale === 1}>
            Reset
          </Button>
        </div>
      </div>

      <div className="-mx-1 mb-2 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:hidden" role="group" aria-label="Sort games">
        {SORT_COLUMNS.map((column) => {
          const active = sort.key === column.key;
          const label = column.key === "central" ? (centralLabel === "Mean" ? "Arena average" : "Arena middle") : column.label;
          return (
            <Button
              key={column.key}
              type="button"
              size="sm"
              variant={active ? "default" : "outline"}
              aria-pressed={active}
              className="h-11 shrink-0 px-3 lg:h-8"
              onClick={() => chooseSort(column.key)}
            >
              {label}
              <SortMark direction={active ? sort.direction : null} />
            </Button>
          );
        })}
      </div>

      <div
        ref={bind}
        className="lg:hidden"
        style={{ touchAction: "pan-x pan-y", zoom: scale }}
      >
        <div className="space-y-3">
          {visible.map(({ game, status, view }) => (
            <GameCard
              key={game.date}
              game={game}
              status={status}
              view={view}
              todayEt={todayEt}
              onListed={(checked) => patchStatus(game.date, { listed: checked })}
              onSold={(checked) => patchStatus(game.date, { sold: checked })}
              onDecision={(choice) => setDecision(game.date, choice)}
              onTypeIn={(typeIn) => saveTypeIn(game.date, typeIn)}
              onClearPrice={() => clearPrice(game.date)}
            />
          ))}
          {emptyMessage}
        </div>
      </div>

      <Card className="hidden min-w-0 overflow-hidden border-line py-0 shadow-[0_10px_30px_rgba(11,31,58,0.12)] lg:flex">
        <div
          ref={bind}
          className="min-h-0 min-w-0 w-full max-h-[min(72vh,820px)] overflow-auto"
          style={{ touchAction: "pan-x pan-y" }}
        >
          <div style={{ zoom: scale }}>
            <div className="min-w-[1620px]">
              <Table className="ticket-table">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <SortableHead column="date" sort={sort} onSort={chooseSort} className="bg-thead" />
                  <SortableHead column="opponent" sort={sort} onSort={chooseSort} className="bg-thead" />
                  <SortableHead column="type" sort={sort} onSort={chooseSort} className="bg-thead" />
                  <SortableHead column="time" sort={sort} onSort={chooseSort} className="bg-thead" />
                  <SortableHead column="sit_or_sell" sort={sort} onSort={chooseSort} className="bg-thead" />
                  <SortableHead column="advised_ask" sort={sort} onSort={chooseSort} className="bg-thead" />
                  <SortableHead column="cash" sort={sort} onSort={chooseSort} className="bg-thead" />
                  <SortableHead
                    column="get_in"
                    label="Cheapest in the arena"
                    sort={sort}
                    onSort={chooseSort}
                    className="bg-thead"
                  />
                  <SortableHead
                    column="central"
                    label={centralLabel === "Mean" ? "Arena average" : "Middle of the arena"}
                    sort={sort}
                    onSort={chooseSort}
                    className="bg-thead"
                  />
                  <SortableHead column="listed" sort={sort} onSort={chooseSort} className="bg-thead" />
                  <SortableHead column="sold" sort={sort} onSort={chooseSort} className="bg-thead" />
                  <SortableHead column="ticketdata" sort={sort} onSort={chooseSort} className="bg-thead" />
                  <SortableHead column="notes" sort={sort} onSort={chooseSort} className="bg-thead" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map(({ game, status, view }) => {
                  const prices = buildingPrices(game);
                  return (
                  <TableRow
                    key={game.date}
                    data-tone={decisionTone(game.sit_or_sell)}
                    className={cn("[&>td]:align-top [&>td]:py-3", toneRowClass(game.sit_or_sell))}
                  >
                    <TableCell className="whitespace-nowrap font-semibold">
                      {formatGameDate(game.date, game.weekday)}
                      <span className="block text-xs font-medium text-muted-foreground">
                        {formatYear(game.date)}
                      </span>
                      <DaysOut date={game.date} todayEt={todayEt} />
                    </TableCell>
                    <TableCell>
                      <span className="font-semibold text-navy">{game.opponent}</span>{" "}
                      <PreseasonMark type={game.type} />
                      <a
                        href={`/trends/${game.date}`}
                        className="mt-1 block text-sm font-semibold text-navy underline underline-offset-2"
                      >
                        Price trend
                      </a>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatType(game.type)}</TableCell>
                    <TableCell className="text-muted-foreground">{game.time_et}</TableCell>
                    <TableCell>
                      <ScenarioToggle
                        value={game.sit_or_sell}
                        opponent={game.opponent}
                        onChange={(choice) => setDecision(game.date, choice)}
                      />
                    </TableCell>
                    <TableCell>
                      <SeatPrice
                        opponent={game.opponent}
                        view={view}
                        showPair={false}
                        onTypeIn={(typeIn) => saveTypeIn(game.date, typeIn)}
                        onClear={() => clearPrice(game.date)}
                      />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {view.pair == null ? (
                        <span className="text-sm font-medium text-muted-foreground">No price yet</span>
                      ) : (
                        <span className="text-lg font-bold tabular-nums text-navy">{formatMoney(view.pair)}</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm tabular-nums text-muted-foreground">
                      {formatMoney(prices.getIn)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm tabular-nums text-muted-foreground">
                      {formatMoney(prices.central)}
                      {prices.centralKind === "mean" && centralLabel === "Median" ? (
                        <span className="ml-1 text-[11px] font-medium uppercase tracking-wide">
                          Average
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <StatusCheck
                        label="Listed"
                        name={game.opponent}
                        checked={status.listed}
                        onChange={(checked) => patchStatus(game.date, { listed: checked })}
                      />
                    </TableCell>
                    <TableCell>
                      <StatusCheck
                        label="Sold"
                        name={game.opponent}
                        checked={status.sold}
                        onChange={(checked) => patchStatus(game.date, { sold: checked })}
                      />
                    </TableCell>
                    <TableCell>
                      <TicketDataLink href={game.ticketdata_url} />
                    </TableCell>
                    <TableCell className="max-w-[220px] whitespace-normal text-sm text-muted-foreground">
                      {status.notes || "—"}
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
              </Table>
            </div>
          </div>
          {emptyMessage}
        </div>
      </Card>

      <details className="mt-4 rounded-xl border border-line bg-card px-4 py-3 text-sm leading-relaxed text-[#3d4654]">
        <summary className="flex min-h-11 cursor-pointer items-center font-semibold text-navy">
          How a price is figured
        </summary>
        <div className="mt-3 space-y-2">
          <p>
            You keep 95% of the dollar you type in Wizards Account Manager, per seat. Both seats are
            twice that. On a $49 type-in, the seller fee is $2.45, you keep $46.55, and both seats
            pay $93.10. The buyer pays more than the number you type. This book does not have that
            buyer total. Sit or Sell here only updates this book.
          </p>
          <p>
            Listed around is the middle of similar lower-bowl seats: sections 107, 108, 118, and 119,
            rows J through T. One lone cheap Section 107 Row P listing is left out. The suggested
            number to type is a whole dollar ending in 0 or 5, like $150, $175, or $200. A dollar
            ending in 9 is used only when it shows a smaller first digit, so $199 instead of $200. A
            number you type yourself can be any whole dollar, and it stays when the listings or the
            days until tip change.
          </p>
          <p>
            More than three weeks out, a bigger game sits about 10% above that middle. Inside two
            weeks, a softer game sits about 5% under it. Other games stay on the middle. The $6,000
            season goal does not change a game’s price.
          </p>
        </div>
      </details>
    </div>
  );
}
