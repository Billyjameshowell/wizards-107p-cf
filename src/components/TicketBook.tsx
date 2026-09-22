import { useMemo, useState } from "react";
import type { Book, FilterId, Game, ListingOverride, ListingStatusMap } from "@shared/book";
import { formatGameDate, formatMoney, formatShortfall, formatYear } from "@shared/format";
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
import { buildExportMap, mergeGameStatus, readLocalStatus, writeLocalStatus } from "@/lib/status";
import { MAX_TABLE_SCALE, MIN_TABLE_SCALE, stepTableScale } from "@/lib/table-zoom";
import { usePinchZoom } from "@/lib/use-pinch-zoom";
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

function SitSellLabel({ value }: { value: string }) {
  const tone = decisionTone(value);
  return (
    <span
      className={cn(
        "font-bold",
        tone === "sit" && "text-sit-ink",
        tone === "sell" && "text-sell-ink",
        tone === "tbd" && "text-tbd-ink",
      )}
    >
      {value}
    </span>
  );
}

function PreseasonMark({ type }: { type: string }) {
  if (type !== "preseason") return null;
  return (
    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
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
    <label className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 whitespace-nowrap lg:min-h-0">
      <input
        type="checkbox"
        className="size-3.5 accent-navy"
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
        className="inline-flex items-center gap-1 text-left font-medium select-none"
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

function PriceStat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-semibold tabular-nums">{formatMoney(value)}</dd>
    </div>
  );
}

function GameCard({
  game,
  status,
  onListed,
  onSold,
}: {
  game: Game;
  status: ListingOverride;
  onListed: (checked: boolean) => void;
  onSold: (checked: boolean) => void;
}) {
  const prices = buildingPrices(game);
  return (
    <article className={cn("rounded-xl border border-line px-3 py-3", toneRowClass(game.sit_or_sell))}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold leading-tight">{formatGameDate(game.date, game.weekday)}</p>
          <p className="text-xs font-medium text-muted-foreground">{formatYear(game.date)}</p>
        </div>
        <SitSellLabel value={game.sit_or_sell} />
      </div>

      <p className="mt-2 text-base font-semibold leading-snug break-words">{game.opponent}</p>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground">
        <span>{game.time_et} ET</span>
        <PreseasonMark type={game.type} />
      </p>

      <dl className="mt-3 grid max-w-md grid-cols-2 gap-3">
        <div className="min-w-0">
          <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
            Advised ask
          </dt>
          <dd className="mt-0.5 font-semibold tabular-nums">{formatMoney(game.advised_ask)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
            Cash both after 10%
          </dt>
          <dd className="mt-0.5 font-semibold tabular-nums">{formatMoney(game.cash_both_after_fee)}</dd>
        </div>
        <PriceStat label="Get-in" value={prices.getIn} />
        <PriceStat
          label={prices.centralKind === "mean" ? "Mean" : "Median"}
          value={prices.central}
        />
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
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

      <p className="mt-2 text-sm leading-snug break-words text-slate-700">
        <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
          Notes
        </span>
        <span className="mt-0.5 block">{status.notes || "—"}</span>
      </p>
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
  const [filter, setFilter] = useState<FilterId>("all");
  const [copyLabel, setCopyLabel] = useState("Copy status");
  const [sort, setSort] = useState<GameSort>(DEFAULT_GAME_SORT);
  const { scale, setScale, bind } = usePinchZoom();

  const games = useMemo(
    () => [...book.games].sort((a, b) => a.date.localeCompare(b.date)),
    [book.games],
  );

  const rows = useMemo(
    () =>
      games.map((game) => ({
        game,
        status: mergeGameStatus(game, repoStatus, localStatus),
      })),
    [games, repoStatus, localStatus],
  );

  const visible = useMemo(() => {
    const filtered = rows.filter(({ game, status }) => {
      if (filter === "sit") return game.sit_or_sell === "Sit";
      if (filter === "sell") return game.sit_or_sell === "Sell";
      if (filter === "listed") return status.listed;
      if (filter === "sold") return status.sold;
      if (filter === "not-listed") return !status.listed && !status.sold;
      return true;
    });
    return sortGameRows(filtered, sort);
  }, [rows, filter, sort]);

  const centralLabel = centralColumnLabel(visible.map((row) => row.game));

  function chooseSort(column: SortKey) {
    setSort((current) => toggleSort(current, column));
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

  const emptyMessage =
    visible.length === 0 ? (
      <div className="px-4 py-7 text-center text-muted-foreground">No games match this filter.</div>
    ) : null;

  return (
    <div className="mx-auto max-w-[1180px] px-3 pb-16 pt-4 sm:px-4 sm:pt-5">
      <header className="rounded-xl bg-navy px-4 py-4 text-navy-foreground sm:px-5 sm:py-5">
        <p className="m-0 text-[12px] leading-snug uppercase tracking-[0.08em] text-gold">
          Capital One Arena · Section {book.section} Row {book.row} · seats {book.seats.join("–")}
        </p>
        <h1 className="font-heading mt-1 text-[22px] tracking-tight sm:text-[28px]">Wizards 107P</h1>
        <p className="mt-1.5 text-sm leading-snug text-navy-muted">
          Season ticket desk · last market pull {book.asof_et} ET · target{" "}
          {formatMoney(book.season_cost)}
        </p>
        <ul className="mt-4 grid list-none gap-2.5 p-0 sm:grid-cols-3">
          <li className="rounded-lg bg-white/5 px-3 py-2.5">
            <p className="m-0 text-[11px] font-medium uppercase tracking-[0.06em] text-navy-muted">
              Sell-book cash after ~10%
            </p>
            <p className="mt-1 text-lg font-semibold tracking-tight">{formatMoney(book.sell_book_cash)}</p>
          </li>
          <li className="rounded-lg bg-white/5 px-3 py-2.5">
            <p className="m-0 text-[11px] font-medium uppercase tracking-[0.06em] text-navy-muted">
              Vs $6,000
            </p>
            <p className="mt-1 text-lg font-semibold tracking-tight leading-snug">
              {formatShortfall(book.vs_6k, book.season_cost)}
            </p>
          </li>
          <li className="rounded-lg bg-white/5 px-3 py-2.5">
            <p className="m-0 text-[11px] font-medium uppercase tracking-[0.06em] text-navy-muted">
              Home games
            </p>
            <p className="mt-1 text-lg font-semibold tracking-tight">{book.games.length}</p>
          </li>
        </ul>
      </header>

      <div className="my-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter games">
          {FILTERS.map((item) => (
            <Button
              key={item.id}
              type="button"
              size="sm"
              variant={filter === item.id ? "default" : "outline"}
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {visible.length} of {book.games.length}
          </span>
          <Button type="button" size="sm" variant="outline" onClick={copyStatus}>
            {copyLabel}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={clearLocal}>
            Clear local status
          </Button>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
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
          const label = column.key === "central" ? centralLabel : column.label;
          return (
            <Button
              key={column.key}
              type="button"
              size="sm"
              variant={active ? "default" : "outline"}
              aria-pressed={active}
              className="shrink-0"
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
        <div className="space-y-2.5">
          {visible.map(({ game, status }) => (
            <GameCard
              key={game.date}
              game={game}
              status={status}
              onListed={(checked) => patchStatus(game.date, { listed: checked })}
              onSold={(checked) => patchStatus(game.date, { sold: checked })}
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
            <div className="min-w-[1240px]">
              <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <SortableHead column="date" sort={sort} onSort={chooseSort} className="sticky top-0 z-20 bg-thead" />
                  <SortableHead column="opponent" sort={sort} onSort={chooseSort} className="sticky top-0 z-10 bg-thead" />
                  <SortableHead column="type" sort={sort} onSort={chooseSort} className="sticky top-0 z-10 bg-thead" />
                  <SortableHead column="time" sort={sort} onSort={chooseSort} className="sticky top-0 z-10 bg-thead" />
                  <SortableHead column="sit_or_sell" sort={sort} onSort={chooseSort} className="sticky top-0 z-10 bg-thead" />
                  <SortableHead column="advised_ask" sort={sort} onSort={chooseSort} className="sticky top-0 z-10 bg-thead" />
                  <SortableHead column="cash" sort={sort} onSort={chooseSort} className="sticky top-0 z-10 bg-thead" />
                  <SortableHead column="get_in" sort={sort} onSort={chooseSort} className="sticky top-0 z-10 bg-thead" />
                  <SortableHead
                    column="central"
                    label={centralLabel}
                    sort={sort}
                    onSort={chooseSort}
                    className="sticky top-0 z-10 bg-thead"
                  />
                  <SortableHead column="listed" sort={sort} onSort={chooseSort} className="sticky top-0 z-10 bg-thead" />
                  <SortableHead column="sold" sort={sort} onSort={chooseSort} className="sticky top-0 z-10 bg-thead" />
                  <SortableHead column="ticketdata" sort={sort} onSort={chooseSort} className="sticky top-0 z-10 bg-thead" />
                  <SortableHead column="notes" sort={sort} onSort={chooseSort} className="sticky top-0 z-10 bg-thead" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map(({ game, status }) => {
                  const prices = buildingPrices(game);
                  return (
                  <TableRow key={game.date} className={cn(toneRowClass(game.sit_or_sell))}>
                    <TableCell className="whitespace-nowrap font-semibold">
                      {formatGameDate(game.date, game.weekday)}
                      <span className="block text-xs font-medium text-muted-foreground">
                        {formatYear(game.date)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="font-semibold">{game.opponent}</span>{" "}
                      <PreseasonMark type={game.type} />
                    </TableCell>
                    <TableCell>{formatType(game.type)}</TableCell>
                    <TableCell>{game.time_et}</TableCell>
                    <TableCell>
                      <SitSellLabel value={game.sit_or_sell} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatMoney(game.advised_ask)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatMoney(game.cash_both_after_fee)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatMoney(prices.getIn)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatMoney(prices.central)}
                      {prices.centralKind === "mean" && centralLabel === "Median" ? (
                        <span className="ml-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          Mean
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
                    <TableCell className="max-w-[220px] whitespace-normal text-slate-700">
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
    </div>
  );
}
