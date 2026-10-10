import { INSTANT_OFFER_SOURCE, parseInstantOffer, type LoggedInstantOffer } from "../src/shared/instant-offer";
import { authorizeAdmin } from "./admin-status";
import { ensureArchive } from "./archive-store";

const INSERT_OFFER = `INSERT INTO instant_offers (
  game_date, offered_total, per_ticket, observed_at, source, note
) VALUES (?, ?, ?, ?, ?, ?)`;

const PRIVATE = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
};

export async function insertInstantOffer(env: Env, offer: LoggedInstantOffer): Promise<void> {
  await ensureArchive(env);
  await env.DB.prepare(INSERT_OFFER)
    .bind(offer.gameDate, offer.total, offer.perTicket, offer.observedAt, INSTANT_OFFER_SOURCE, offer.note)
    .run();
}

export async function loadInstantOffers(env: Env): Promise<LoggedInstantOffer[]> {
  await ensureArchive(env);
  const offers: LoggedInstantOffer[] = [];
  let offset = 0;
  for (;;) {
    const page = await env.DB.prepare(
      `SELECT game_date, offered_total, per_ticket, observed_at, note
       FROM instant_offers
       ORDER BY id
       LIMIT 400 OFFSET ?`,
    )
      .bind(offset)
      .all<{
        game_date: string;
        offered_total: number;
        per_ticket: number;
        observed_at: string;
        note: string | null;
      }>();
    const rows = page.results ?? [];
    for (const row of rows) {
      offers.push({
        gameDate: row.game_date,
        total: row.offered_total,
        perTicket: row.per_ticket,
        observedAt: row.observed_at,
        note: row.note,
      });
    }
    if (rows.length < 400) break;
    offset += rows.length;
  }
  return offers;
}

export async function instantOfferApiResponse(request: Request, env: Env, now = new Date()): Promise<Response> {
  if (!authorizeAdmin(request.headers.get("Authorization"), env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: PRIVATE });
  }
  if (request.method === "GET") {
    const offers = await loadInstantOffers(env);
    return Response.json({ offers }, { headers: PRIVATE });
  }
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { ...PRIVATE, Allow: "GET, POST" } });
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Send the offer as JSON." }, { status: 400, headers: PRIVATE });
  }
  const parsed = parseInstantOffer(
    {
      game: body.game ?? body.gameDate,
      offeredTotal: body.offeredTotal ?? body.offered_total,
      perTicket: body.perTicket ?? body.per_ticket,
      note: body.note,
    },
    now,
  );
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400, headers: PRIVATE });
  await insertInstantOffer(env, parsed.offer);
  return Response.json({ saved: parsed.offer }, { status: 201, headers: PRIVATE });
}

export async function instantOfferFormResponse(request: Request, env: Env, now = new Date()): Promise<Response> {
  if (!authorizeAdmin(request.headers.get("Authorization"), env.CRON_SECRET)) {
    return new Response("Admin sign-in required", {
      status: 401,
      headers: { ...PRIVATE, "WWW-Authenticate": 'Basic realm="Wizards 107P admin"' },
    });
  }
  if (request.method !== "POST") return new Response(null, { status: 405, headers: PRIVATE });
  const form = await request.formData();
  const parsed = parseInstantOffer(
    {
      game: form.get("game"),
      offeredTotal: form.get("offered_total"),
      perTicket: form.get("per_ticket"),
      note: form.get("note"),
    },
    now,
  );
  if (!parsed.ok) {
    return new Response(parsed.error, { status: 400, headers: { ...PRIVATE, "Content-Type": "text/plain; charset=utf-8" } });
  }
  await insertInstantOffer(env, parsed.offer);
  return new Response(null, { status: 303, headers: { ...PRIVATE, Location: "/admin?offer=saved" } });
}
