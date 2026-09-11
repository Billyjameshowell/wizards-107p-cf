import { useMemo, useState } from "react";
import type { Book, FilterId, ListingStatusMap } from "@shared/book";
import { formatGameDate, formatMoney, formatShortfall, formatYear } from "@shared/format";
import { buildExportMap, mergeGameStatus, readLocalStatus, writeLocalStatus } from "@/lib/status";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

  const visible = rows.filter(({ game, status }) => {
    if (filter === "sit") return game.sit_or_sell === "Sit";
    if (filter === "sell") return game.sit_or_sell === "Sell";
    if (filter === "listed") return status.listed;
    if (filter === "sold") return status.sold;
    if (filter === "not-listed") return !status.listed && !status.sold;
    return true;
  });

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

  return (
    <div className="mx-auto max-w-[1180px] px-4 pb-16 pt-5">
      <header className="rounded-xl bg-navy px-5 py-5 text-navy-foreground">
        <p className="m-0 text-[12px] uppercase tracking-[0.08em] text-gold">
          Capital One Arena · Section {book.section} Row {book.row} · seats {book.seats.join("–")}
        </p>
        <h1 className="font-heading mt-1 text-[28px] tracking-tight">Wizards 107P</h1>
        <p className="mt-1.5 text-sm text-navy-muted">
          Season ticket desk · last market pull {book.asof_et} ET · target{" "}
          {formatMoney(book.season_cost)}
        </p>
        <div className="mt-4 grid gap-2.5 md:grid-cols-3">
          <Card className="border-white/10 bg-white/5 text-navy-foreground shadow-none">
            <CardHeader className="px-3 py-2.5">
              <CardTitle className="text-[11px] font-medium uppercase tracking-[0.06em] text-navy-muted">
                Sell-book cash after ~10%
              </CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3 text-lg font-semibold tracking-tight">
              {formatMoney(book.sell_book_cash)}
            </CardContent>
          </Card>
          <Card className="border-white/10 bg-white/5 text-navy-foreground shadow-none">
            <CardHeader className="px-3 py-2.5">
              <CardTitle className="text-[11px] font-medium uppercase tracking-[0.06em] text-navy-muted">
                Vs $6,000
              </CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3 text-lg font-semibold tracking-tight">
              {formatShortfall(book.vs_6k, book.season_cost)}
            </CardContent>
          </Card>
          <Card className="border-white/10 bg-white/5 text-navy-foreground shadow-none">
            <CardHeader className="px-3 py-2.5">
              <CardTitle className="text-[11px] font-medium uppercase tracking-[0.06em] text-navy-muted">
                Home games
              </CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3 text-lg font-semibold tracking-tight">
              {book.games.length}
            </CardContent>
          </Card>
        </div>
      </header>

      <div className="my-4 flex flex-wrap items-center justify-between gap-3">
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

      <Card className="overflow-hidden border-line py-0 shadow-[0_10px_30px_rgba(11,31,58,0.12)]">
        <div className="max-h-[min(72vh,820px)] overflow-auto">
          <Table className="min-w-[920px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="sticky top-0 z-20 bg-thead">Date</TableHead>
                <TableHead className="sticky top-0 z-10 bg-thead">Opponent</TableHead>
                <TableHead className="sticky top-0 z-10 bg-thead">Time</TableHead>
                <TableHead className="sticky top-0 z-10 bg-thead">Sit/Sell</TableHead>
                <TableHead className="sticky top-0 z-10 bg-thead">Advised ask</TableHead>
                <TableHead className="sticky top-0 z-10 bg-thead">Cash both after 10%</TableHead>
                <TableHead className="sticky top-0 z-10 bg-thead">Listed?</TableHead>
                <TableHead className="sticky top-0 z-10 bg-thead">Sold?</TableHead>
                <TableHead className="sticky top-0 z-10 bg-thead">TicketData</TableHead>
                <TableHead className="sticky top-0 z-10 bg-thead">Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map(({ game, status }) => {
                const tone = decisionTone(game.sit_or_sell);
                return (
                  <TableRow
                    key={game.date}
                    className={cn(
                      tone === "sit" && "bg-sit hover:bg-sit",
                      tone === "sell" && "bg-sell hover:bg-sell",
                      tone === "tbd" && "bg-tbd hover:bg-tbd",
                    )}
                  >
                    <TableCell className="whitespace-nowrap font-semibold">
                      {formatGameDate(game.date, game.weekday)}
                      <span className="block text-xs font-medium text-muted-foreground">
                        {formatYear(game.date)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="font-semibold">{game.opponent}</span>
                      {game.type === "preseason" ? (
                        <span className="ml-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Preseason
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>{game.time_et}</TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "font-bold",
                          tone === "sit" && "text-sit-ink",
                          tone === "sell" && "text-sell-ink",
                          tone === "tbd" && "text-tbd-ink",
                        )}
                      >
                        {game.sit_or_sell}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatMoney(game.advised_ask)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatMoney(game.cash_both_after_fee)}
                    </TableCell>
                    <TableCell>
                      <label className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap">
                        <input
                          type="checkbox"
                          className="size-3.5 accent-navy"
                          checked={status.listed}
                          onChange={(event) =>
                            patchStatus(game.date, { listed: event.target.checked })
                          }
                        />
                        <span className="sr-only">Listed {game.opponent}</span>
                        {status.listed ? "Yes" : "No"}
                      </label>
                    </TableCell>
                    <TableCell>
                      <label className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap">
                        <input
                          type="checkbox"
                          className="size-3.5 accent-navy"
                          checked={status.sold}
                          onChange={(event) =>
                            patchStatus(game.date, { sold: event.target.checked })
                          }
                        />
                        <span className="sr-only">Sold {game.opponent}</span>
                        {status.sold ? "Yes" : "No"}
                      </label>
                    </TableCell>
                    <TableCell>
                      {game.ticketdata_url ? (
                        <a
                          className="whitespace-nowrap text-sm font-semibold text-navy underline underline-offset-2"
                          href={game.ticketdata_url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          TicketData
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[220px] text-slate-700">
                      {status.notes || "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {visible.length === 0 ? (
            <div className="px-4 py-7 text-center text-muted-foreground">
              No games match this filter.
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
