import { describe, it, expect, vi, afterEach } from "vitest";
import {
  COLD_START_HEADROOM_MS,
  NETLIFY_FUNCTION_LIMIT_MS,
  NOTIFY_TIMEOUT_MS,
  RESPONSE_HEADROOM_MS,
  RUN_DEADLINE_MS,
  NO_TIME_LEFT_MESSAGE,
  runWithinNotifyBudget,
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

  describe("runWithinNotifyBudget", () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("runs the call and logs nothing while time is left", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const call = vi.fn().mockResolvedValue(undefined);

      await runWithinNotifyBudget({
        runStartedAt: Date.now(),
        failedLogPrefix: "test-failed",
        label: "test call",
        call,
      });

      expect(call).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it("skips the call and logs under the given prefix once the deadline has passed", async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const call = vi.fn().mockResolvedValue(undefined);
      const runStartedAt = Date.now();
      vi.setSystemTime(runStartedAt + RUN_DEADLINE_MS);

      await runWithinNotifyBudget({
        runStartedAt,
        failedLogPrefix: "test-failed",
        label: "test call",
        call,
      });

      expect(call).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "test-failed",
        JSON.stringify({ message: NO_TIME_LEFT_MESSAGE }),
      );
    });

    it("swallows and logs a rejected call", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const call = vi.fn().mockRejectedValue(new Error("github down"));

      await expect(
        runWithinNotifyBudget({
          runStartedAt: Date.now(),
          failedLogPrefix: "test-failed",
          label: "test call",
          call,
        }),
      ).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith(
        "test-failed",
        JSON.stringify({ message: "github down" }),
      );
    });

    it("swallows and logs a call that throws synchronously", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const call = vi.fn(() => {
        throw new Error("missing token");
      });

      await expect(
        runWithinNotifyBudget({
          runStartedAt: Date.now(),
          failedLogPrefix: "test-failed",
          label: "test call",
          call,
        }),
      ).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith(
        "test-failed",
        JSON.stringify({ message: "missing token" }),
      );
    });

    it("gives up on a hanging call at the remaining budget", async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const call = vi.fn(() => new Promise<never>(() => {}));
      let settled = false;
      const promise = runWithinNotifyBudget({
        runStartedAt: Date.now(),
        failedLogPrefix: "test-failed",
        label: "test call",
        call,
      }).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(NOTIFY_TIMEOUT_MS - 1);
      expect(call).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await promise;

      expect(warn.mock.calls[0][0]).toBe("test-failed");
      expect(JSON.parse(warn.mock.calls[0][1] as string).message).toMatch(
        /exceeded/,
      );
    });
  });
});
