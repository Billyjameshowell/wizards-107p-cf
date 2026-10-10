import { etDateFrom } from "../src/shared/guardrails";
import type { ProbableSale } from "../src/shared/price-model";
import { ensureArchive } from "./archive-store";

const INSERT_SALE = `INSERT INTO likely_sales (
  recorded_at, et_date, game_date, seen_date, gone_date, days_out,
  section, row_name, quantity, price, certain, external_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(external_id) DO NOTHING`;

export async function insertProbableSales(env: Env, sales: readonly ProbableSale[], now = new Date()): Promise<void> {
  if (sales.length === 0) return;
  await ensureArchive(env);
  const recordedAt = now.toISOString();
  const etDate = etDateFrom(now);
  const statements = sales.map((sale) =>
    env.DB.prepare(INSERT_SALE).bind(
      recordedAt,
      etDate,
      sale.gameDate,
      sale.seenDate,
      sale.goneDate,
      sale.daysOut,
      sale.section,
      sale.row,
      sale.quantity,
      sale.price,
      sale.certain ? 1 : 0,
      sale.externalId,
    ),
  );
  const size = 40;
  for (let index = 0; index < statements.length; index += size) {
    await env.DB.batch(statements.slice(index, index + size));
  }
}

export async function loadCertainSales(env: Env): Promise<ProbableSale[]> {
  await ensureArchive(env);
  const sales: ProbableSale[] = [];
  let offset = 0;
  for (;;) {
    const page = await env.DB.prepare(
      `SELECT game_date, seen_date, gone_date, days_out, section, row_name, quantity, price, external_id
       FROM likely_sales
       WHERE certain = 1
       ORDER BY id
       LIMIT 400 OFFSET ?`,
    )
      .bind(offset)
      .all<{
        game_date: string;
        seen_date: string;
        gone_date: string;
        days_out: number;
        section: string;
        row_name: string;
        quantity: number;
        price: number;
        external_id: string;
      }>();
    const rows = page.results ?? [];
    for (const row of rows) {
      sales.push({
        gameDate: row.game_date,
        seenDate: row.seen_date,
        goneDate: row.gone_date,
        daysOut: row.days_out,
        section: row.section,
        row: row.row_name,
        quantity: row.quantity,
        price: row.price,
        certain: true,
        externalId: row.external_id,
        median: null,
        supply: null,
      });
    }
    if (rows.length < 400) break;
    offset += rows.length;
  }
  return sales;
}
