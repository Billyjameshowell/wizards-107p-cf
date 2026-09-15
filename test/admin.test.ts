import { describe, expect, it } from "vitest";
import seed from "../data/seed-book.json";
import {
  authorizeAdmin,
  adminLoginResponse,
  renderAdminStatusHtml,
  type AdminStatusSnapshot,
} from "../worker/admin";
import {
  ADMIN_REMEMBER_SECONDS,
  ADMIN_SESSION_TTL_SECONDS,
  createAdminSessionToken,
  sessionSetCookie,
  verifyAdminSessionToken,
} from "../worker/admin-auth";
import type { Book } from "@shared/book";
import {
  emptySpendState,
  parseFlags,
} from "@shared/guardrails";

const seedBook = seed as Book;

function snapshot(): AdminStatusSnapshot {
  const spend = emptySpendState("2026-09-15");
  spend.sources.seatdata = {
    ...spend.sources.seatdata,
    paidAttemptsToday: 1,
    pullsToday: 3,
    lastError: "token=super-secret",
  };
  spend.lastRun = {
    at: "2026-09-15T12:00:00.000Z",
    trigger: "cron",
    ingestEnabled: true,
    dryRun: false,
    sources: {
      seatdata: { attempted: true, paid: true, pulls: 3, aborted: "Bearer super-secret" },
      apify: { attempted: false, paid: false },
    },
  };
  return {
    book: {
      ...seedBook,
      games: [
        {
          ...seedBook.games[0],
          opponent: "<script>alert(1)</script>",
          advised_ask: 210,
          cash_both_after_fee: 378,
          market_get_in: 190,
          market_median: 225,
          listing_count: 4,
        },
      ],
    },
    flags: parseFlags({ INGEST_ENABLED: "true", DRY_RUN: "false" }),
    spend,
    credentials: { seatdata: true, apify: false },
    generatedAtEt: "2026-09-15",
    redactionSecrets: ["super-secret"],
  };
}

describe("admin authorization", () => {
  it("accepts admin Basic auth and the cron Bearer token", () => {
    expect(authorizeAdmin(`Basic ${btoa("admin:secret")}`, "secret")).toBe(true);
    expect(authorizeAdmin("Bearer secret", "secret")).toBe(true);
    expect(authorizeAdmin(`Basic ${btoa("admin:wrong")}`, "secret")).toBe(false);
    expect(authorizeAdmin(`Basic ${btoa("user:secret")}`, "secret")).toBe(false);
    expect(authorizeAdmin(undefined, "secret")).toBe(false);
    expect(authorizeAdmin(`Basic ${btoa("admin:secret")}`, undefined)).toBe(false);
  });
});

describe("admin status HTML", () => {
  it("shows operational state and prices without controls or secret values", () => {
    const html = renderAdminStatusHtml(snapshot());

    expect(html).toContain("Ingest enabled");
    expect(html).toContain("SeatData");
    expect(html).toContain("1 today; run cap 1");
    expect(html).toContain("3 / 20");
    expect(html).toContain("$210.00");
    expect(html).toContain("$190.00");
    expect(html).toContain("$225.00");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("token=[redacted]");
    expect(html).not.toContain("super-secret");
    expect(html).toContain("Billing is shown separately above");
    expect(html).not.toMatch(/<form\b/i);
    expect(html).not.toMatch(/<button\b/i);
  });

  it("treats a market detail snapshot as authoritative, including null values", () => {
    const withSnapshot = snapshot();
    withSnapshot.book.games[0].market_details = {
      source: "seatdata",
      asof: "2026-09-15 12:00pm",
      get_in: null,
      median: 201,
      lower_level_get_in: null,
      lower_level_median: null,
      zone_get_in: null,
      zone_median: null,
      zone_comp_count: 0,
      zone_comps: [],
    };
    const html = renderAdminStatusHtml(withSnapshot);
    expect(html).toContain("$201.00");
    expect(html).not.toContain("$190.00");
    expect(html).toContain("2026-09-15 12:00pm");
  });
});

describe("admin browser sessions", () => {
  const secret = "test-cron-secret";
  const issuedAt = new Date("2026-09-15T12:00:00.000Z");

  it("enforces signed scope, expiry, and secret rotation", async () => {
    const token = await createAdminSessionToken(secret, false, issuedAt);
    expect(token).toBeTruthy();
    expect(await verifyAdminSessionToken(token, secret, new Date(issuedAt.getTime() + ADMIN_SESSION_TTL_SECONDS * 1000 - 1000))).toBe(true);
    expect(await verifyAdminSessionToken(token, secret, new Date(issuedAt.getTime() + ADMIN_SESSION_TTL_SECONDS * 1000))).toBe(false);
    expect(await verifyAdminSessionToken(`${token}x`, secret, issuedAt)).toBe(false);
    expect(await verifyAdminSessionToken(token, "rotated-secret", issuedAt)).toBe(false);
  });

  it("gives remembered sessions a 30-day expiry and persistent cookie only when selected", async () => {
    const token = await createAdminSessionToken(secret, true, issuedAt);
    expect(await verifyAdminSessionToken(token, secret, new Date(issuedAt.getTime() + (ADMIN_REMEMBER_SECONDS - 1) * 1000))).toBe(true);
    expect(await verifyAdminSessionToken(token, secret, new Date(issuedAt.getTime() + ADMIN_REMEMBER_SECONDS * 1000))).toBe(false);
    expect(sessionSetCookie(token!, false)).toContain("HttpOnly; Secure; SameSite=Strict");
    expect(sessionSetCookie(token!, false)).not.toContain("Max-Age");
    expect(sessionSetCookie(token!, true)).toContain(`Max-Age=${ADMIN_REMEMBER_SECONDS}`);
  });

  it("accepts same-origin bounded password login without putting the secret in HTML or cookie", async () => {
    const env = { CRON_SECRET: secret } as Env;
    const response = await adminLoginResponse(
      new Request("https://example.test/admin/login", {
        method: "POST",
        headers: {
          Origin: "https://example.test",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "password=test-cron-secret&remember=30",
      }),
      env,
    );
    expect(response.status).toBe(303);
    const cookie = response.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain(`Max-Age=${ADMIN_REMEMBER_SECONDS}`);
    expect(cookie).not.toContain(secret);
    expect((await (await adminLoginResponse(new Request("https://example.test/admin/login"), env)).text())).not.toContain(secret);
  });

  it("rejects cross-origin login posts", async () => {
    const response = await adminLoginResponse(
      new Request("https://example.test/admin/login", {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "password=test-cron-secret",
      }),
      { CRON_SECRET: secret } as Env,
    );
    expect(response.status).toBe(403);
  });
});


describe("privacy-preserving admin form submissions", () => {
  const submit = (headers: Record<string,string>) => adminLoginResponse(new Request("https://example.test/admin", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: "password=test-secret&remember=30",
  }), { CRON_SECRET: "test-secret" } as Env);
  it("accepts a redacted Origin only with same-origin browser metadata", async () => {
    expect((await submit({ Origin: "null", "Sec-Fetch-Site": "same-origin" })).status).toBe(303);
    expect((await submit({ "Sec-Fetch-Site": "same-origin" })).status).toBe(303);
  });
  it("rejects redacted cross-site, same-site, and unverified submissions", async () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      expect((await submit({ Origin: "null", "Sec-Fetch-Site": site })).status).toBe(403);
    }
    expect((await submit({ Origin: "null" })).status).toBe(403);
    expect((await submit({})).status).toBe(403);
    expect((await submit({ Origin: "https://attacker.example", "Sec-Fetch-Site": "same-origin" })).status).toBe(403);
  });
});


describe("admin USD reporting", () => {
  it("shows separate actual/estimated amounts, blended day totals, seed and per-pull costs", () => {
    const data = snapshot();
    const seat = { actualUsd: 0.12, estimatedUsd: 0.04, reservedUsd: 0.16, pulls: 4, eventsFetched: 3 };
    const apify = { actualUsd: 0.15, estimatedUsd: 0, reservedUsd: 0.5, pulls: 1, eventsFetched: 43 };
    data.billing = { etDate: "2026-09-15", sources: { seatdata: seat, apify }, blended: {
      actualUsd: 0.27, estimatedUsd: 0.04, reservedUsd: 0.66, pulls: 5, eventsFetched: 46,
    } };
    data.spend.lastRun!.seed = true;
    data.spend.lastRun!.sources.seatdata.spend = seat;
    data.ledger = [{ id: "pull-1", source: "seatdata", etDate: "2026-09-15", at: "2026-09-15T16:00:00Z",
      actualUsd: 0.04, estimatedUsd: 0, reservedUsd: 0.04,
      details: { gameDate: "2026-10-10", eventsFetched: 1, status: "token=super-secret<script>" } }];
    const html = renderAdminStatusHtml(data);
    expect(html).toContain("Daily spend · 2026-09-15 ET");
    expect(html).toContain("Blended");
    expect(html).toContain("$0.31");
    expect(html).toContain("one-shot seed");
    expect(html).toContain("4 pulls; 3 events");
    expect(html).toContain("Recent pull costs");
    expect(html).not.toContain("super-secret");
    expect(html).not.toMatch(/<(?:script|form|button)\b/i);
    expect(html).toContain('content="noindex,nofollow"');
  });
});
