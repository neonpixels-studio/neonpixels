import { describe, it, expect } from "vitest";
import {
  COLD_START_HEADROOM_MS,
  NETLIFY_FUNCTION_LIMIT_MS,
  NOTIFY_TIMEOUT_MS,
  RESPONSE_HEADROOM_MS,
  RUN_DEADLINE_MS,
  remainingNotifyBudgetMs,
} from "../../../netlify/functions/lib/notifyBudget";

const NETLIFY_REAL_LIMIT_MS = 30000;

describe("notifyBudget", () => {
  it("keeps the run deadline within Netlify's real limit with cold-start headroom", () => {
    expect(NETLIFY_FUNCTION_LIMIT_MS).toBe(NETLIFY_REAL_LIMIT_MS);
    expect(COLD_START_HEADROOM_MS).toBeGreaterThanOrEqual(2000);
    expect(RUN_DEADLINE_MS + COLD_START_HEADROOM_MS).toBeLessThanOrEqual(
      NETLIFY_REAL_LIMIT_MS,
    );
  });

  it("gives the notifier its full budget when the run failed immediately", () => {
    expect(remainingNotifyBudgetMs(0)).toBe(NOTIFY_TIMEOUT_MS);
  });

  it("shrinks to what is left of the deadline minus response headroom", () => {
    const elapsedMs = RUN_DEADLINE_MS - RESPONSE_HEADROOM_MS - 1200;
    expect(remainingNotifyBudgetMs(elapsedMs)).toBe(1200);
  });

  it("never exceeds the deadline when added to elapsed time and headroom", () => {
    const elapsedMs = RUN_DEADLINE_MS - NOTIFY_TIMEOUT_MS + 1;
    const budgetMs = remainingNotifyBudgetMs(elapsedMs);
    expect(elapsedMs + budgetMs + RESPONSE_HEADROOM_MS).toBeLessThanOrEqual(
      RUN_DEADLINE_MS,
    );
  });

  it("returns zero, never negative, once the deadline has passed", () => {
    expect(remainingNotifyBudgetMs(RUN_DEADLINE_MS)).toBe(0);
    expect(remainingNotifyBudgetMs(NETLIFY_FUNCTION_LIMIT_MS * 2)).toBe(0);
  });
});
