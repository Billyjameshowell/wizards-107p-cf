import { Fragment, useMemo, useState } from "react";
import type { Book, FilterId, Game, ListingStatusMap } from "@shared/book";
import { formatGameDate, formatMoney, formatShortfall } from "@shared/format";
import { buildExportMap, mergeGameStatus, readLocalStatus, writeLocalStatus } from "@/lib/status";
import { MarketDetails } from "./MarketDetails";
import { formatPercentChange, percentChange } from "@shared/market-change";
import { teamForOpponent } from "@shared/teams";

const FILTERS: { id: FilterId; label: string }[] = [
  { id: "all", label: "All games" }, { id: "sit", label: "Sit" }, { id: "sell", label: "Sell" },
  { id: "not-listed", label: "Not listed" }, { id: "listed", label: "Listed" }, { id: "sold", label: "Sold" },
];
const money = (value: number | null | undefined) => formatMoney(value);
function Logo({ opponent }: { opponent: string }) {
  const team = teamForOpponent(opponent);
  return team ? <img className="team-logo" src={team.logo} width="20" height="20" alt="" loading="lazy" /> : <span className="team-logo unknown-logo" aria-hidden="true">?</span>;
}
function Delta({ game }: { game: Game }) {
  const current = game.market_details;
  const previous = game.market_previous_details;
  if (!current) return <span className="missing" title="No detailed market snapshot yet">—</span>;
  if (!previous || previous.source !== current.source) return <span className="baseline" title="First saved market snapshot">new</span>;
  const change = percentChange(current.zone_get_in, previous.zone_get_in);
  if (change == null) return <span className="missing" title="No comparable prior price">—</span>;
  return <span className={change > 0 ? "change-up" : change < 0 ? "change-down" : "change-flat"}
    title={`Custom-zone get-in compared with ${previous.asof} ET`}>{change > 0 ? "▲" : change < 0 ? "▼" : "="} {formatPercentChange(change)}</span>;
}
export function TicketBook({ book, repoStatus }: { book: Book; repoStatus: ListingStatusMap }) {
  const [localStatus, setLocalStatus] = useState<ListingStatusMap>(() => readLocalStatus());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
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

  const firstYear = games[0]?.date.slice(0, 4);
  const lastYear = games[games.length - 1]?.date.slice(2, 4);
  const baselineCount = games.filter(game => game.market_details).length;
  return (
    <main className="book-page" id="top">
      <header className="masthead">
        <div className="masthead-title"><Logo opponent="Washington Wizards" /><div><h1>WIZARDS <span>107P</span></h1><p>WASHINGTON WIZARDS · {firstYear}–{lastYear} HOME TICKET BOOK</p></div></div>
        <nav aria-label="Page navigation"><a href="#game-book">Ticket book</a><span> | </span><a href="/admin">Admin status</a><span> | </span><a href="#data-guide">Data guide</a></nav>
      </header>
      <div className="desk-line">CAPITAL ONE ARENA · SECTION <b>{book.section}</b> · ROW <b>{book.row}</b> · SEATS <b>{book.seats.join(" & ")}</b></div>
      <div className="summary-strip" aria-label="Season summary">
        <span><b>Sell-book net:</b> {money(book.sell_book_cash)}</span><span><b>Season cost:</b> {money(book.season_cost)}</span>
        <span><b>Balance:</b> {formatShortfall(book.vs_6k, book.season_cost)}</span><span><b>Home games:</b> {games.length}</span>
      </div>
      <section id="game-book" aria-labelledby="book-heading">
        <h2 className="section-title" id="book-heading">SEASON TICKET BOOK <span>{firstYear}–{lastYear}</span></h2>
        <div className="table-meta"><span><b>Last book update:</b> {book.asof_et} ET</span><span>Detailed baselines: <b>{baselineCount}/{games.length}</b> · Records refresh separately</span></div>
        <p className="table-instruction">Click an opponent or the <b>⊞</b> symbol for prices, comparable seats, and changes since its previous pull.</p>
        <div className="book-controls">
          <div className="filter-links" role="group" aria-label="Filter games">Show: {FILTERS.map((item, index) => <Fragment key={item.id}>
            {index > 0 && <span className="link-divider"> | </span>}<button type="button" className="text-link" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>
          </Fragment>)}</div>
          <div><span className="record-count">{visible.length} of {games.length}</span> · <button type="button" className="text-link" onClick={copyStatus}>{copyLabel}</button> · <button type="button" className="text-link" onClick={clearLocal}>Clear local status</button></div>
        </div>
        <div className="table-scroll" role="region" aria-label="Season ticket table; scroll horizontally for all columns" tabIndex={0}>
          <table className="season-table">
            <caption className="sr-only">Wizards home games with ticket decisions, per-ticket market prices, and local listing status</caption>
            <colgroup>{[28,86,184,66,48,68,76,66,68,66,66,76,34,34,190].map((width,index) => <col key={index} style={{width}} />)}</colgroup>
            <thead>
              <tr className="column-groups"><th colSpan={4} scope="colgroup">GAME INFORMATION</th><th colSpan={3} scope="colgroup">SECTION 107 · ROW P</th><th colSpan={5} scope="colgroup">MARKET SNAPSHOT · PER TICKET</th><th colSpan={3} scope="colgroup">TRACKING & NOTES</th></tr>
              <tr><th scope="col">#</th><th scope="col">Date</th><th scope="col" className="opponent-heading">Opponent</th><th scope="col">Time ET</th><th scope="col">Plan</th>
                <th scope="col" title="Lowest current asking price in the custom comparison zone">Ask</th><th scope="col" title="Estimated cash for two seats after a 10% selling fee">Net pair</th>
                <th scope="col" title="Lowest arena asking price among listings with at least two seats">Get-in</th><th scope="col" title="Median arena asking price among listings with at least two seats">Median</th>
                <th scope="col" title="Lowest asking price in sections 100–199, two or more seats">Lower lvl</th><th scope="col" title="Lowest asking price in sections 107, 108, 118, 119; rows J–T; two or more seats">Zone</th>
                <th scope="col" title="Custom-zone get-in percentage change since the previous comparable pull">Δ Zone</th><th scope="col" title="Listed locally">L</th><th scope="col" title="Sold locally">S</th><th scope="col">Notes / source</th></tr>
            </thead>
            <tbody>{visible.map(({game,status}) => {
              const details=game.market_details;
              const open=expanded.has(game.date);
              return <Fragment key={game.date}>
                <tr className={`game-row ${open ? "row-open" : ""}`}>
                  <td className="row-number">{games.findIndex(item => item.date === game.date)+1}</td>
                  <td className="game-date" title={game.date}>{formatGameDate(game.date,game.weekday)}{game.type === "preseason" && <sup title="Preseason">*</sup>}</td>
                  <th scope="row" className="opponent-cell"><Logo opponent={game.opponent} /><button type="button" className="text-link opponent-link" aria-expanded={open} aria-controls={`market-${game.date}`} onClick={() => setExpanded(current => { const next=new Set(current); if(next.has(game.date)) next.delete(game.date); else next.add(game.date); return next; })}><span aria-hidden="true">{open ? "⊟" : "⊞"}</span> {game.opponent}</button></th>
                  <td>{game.time_et}</td><td className={`plan plan-${game.sit_or_sell.toLowerCase()}`}>{game.sit_or_sell}</td>
                  <td className="number ask">{money(game.advised_ask)}</td><td className="number">{money(game.cash_both_after_fee)}</td>
                  <td className="number">{money(details ? details.get_in : game.market_get_in)}</td><td className="number">{money(details ? details.median : game.market_median)}</td>
                  <td className="number">{money(details?.lower_level_get_in)}</td><td className="number">{money(details?.zone_get_in)}</td><td className="delta-cell"><Delta game={game} /></td>
                  <td><input type="checkbox" aria-label={`Listed ${game.opponent} ${game.date}`} checked={status.listed} onChange={event => patchStatus(game.date,{listed:event.target.checked})} /></td>
                  <td><input type="checkbox" aria-label={`Sold ${game.opponent} ${game.date}`} checked={status.sold} onChange={event => patchStatus(game.date,{sold:event.target.checked})} /></td>
                  <td className="notes-cell">{status.notes || game.notes || "—"}{game.ticketdata_url && <> <a href={game.ticketdata_url} target="_blank" rel="noopener noreferrer" title={`TicketData for ${game.opponent}`}>↗</a></>}</td>
                </tr>
                {open && <tr className="details-row"><td colSpan={15} id={`market-${game.date}`}><MarketDetails game={game} /></td></tr>}
              </Fragment>;
            })}
            {visible.length===0 && <tr><td colSpan={15} className="empty-state">No games match this filter.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="table-key"><b>KEY:</b> <span className="plan-sit">Sit</span> = keep · <span className="plan-sell">Sell</span> = sell · * preseason · L listed · S sold · ▲ increase · ▼ decrease · <span className="baseline">new</span> first baseline · — unavailable</p>
      </section>
      <section id="data-guide" className="data-guide"><h2>ABOUT THIS BOOK</h2>
        <p>Prices are asking prices per ticket for listings with at least two seats. Net pair estimates two tickets after a 10% selling fee. The custom zone is sections <b>107, 108, 118, 119</b>, rows <b>J–T</b>. Expand a game to see its source, timestamp, previous prices, and comparable listings.</p>
        <p>Listed and sold checkboxes are saved in this browser only. They do not publish tickets. Market pulls remain capped at 20 per run and 25 per Eastern day.</p>
      </section>
      <footer>Wizards 107P · Independent season-ticket book · <a href="https://haslametrics.com" target="_blank" rel="noopener noreferrer">Layout inspiration: Haslametrics</a> · NBA team marks belong to their respective owners. <a href="#top">Back to top ↑</a></footer>
    </main>
  );
}
