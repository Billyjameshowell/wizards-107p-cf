import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STEPS, isStep, stepForCron } from "../worker/schedule";

describe("daily job steps", () => {
  it("maps each configured cron to one step, in order", () => {
    const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    const crons = [...config.matchAll(/"(\d+ \d+ \* \* \*)"/g)].map((m) => m[1] ?? "");
    expect(crons.map(stepForCron)).toEqual([...STEPS]);
  });

  it("picks the step by minute, so a different hour runs the same chain", () => {
    expect(stepForCron("10 20 * * *")).toBe("refit");
    expect(stepForCron("5 12 * * *")).toBeNull();
    expect(isStep("grid")).toBe(true);
    expect(isStep("all")).toBe(false);
  });
});
