import { useMemo, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, SearchIcon, XIcon } from "lucide-react";
import type { Book, FilterId, Game, ListingOverride, ListingStatusMap } from "@shared/book";
import { formatGameDate, formatMoney, formatShortfall, formatYear } from "@shared/format";
import { daysUntil, etYmd, formatDaysOut, seatPriceForGame, type SeatPriceView } from "@shared/pricing";
import { SeatPrice } from "@/components/SeatPrice";
import { SitSellToggle } from "@/components/SitSellToggle";
import { CheckedBadge } from "@/components/CheckedBadge";
import { FreshBadge, FreshRow } from "@/components/FreshBadge";
import { SiteNav } from "@/components/SiteNav";
import { ageLabel, hoursSince, latestOf } from "@shared/freshness";
import { soldKeepTotalOf, startingTypeIn } from "@shared/book-pricing";
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
import { gameMatchesQuery } from "@/lib/game-search";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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

type Tone = "sit" | "sell" | "tbd";

function decisionTone(value: string): Tone {
  const key = value.toLowerCase();
  if (key === "sit" || key === "sell") return key;
  return "tbd";
}

const ROW_TONE: Record<Tone, string> = {
  sit: "bg-sit hover:bg-sit",
  sell: "bg-sell hover:bg-sell",
  tbd: "bg-tbd hover:bg-tbd",
};

const CARD_ACCENT: Record<Tone, string> = {
  sit: "border-l-sit-ink",
  sell: "border-l-sell-ink",
  tbd: "border-l-tbd-ink",
};

const TIP = {
  model: "Model price: our suggested per-seat type-in for Ticketmaster (before the 5% seller fee). Median of comparable 107/108/118/119 rows J–T listings, plus any premium. Display only.",
  yours: "Your price: the per-seat number you type into Ticketmaster (before the 5% fee). Starts at the model price or your live listing; edit to override. You keep 95% of it per seat.",
  pair: "Pair total: Your price × 2 seats, before fees. Hover a value for the payout after the 5% fee.",
  getIn: "Get in price: cheapest single-ticket listing anywhere in the arena (not your section), per seat, from the SeatData pull. Listing price as SeatData reports it (may include buyer fees).",
  median: "Median price: middle listing price across the whole arena, per seat, from the SeatData pull. Asking prices, not sales (may include buyer fees).",
};

function etStamp(at: string): string {
  return new Date(at).toLocaleString("en-US", {
    timeZone: "America/New_York", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function pulledAt(game: Game): string {
  return game.comp_checked_at ? `Pulled ${etStamp(game.comp_checked_at)} ET.` : "Pull time unknown.";
}

function pairTotal(view: SeatPriceView): number | null {
  return view.typeIn != null ? view.typeIn * 2 : null;
}

function StatusBadge({ status, game }: { status: ListingOverride; game: Game }) {
  if (status.sold) {
    const total = soldKeepTotalOf({ sold: true, sold_keep_total: game.sold_keep_total });
    return (
      <Badge className="bg-emerald-700 text-white">
        Sold{total != null ? ` · ${formatMoney(total)} in` : ""}
      </Badge>
    );
  }
  if (!status.listed) return null;
  const price =
    status.listed_ask != null && status.listed_ask > 0
      ? ` · $${status.listed_ask}/seat`
      : game.listed_buyer_price != null && game.listed_buyer_price > 0
        ? ` · buyer sees $${game.listed_buyer_price}`
        : "";
  return <Badge>Listed{price}</Badge>;
}

function TmBadge({ game }: { game: Game }) {
  const tm = game.tm_portal;
  if (!tm || (tm.suggested == null && tm.listed_price == null)) return null;
  const at = tm.suggested_read_at ?? tm.read_at;
  const hours = hoursSince(at);
  const parts = [
    tm.suggested != null ? `TM sugg $${tm.suggested}` : `TM listed $${tm.listed_price}`,
    tm.range_low != null && tm.range_high != null ? `$${tm.range_low}–$${tm.range_high}` : null,
    tm.sell_now != null ? `Sell Now $${tm.sell_now}` : null,
    hours != null ? `read ${ageLabel(hours)}` : null,
  ].filter(Boolean);
  const title = [at ? `Read ${etStamp(at)} ET` : null, tm.note].filter(Boolean).join(". ");
  return (
    <Badge variant="outline" className="h-auto whitespace-normal border-sky-200 bg-sky-50 text-left text-sky-900" title={title || undefined}>
      {parts.join(" · ")}
    </Badge>
  );
}

/** Preseason, Listed/Sold, TM read and comp freshness, wrapped on one line. */
function GameBadges({ game, status }: { game: Game; status: ListingOverride }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {game.type === "preseason" ? <Badge variant="secondary">Preseason</Badge> : null}
      <StatusBadge status={status} game={game} />
      <TmBadge game={game} />
      <CheckedBadge at={game.comp_checked_at} />
    </div>
  );
}

function GameLinks({ game }: { game: Game }) {
  const link = "font-semibold text-navy underline underline-offset-2";
  return (
    <div className="flex flex-wrap gap-x-3 text-sm">
      <a href={`/trends/${game.date}`} className={link}>
        Price trend
      </a>
      {game.ticketdata_url ? (
        <a className={link} href={game.ticketdata_url} target="_blank" rel="noopener noreferrer">
          TicketData
        </a>
      ) : null}
    </div>
  );
}

function StatusCheck({
  label,
  name,
  checked,
  onChange,
}: {
  label: string;
  name: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 whitespace-nowrap text-sm lg:min-h-7">
      <Checkbox
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
        aria-label={`${label} ${name}`}
      />
      {label}
    </label>
  );
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

function SortButton({
  column,
  label,
  sort,
  onSort,
}: {
  column: SortKey;
  label: string;
  sort: GameSort;
  onSort: (column: SortKey) => void;
}) {
  const direction = sort.key === column ? sort.direction : null;
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-left text-xs font-semibold text-navy select-none"
      onClick={() => onSort(column)}
    >
      {label}
      <SortMark direction={direction} />
      <span className="sr-only">
        {direction === "asc" ? ", sorted ascending" : direction === "desc" ? ", sorted descending" : ", not sorted"}
      </span>
    </button>
  );
}

/** A header cell with one or more sort buttons (stacked when there are two). */
function SortHead({
  columns,
  sort,
  onSort,
  title,
  className,
}: {
  columns: { key: SortKey; label: string }[];
  sort: GameSort;
  onSort: (column: SortKey) => void;
  title?: string;
  className?: string;
}) {
  const active = columns.find((column) => column.key === sort.key);
  return (
    <TableHead
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      title={title}
      className={cn("h-auto bg-thead py-2 align-bottom", className)}
    >
      <div className="flex flex-col items-start gap-0.5">
        {columns.map((column) => (
          <SortButton key={column.key} column={column.key} label={column.label} sort={sort} onSort={onSort} />
        ))}
      </div>
    </TableHead>
  );
}

function DaysOut({ date, todayEt }: { date: string; todayEt: string }) {
  const days = daysUntil(date, todayEt);
  if (days == null) return null;
  return <span className="text-xs font-semibold text-navy">{formatDaysOut(days)}</span>;
}

function When({ game, todayEt }: { game: Game; todayEt: string }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-[#3d4654]">
      <span className="font-semibold text-foreground">
        {formatGameDate(game.date, game.weekday)} {formatYear(game.date)}
      </span>
      <span>{game.time_et} ET</span>
      <DaysOut date={game.date} todayEt={todayEt} />
    </p>
  );
}

function Money({ value, strong = false }: { value: number | null; strong?: boolean }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn("tabular-nums", strong ? "text-base font-bold text-navy" : "text-sm text-foreground/80")}>
      {formatMoney(value)}
    </span>
  );
}

type RowHandlers = {
  onListed: (checked: boolean) => void;
  onSold: (checked: boolean) => void;
  onDecision: (choice: ScenarioChoice) => void;
  onTypeIn: (typeIn: number) => void;
  onClearPrice: () => void;
};

type RowProps = {
  game: Game;
  status: ListingOverride;
  view: SeatPriceView;
  todayEt: string;
  centralLabel: string;
} & RowHandlers;

function Stat({ label, value, title, strong }: { label: string; value: number | null; title?: string; strong?: boolean }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>
        <Money value={value} strong={strong} />
      </dd>
    </div>
  );
}

/** Phone and tablet: one card per game. */
function GameCard({ game, status, view, todayEt, centralLabel, ...on }: RowProps) {
  const prices = buildingPrices(game);
  const tone = decisionTone(game.sit_or_sell);
  return (
    <Card className={cn("gap-0 border-l-[5px] py-0", CARD_ACCENT[tone])}>
      <CardHeader className={cn("gap-1.5 py-3", ROW_TONE[tone])}>
        <CardTitle className="text-lg leading-tight text-navy">{game.opponent}</CardTitle>
        <When game={game} todayEt={todayEt} />
        <GameBadges game={game} status={status} />
        <SitSellToggle className="mt-1" value={game.sit_or_sell} opponent={game.opponent} onChange={on.onDecision} />
      </CardHeader>
      <CardContent className="space-y-3 py-3">
        <SeatPrice opponent={game.opponent} view={view} onTypeIn={on.onTypeIn} onClear={on.onClearPrice} />
        <dl className="grid grid-cols-3 gap-2">
          <Stat
            label="Pair total"
            value={pairTotal(view)}
            strong
            title={view.pair != null ? `You keep ${formatMoney(view.pair)} after the 5% fee.` : TIP.pair}
          />
          <Stat label="Get in" value={prices.getIn} title={`${TIP.getIn} ${pulledAt(game)}`} />
          <Stat label={centralLabel === "Mean" ? "Average" : "Median"} value={prices.central} title={`${TIP.median} ${pulledAt(game)}`} />
        </dl>
        {status.notes ? <p className="text-sm leading-snug text-muted-foreground">{status.notes}</p> : null}
      </CardContent>
      <CardFooter className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t py-1">
        <StatusCheck label="Listed" name={game.opponent} checked={status.listed} onChange={on.onListed} />
        <StatusCheck label="Sold" name={game.opponent} checked={status.sold} onChange={on.onSold} />
        <div className="ml-auto">
          <GameLinks game={game} />
        </div>
      </CardFooter>
    </Card>
  );
}

/** Desktop: one table row per game, sized to fit the page with no sideways scroll. */
function GameRow({ game, status, view, todayEt, centralLabel, ...on }: RowProps) {
  const prices = buildingPrices(game);
  const tone = decisionTone(game.sit_or_sell);
  return (
    <TableRow className={cn("[&>td]:py-2.5 [&>td]:align-top", ROW_TONE[tone])}>
      <TableCell className="w-full min-w-0 whitespace-normal pl-4">
        <div className="space-y-1">
          <p className="font-semibold text-navy">{game.opponent}</p>
          <When game={game} todayEt={todayEt} />
          <GameBadges game={game} status={status} />
          <GameLinks game={game} />
          {status.notes ? <p className="text-xs leading-snug text-muted-foreground">{status.notes}</p> : null}
        </div>
      </TableCell>
      <TableCell>
        <SitSellToggle className="w-28" value={game.sit_or_sell} opponent={game.opponent} onChange={on.onDecision} />
      </TableCell>
      <TableCell className="w-48 min-w-48 whitespace-normal">
        <SeatPrice compact opponent={game.opponent} view={view} onTypeIn={on.onTypeIn} onClear={on.onClearPrice} />
      </TableCell>
      <TableCell
        className="text-right"
        title={view.pair == null ? TIP.pair : `You keep ${formatMoney(view.pair)} after the 5% fee.`}
      >
        <Money value={pairTotal(view)} strong />
      </TableCell>
      <TableCell className="text-right" title={`${TIP.getIn} ${pulledAt(game)}`}>
        <Money value={prices.getIn} />
      </TableCell>
      <TableCell className="text-right" title={`${TIP.median} ${pulledAt(game)}`}>
        <Money value={prices.central} />
        {prices.centralKind === "mean" && centralLabel === "Median" ? (
          <span className="block text-[11px] text-muted-foreground">average</span>
        ) : null}
      </TableCell>
      <TableCell className="pr-4">
        <div className="flex flex-col">
          <StatusCheck label="Listed" name={game.opponent} checked={status.listed} onChange={on.onListed} />
          <StatusCheck label="Sold" name={game.opponent} checked={status.sold} onChange={on.onSold} />
        </div>
      </TableCell>
    </TableRow>
  );
}

function SortPicker({
  sort,
  centralLabel,
  onChange,
}: {
  sort: GameSort;
  centralLabel: string;
  onChange: (sort: GameSort) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <Select value={sort.key} onValueChange={(key) => onChange({ key: key as SortKey, direction: "asc" })}>
        <SelectTrigger aria-label="Sort games" className="h-11 min-w-36 bg-background lg:h-8">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SORT_COLUMNS.map((column) => (
            <SelectItem key={column.key} value={column.key}>
              {column.key === "central" ? (centralLabel === "Mean" ? "Average price" : "Median price") : column.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-11 lg:size-8"
        aria-label={sort.direction === "asc" ? "Sorted ascending, switch to descending" : "Sorted descending, switch to ascending"}
        onClick={() => onChange({ ...sort, direction: sort.direction === "asc" ? "desc" : "asc" })}
      >
        {sort.direction === "asc" ? <ArrowUpIcon /> : <ArrowDownIcon />}
      </Button>
    </div>
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
  const todayEt = useMemo(() => etYmd(new Date()), []);

  const games = useMemo(
    () => [...book.games].sort((a, b) => a.date.localeCompare(b.date)),
    [book.games],
  );

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
    () => scenarioSummary(
      priced.map((item) => item.priced),
      scenario,
      book.season_cost,
    ),
    [priced, scenario, book.season_cost],
  );

  // Season cash is money already in from sold pairs; the Sell plan adds the rest.
  const banked = useMemo(
    () => Math.round(priced.reduce((sum, item) => sum + (item.soldTotal ?? 0), 0) * 100) / 100,
    [priced],
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
    banked === 0
      ? `Nothing in yet toward ${formatMoney(book.season_cost)}`
      : `${formatMoney(banked)} in toward ${formatMoney(book.season_cost)}`;

  function handlersFor(date: string): RowHandlers {
    return {
      onListed: (checked) => patchStatus(date, { listed: checked }),
      onSold: (checked) => patchStatus(date, { sold: checked }),
      onDecision: (choice) => setDecision(date, choice),
      onTypeIn: (typeIn) => saveTypeIn(date, typeIn),
      onClearPrice: () => clearPrice(date),
    };
  }

  const emptyMessage =
    visible.length === 0 ? (
      <div className="px-4 py-7 text-center text-muted-foreground md:col-span-2">No games match this filter.</div>
    ) : null;

  return (
    <div className="mx-auto max-w-[1280px] px-3 pb-16 pt-4 sm:px-4 sm:pt-5">
      <header className="rounded-2xl bg-navy px-4 py-3 text-navy-foreground sm:px-5 sm:py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-heading text-[24px] leading-none tracking-tight sm:text-[30px]">Wizards 107P</h1>
          <SiteNav current="book" admin />
        </div>
        <p className="mt-1.5 text-sm leading-snug text-[#e4eaf3]">
          {book.games.length} home games for seats {book.seats.join("–")} in Section {book.section}, Row {book.row}. Prices are per seat.
        </p>
        <FreshRow className="mt-2">
          <FreshBadge source="Comps" at={latestOf(book.games.map((g) => g.comp_checked_at))} />
          {(() => {
            const missing = book.games.filter((g) => !g.comp_checked_at).length;
            return missing > 0 ? (
              <span className="text-xs text-[#e4eaf3]">{missing} {missing === 1 ? "game" : "games"} never checked</span>
            ) : null;
          })()}
        </FreshRow>
      </header>

      <section
        aria-label="Season summary"
        className="sticky top-0 z-40 -mx-3 mt-3 border-y border-line bg-[#f4f1ea]/95 px-3 py-2 shadow-[0_8px_18px_rgba(12,35,64,0.06)] backdrop-blur-md sm:-mx-4 sm:px-4 lg:static lg:mx-0 lg:rounded-xl lg:border lg:px-4 lg:py-3 lg:shadow-none lg:backdrop-blur-none"
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
              <span className="text-muted-foreground">
                {" "}
                · about {formatMoney(summary.sellCash)} with the Sell games at these prices ·{" "}
                {formatShortfall(summary.vsSeason, book.season_cost)}
              </span>
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

      <div className="my-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter games">
          {FILTERS.map((item) => (
            <Button
              key={item.id}
              type="button"
              size="sm"
              variant={filter === item.id ? "default" : "outline"}
              aria-pressed={filter === item.id}
              className="h-11 px-3.5 lg:h-8"
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 lg:ml-auto">
          <span className="text-sm text-muted-foreground">
            {visible.length} of {book.games.length}
          </span>
          <Button type="button" size="sm" variant="outline" className="h-9 lg:h-8" onClick={copyStatus}>
            {copyLabel}
          </Button>
          <Button type="button" size="sm" variant="outline" className="h-9 lg:h-8" onClick={clearLocal}>
            Clear listed and sold
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 lg:h-8"
            onClick={resetScenario}
            disabled={Object.keys(scenario).length === 0}
          >
            Reset Sit and Sell
          </Button>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="search" className="min-w-0 flex-1 basis-64">
          <InputGroup className="h-11 bg-background lg:h-9">
            <InputGroupAddon align="inline-start" className="pl-3">
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search games (team, date, notes)"
              aria-label="Search games"
              className="text-base md:text-sm [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
            />
            {query ? (
              <InputGroupAddon align="inline-end">
                <InputGroupButton aria-label="Clear search" size="icon-sm" onClick={() => setQuery("")}>
                  <XIcon />
                </InputGroupButton>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
        </div>
        <SortPicker sort={sort} centralLabel={centralLabel} onChange={setSort} />
      </div>

      <div className="grid gap-3 md:grid-cols-2 lg:hidden">
        {visible.map((row) => (
          <GameCard key={row.game.date} {...row} {...handlersFor(row.game.date)} todayEt={todayEt} centralLabel={centralLabel} />
        ))}
        {emptyMessage}
      </div>

      <Card className="hidden gap-0 border-line py-0 shadow-[0_10px_30px_rgba(11,31,58,0.12)] lg:flex">
        <Table className="table-auto">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <SortHead
                className="pl-4"
                columns={[
                  { key: "date", label: "Date" },
                  { key: "opponent", label: "Opponent" },
                ]}
                sort={sort}
                onSort={chooseSort}
              />
              <SortHead columns={[{ key: "sit_or_sell", label: "Sit or Sell" }]} sort={sort} onSort={chooseSort} />
              <SortHead columns={[{ key: "advised_ask", label: "Your price" }]} sort={sort} onSort={chooseSort} title={`${TIP.yours} ${TIP.model}`} />
              <SortHead columns={[{ key: "cash", label: "Pair" }]} sort={sort} onSort={chooseSort} title={TIP.pair} className="text-right [&>div]:items-end" />
              <SortHead columns={[{ key: "get_in", label: "Get in" }]} sort={sort} onSort={chooseSort} title={TIP.getIn} className="text-right [&>div]:items-end" />
              <SortHead
                columns={[{ key: "central", label: centralLabel === "Mean" ? "Average" : "Median" }]}
                sort={sort}
                onSort={chooseSort}
                title={TIP.median}
                className="text-right [&>div]:items-end"
              />
              <SortHead
                columns={[
                  { key: "listed", label: "Listed" },
                  { key: "sold", label: "Sold" },
                ]}
                sort={sort}
                onSort={chooseSort}
                className="pr-4"
              />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => (
              <GameRow key={row.game.date} {...row} {...handlersFor(row.game.date)} todayEt={todayEt} centralLabel={centralLabel} />
            ))}
          </TableBody>
        </Table>
        {emptyMessage}
      </Card>

      <details className="mt-4 rounded-xl border border-line bg-card px-4 py-3 text-sm leading-relaxed text-[#3d4654]">
        <summary className="flex min-h-11 cursor-pointer items-center font-semibold text-navy">
          How a price is figured
        </summary>
        <div className="mt-3 space-y-2">
          <p>
            You keep 95% of what you type in Account Manager, per seat; both seats pay double. A $49 type-in keeps
            $46.55, or $93.10 for the pair. Buyers pay more than you type. Sit or Sell only changes this book.
          </p>
          <p>
            The middle is similar lower-bowl seats: 107, 108, 118 and 119, rows J–T, without a lone cheap 107P
            listing. Suggestions are whole dollars ending in 0 or 5 ($150, $175), or 9 when it drops a digit ($199).
            Your own number can be anything and stays put.
          </p>
          <p>
            Big games sit about 10% over the middle until three weeks out; soft games drop about 5% inside two weeks.
            The $6,000 goal doesn&apos;t move a game&apos;s price.
          </p>
        </div>
      </details>
    </div>
  );
}
