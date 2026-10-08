import {
  LISTING_CSV_COLUMNS,
  PULL_CSV_COLUMNS,
  SUMMARY_CSV_COLUMNS,
  parseExportQuery,
  toCsv,
  type ExportQuery,
} from "../src/shared/archive";
import {
  countListings,
  countPulls,
  countSummaries,
  ensureArchive,
  ensureArchiveBackfill,
  queryListings,
  queryPulls,
  querySummaries,
} from "./archive-store";

const NOINDEX = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
};

function expandJson(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const next = { ...row };
    for (const key of ["payload_json", "extra_json"]) {
      const value = next[key];
      if (typeof value !== "string" || value === "") continue;
      try {
        next[key] = JSON.parse(value) as unknown;
      } catch {
        // Leave the original string when it is not JSON.
      }
    }
    return next;
  });
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: NOINDEX });
}

export async function exportArchive(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parseExportQuery(url.searchParams);
  if ("error" in parsed) return jsonError(parsed.error, 400);
  try {
    await ensureArchiveBackfill(env);
    await ensureArchive(env);
  } catch (error) {
    console.error("price archive export", error);
    return jsonError("archive_unavailable", 500);
  }
  if (parsed.format === "csv") return csvResponse(env, parsed);
  return jsonResponse(env, parsed);
}

async function jsonResponse(env: Env, query: ExportQuery): Promise<Response> {
  const wantPulls = query.table === "all" || query.table === "pulls";
  const wantListings = query.table === "all" || query.table === "listings";
  const wantSummaries = query.table === "all" || query.table === "summaries";
  const [pulls, listings, summaries, pullsCount, listingsCount, summariesCount] = await Promise.all([
    wantPulls ? queryPulls(env, query) : Promise.resolve([]),
    wantListings ? queryListings(env, query) : Promise.resolve([]),
    wantSummaries ? querySummaries(env, query) : Promise.resolve([]),
    wantPulls ? countPulls(env, query) : Promise.resolve(0),
    wantListings ? countListings(env, query) : Promise.resolve(0),
    wantSummaries ? countSummaries(env, query) : Promise.resolve(0),
  ]);
  return Response.json(
    {
      pulls: expandJson(pulls),
      listings: expandJson(listings),
      summaries: expandJson(summaries),
      limit: query.limit,
      offset: query.offset,
      counts: { pulls: pullsCount, listings: listingsCount, summaries: summariesCount },
    },
    { headers: NOINDEX },
  );
}

async function csvResponse(env: Env, query: ExportQuery): Promise<Response> {
  const columns =
    query.table === "pulls"
      ? PULL_CSV_COLUMNS
      : query.table === "summaries"
        ? SUMMARY_CSV_COLUMNS
        : LISTING_CSV_COLUMNS;
  const load =
    query.table === "pulls" ? queryPulls : query.table === "summaries" ? querySummaries : queryListings;
  const filename = `wizards-107p-${query.table}.csv`;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(`${columns.join(",")}\n`));
        const pageSize = 500;
        let offset = 0;
        for (;;) {
          const page = await load(env, { ...query, limit: pageSize, offset });
          if (page.length === 0) break;
          const body = toCsv(columns, page);
          const withoutHeader = body.slice(body.indexOf("\n") + 1);
          if (withoutHeader) controller.enqueue(encoder.encode(withoutHeader));
          if (page.length < pageSize) break;
          offset += page.length;
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(stream, {
    headers: {
      ...NOINDEX,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
