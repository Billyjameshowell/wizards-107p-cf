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
