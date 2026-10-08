import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bookPullInstants, ingestStatusWarnings, latestInstant } from "@shared/ingest-status";
import { authorizeAdmin, isPricedHomePull, renderAdminStatusPage } from "../worker/admin-status";

const NOW = new Date("2026-10-08T16:00:00.000Z");

describe("admin ingest warnings", () => {
  it("warns when ingest is off, when dry run is on, and when the last pull is older than 3 days", () => {
    expect(
      ingestStatusWarnings({
        ingestEnabled: false,
        dryRun: false,
        lastPullAt: "2026-10-07T16:00:00.000Z",
        now: NOW,
      }).join(" "),
    ).toContain("Ingest is off");

    expect(
      ingestStatusWarnings({
        ingestEnabled: true,
        dryRun: true,
        lastPullAt: "2026-10-07T16:00:00.000Z",
        now: NOW,
      }).join(" "),
    ).toContain("Dry run is on");

    const stale = ingestStatusWarnings({
      ingestEnabled: true,
      dryRun: false,
      lastPullAt: "2026-09-22T17:41:00.000Z",
      now: NOW,
    });
    expect(stale).toEqual(["Last successful pull was 15 days ago."]);
  });

  it("stays quiet for a pull exactly 3 days old and when nothing is wrong", () => {
    expect(
      ingestStatusWarnings({
        ingestEnabled: true,
        dryRun: false,
        lastPullAt: new Date(NOW.getTime() - 3 * 86_400_000).toISOString(),
        now: NOW,
      }),
    ).toEqual([]);

    expect(
      ingestStatusWarnings({
        ingestEnabled: true,
        dryRun: false,
        lastPullAt: new Date(NOW.getTime() - 3 * 86_400_000 - 60_000).toISOString(),
        now: NOW,
      }),
    ).toEqual(["Last successful pull was 3 days ago."]);
  });

  it("reads the book stamp and renders the warning only on the admin page", () => {
    const last = latestInstant([
      ...bookPullInstants({
        asof_et: "2026-09-22 1:41pm",
        games: [{ date: "2026-10-21", market_updated_at_et: "2026-09-22 1:40pm" }],
      }),
      "2026-09-19T12:12:41Z",
    ]);
    expect(last).toBe("2026-09-22T17:41:00.000Z");
    const html = renderAdminStatusPage({
      warnings: ingestStatusWarnings({
        ingestEnabled: true,
        dryRun: false,
        lastPullAt: last,
        now: NOW,
      }),
      ingestEnabled: true,
      dryRun: false,
      lastPullAt: last,
      lastAttemptAt: "2026-10-08T19:46:23.751Z",
      seatdataKey: true,
      apifyToken: false,
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("15 days ago");
    expect(html).toContain("Last successful pull");
    expect(html).toContain("home-game prices landed");
    expect(html).toContain("Last attempt");
    expect(html).toContain("3:46pm");
    expect(html).toContain("Apify token</dt><dd>missing");
    expect(html).toContain("noindex,nofollow");
    expect(html).toContain("No saved fit yet");
  });

  it("shows the median miss on the next price check", () => {
    const html = renderAdminStatusPage({
      warnings: [],
      ingestEnabled: true,
      dryRun: false,
      lastPullAt: "2026-10-08T12:00:00.000Z",
      seatdataKey: true,
      apifyToken: true,
      model: {
        fittedAt: "2026-10-08T12:00:00.000Z",
        rows: 140,
        early: true,
        holdoutMedianAbsPercent: 6.5,
      },
    });
    expect(html).toContain("Next-check error");
    expect(html).toContain("6.5% median miss on the next price check");
    expect(html).toContain("early estimate");
    expect(html).toContain("140 cleaned checks");
  });
});

describe("admin sign-in", () => {
  it("accepts the cron bearer and HTTP basic password, and rejects a missing secret", () => {
    expect(authorizeAdmin("Bearer night-bell", "night-bell")).toBe(true);
    expect(authorizeAdmin(`Basic ${btoa("admin:night-bell")}`, "night-bell")).toBe(true);
    expect(authorizeAdmin(`Basic ${btoa("admin:nope")}`, "night-bell")).toBe(false);
    expect(authorizeAdmin("Bearer night-bell", "")).toBe(false);
  });
});

describe("production wrangler vars", () => {
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

  it("ships ingest on and dry run off, and does not raise caps", () => {
    expect(config).toContain('"INGEST_ENABLED": "true"');
    expect(config).toContain('"DRY_RUN": "false"');
    expect(config).not.toContain('"INGEST_ENABLED": "false"');
    expect(config).not.toContain('"DRY_RUN": "true"');
    expect(config).toContain('"SEATDATA_MAX_PULLS_PER_RUN": "20"');
    expect(config).toContain('"SEATDATA_MAX_PULLS_PER_ET_DAY": "25"');
    expect(config).not.toContain("SEATDATA_FETCH_SALES");
    expect(config).toContain('"APIFY_MAX_TOTAL_CHARGE_USD": "0.50"');
    expect(config).toContain('"APIFY_MAX_EVENTS": "50"');
    expect(config).toContain('"APIFY_INCLUDE_LISTINGS": "false"');
    expect(config).toContain('"SEATDATA_BASE_URL": "https://seatdata.io"');
    expect(config).not.toContain("api.seatdata.io");
    expect(config).toContain('"bucket_name": "wizards-107p-archive"');
    expect(config).toContain('"crons": ["0 12 * * *"]');
  });
});


describe("priced home pull helper", () => {
  it("counts only ok game rows with listings or a price, not empty archive shells", () => {
    expect(
      isPricedHomePull({
        game_date: null,
        status: "ok",
        listing_count: 0,
        median: null,
        get_in: null,
      }),
    ).toBe(false);
    expect(
      isPricedHomePull({
        game_date: "2026-10-21",
        status: "ok",
        listing_count: 12,
        median: 40,
        get_in: null,
      }),
    ).toBe(true);
    expect(
      isPricedHomePull({
        game_date: "2026-10-21",
        status: "ok",
        listing_count: null,
        median: null,
        get_in: 18,
      }),
    ).toBe(true);
    expect(
      isPricedHomePull({
        game_date: "2026-10-21",
        status: "empty",
        listing_count: 0,
        median: null,
        get_in: null,
      }),
    ).toBe(false);
  });
});
