import type { Game } from "@shared/book";
import { roundMoney, vsSeason } from "@shared/book";

export type ScenarioChoice = "Sit" | "Sell";
export type ScenarioMap = Record<string, ScenarioChoice>;

export const SCENARIO_STORAGE_KEY = "wizards-107p-scenario";

export function parseScenario(raw: unknown): ScenarioMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const next: ScenarioMap = {};
  for (const [date, value] of Object.entries(raw)) {
    if (value === "Sit" || value === "Sell") next[date] = value;
  }
  return next;
}

export function readScenario(): ScenarioMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(SCENARIO_STORAGE_KEY);
    if (!raw) return {};
    return parseScenario(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

export function writeScenario(scenario: ScenarioMap): void {
  window.localStorage.setItem(SCENARIO_STORAGE_KEY, JSON.stringify(scenario));
}

export function scenarioChoice(game: Game, scenario: ScenarioMap): string {
  const override = scenario[game.date];
  if (override === "Sit" || override === "Sell") return override;
  return game.sit_or_sell;
}

export function withScenarioChoice(
  games: readonly Game[],
  scenario: ScenarioMap,
  date: string,
  choice: ScenarioChoice,
): ScenarioMap {
  const game = games.find((item) => item.date === date);
  const next = { ...scenario };
  if (!game || game.sit_or_sell === choice) {
    delete next[date];
  } else {
    next[date] = choice;
  }
  return next;
}

export type ScenarioSummary = {
  sellCash: number;
  vsSeason: number;
  sellCount: number;
  sitCount: number;
  tbdCount: number;
};

export function scenarioSummary(
  games: readonly Game[],
  scenario: ScenarioMap,
  seasonCost: number,
): ScenarioSummary {
  let sellCash = 0;
  let sellCount = 0;
  let sitCount = 0;
  let tbdCount = 0;
  for (const game of games) {
    const decision = scenarioChoice(game, scenario);
    if (decision === "Sell") {
      sellCount += 1;
      if (game.cash_both_after_fee != null && !Number.isNaN(game.cash_both_after_fee)) {
        sellCash += game.cash_both_after_fee;
      }
    } else if (decision === "Sit") {
      sitCount += 1;
    } else {
      tbdCount += 1;
    }
  }
  const cash = roundMoney(sellCash);
  return {
    sellCash: cash,
    vsSeason: vsSeason(cash, seasonCost),
    sellCount,
    sitCount,
    tbdCount,
  };
}
