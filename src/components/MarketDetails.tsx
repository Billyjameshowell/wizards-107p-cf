import type { Game } from "@shared/book";
import { PriceChange } from "./PriceChange";
import { formatMoney } from "@shared/format";

export function MarketDetails({ game }: { game: Game }) {
  const details = game.market_details;
  const previous = game.market_previous_details?.source === details?.source ? game.market_previous_details : undefined;
  const metrics = [
    ["Arena get-in", details ? details.get_in : game.market_get_in, previous?.get_in],
    ["Arena median", details ? details.median : game.market_median, previous?.median],
    ["Lower-level get-in", details?.lower_level_get_in, previous?.lower_level_get_in],
    ["Lower-level median", details?.lower_level_median, previous?.lower_level_median],
    ["Custom zone get-in", details?.zone_get_in, previous?.zone_get_in],
    ["Custom zone median", details?.zone_median, previous?.zone_median],
  ] as const;
  return (
    <section className="market-details" aria-label={`Market details for ${game.opponent}`}>
      <h2>{game.opponent} — MARKET DETAIL</h2>
      <p><b>Record updated:</b> {game.market_updated_at_et || details?.asof ? `${game.market_updated_at_et || details?.asof} ET` : "Not recorded for this older record"}</p>
      {details && <p><b>Source:</b> {details.source} · <b>Snapshot:</b> {details.asof} ET · {previous ? `Compared with ${previous.asof} ET` : "First saved snapshot (baseline)"}</p>}
      <div className="detail-columns">
        <div>
          <h3>ASKING PRICES · PER TICKET · 2+ SEATS</h3>
          <table className="detail-table"><thead><tr><th scope="col">Market</th><th scope="col">Current</th><th scope="col">Previous</th><th scope="col">Change</th></tr></thead>
            <tbody>{metrics.map(([label,value,prior]) => <tr key={label}><th scope="row">{label}</th><td>{formatMoney(value)}</td><td>{formatMoney(prior)}</td><td>{details ? <PriceChange current={value} previous={prior} hasPrevious={Boolean(previous)} /> : "—"}</td></tr>)}</tbody>
          </table>
          <p>Lower level: sections 100–199. Zone: 107, 108, 118, 119 · rows J–T. All comparisons use the same source and seating filters.</p>
          {!details && <p>Detailed listings were not saved in the older pull. They will appear after this game’s next scheduled update.</p>}
        </div>
        <div><h3>CUSTOM-ZONE COMPARABLE LISTINGS</h3>
          {details ? <>
            <p>{details.zone_comp_count} matches · showing the lowest {details.zone_comps.length} · asking prices, not completed sales</p>
            <div className="comp-scroll" tabIndex={0} role="region" aria-label="Comparable listings">
              <table className="detail-table"><thead><tr><th scope="col">Section</th><th scope="col">Row</th><th scope="col">Qty</th><th scope="col">Price / seat</th></tr></thead>
                <tbody>{details.zone_comps.map((comp,index) => <tr key={index}><td>{comp.section}</td><td>{comp.row}</td><td>{comp.quantity}</td><td>{formatMoney(comp.price)}</td></tr>)}
                {!details.zone_comps.length && <tr><td colSpan={4}>No matching listings in this snapshot.</td></tr>}</tbody>
              </table>
            </div>
          </> : <p>No detailed snapshot yet.</p>}
        </div>
      </div>
    </section>
  );
}
