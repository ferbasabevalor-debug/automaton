/**
 * Daily spend cap (MAX_DAILY_SPEND_USD) tests — financial / policy.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import { createDatabase } from "../state/database.js";
import { inferenceInsertCost } from "../state/database.js";
import { SpendTracker } from "../agent/spend-tracker.js";
import {
  getDailySpendCapCents,
  getDailyTopupCapCents,
  getDailyCapStatus,
  canTopupToday,
  recordTopup,
  createDailySpendCapRule,
  clampTreasuryToDailyCap,
  msUntilNextUtcDay,
  DEFAULT_MAX_DAILY_SPEND_USD,
} from "../agent/daily-spend-cap.js";
import { DEFAULT_TREASURY_POLICY } from "../types.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-cap-"));
  return createDatabase(path.join(dir, "state.db"));
}

function addInferenceCost(db: ReturnType<typeof makeDb>, cents: number) {
  inferenceInsertCost(db.raw, {
    sessionId: "s",
    turnId: null,
    model: "m",
    provider: "openai",
    inputTokens: 1,
    outputTokens: 1,
    costCents: cents,
    latencyMs: 1,
    tier: "normal",
    taskType: "agent_turn",
    cacheHit: false,
  } as any);
}

function request(toolName: string, args: Record<string, unknown>) {
  return { tool: { name: toolName }, args, turnContext: {} } as any;
}

describe("daily spend cap", () => {
  const saved = process.env.MAX_DAILY_SPEND_USD;
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    delete process.env.MAX_DAILY_SPEND_USD;
    db = makeDb();
  });
  afterEach(() => {
    db.close();
    if (saved === undefined) delete process.env.MAX_DAILY_SPEND_USD;
    else process.env.MAX_DAILY_SPEND_USD = saved;
  });

  it("defaults to a low cap and parses MAX_DAILY_SPEND_USD", () => {
    expect(getDailySpendCapCents()).toBe(DEFAULT_MAX_DAILY_SPEND_USD * 100);
    expect(getDailySpendCapCents({ MAX_DAILY_SPEND_USD: "3.5" })).toBe(350);
    expect(getDailySpendCapCents({ MAX_DAILY_SPEND_USD: "1,25" })).toBe(125);
    expect(getDailySpendCapCents({ MAX_DAILY_SPEND_USD: "abc" })).toBe(200);
    expect(getDailySpendCapCents({ MAX_DAILY_SPEND_USD: "-1" })).toBe(200);
    expect(getDailySpendCapCents({ MAX_DAILY_SPEND_USD: "0" })).toBe(0);
  });

  it("top-up allowance is never below the smallest tier", () => {
    expect(getDailyTopupCapCents({ MAX_DAILY_SPEND_USD: "1" })).toBe(500);
    expect(getDailyTopupCapCents({ MAX_DAILY_SPEND_USD: "30" })).toBe(3000);
  });

  it("sums inference and transfers, but not top-ups", () => {
    addInferenceCost(db, 120);
    new SpendTracker(db.raw).recordSpend({ toolName: "transfer_credits", amountCents: 50, category: "transfer" });
    recordTopup(db.raw, "topup_credits", 500);
    const status = getDailyCapStatus(db.raw);
    expect(status.spentCents).toBe(170);
    expect(status.exceeded).toBe(false);
    addInferenceCost(db, 30);
    expect(getDailyCapStatus(db.raw).exceeded).toBe(true);
  });

  it("policy rule denies spending tools once the cap is reached", () => {
    const rule = createDailySpendCapRule(db.raw);
    expect(rule.evaluate(request("transfer_credits", { amount_cents: 100 }))).toBeNull();
    expect(rule.evaluate(request("transfer_credits", { amount_cents: 250 }))?.action).toBe("deny");
    addInferenceCost(db, 200);
    expect(rule.evaluate(request("x402_fetch", { url: "https://conway.tech" }))?.action).toBe("deny");
    expect(rule.evaluate(request("create_sandbox", {}))?.action).toBe("deny");
  });

  it("policy rule limits top-ups per day", () => {
    const rule = createDailySpendCapRule(db.raw);
    expect(rule.evaluate(request("topup_credits", { amount_usd: 5 }))).toBeNull();
    expect(rule.evaluate(request("topup_credits", { amount_usd: 25 }))?.action).toBe("deny");
    recordTopup(db.raw, "bootstrap_topup", 500);
    expect(canTopupToday(db.raw, 500).allowed).toBe(false);
    expect(rule.evaluate(request("topup_credits", { amount_usd: 5 }))?.action).toBe("deny");
  });

  it("clamps treasury limits down to the cap, never up", () => {
    const clamped = clampTreasuryToDailyCap(DEFAULT_TREASURY_POLICY, 200);
    expect(clamped.maxInferenceDailyCents).toBe(200);
    expect(clamped.maxDailyTransferCents).toBe(200);
    expect(clamped.maxSingleTransferCents).toBe(200);
    expect(clamped.maxX402PaymentCents).toBe(DEFAULT_TREASURY_POLICY.maxX402PaymentCents);
    const big = clampTreasuryToDailyCap(DEFAULT_TREASURY_POLICY, 10_000_000);
    expect(big).toEqual(DEFAULT_TREASURY_POLICY);
  });

  it("computes time until the UTC reset", () => {
    expect(msUntilNextUtcDay(new Date("2026-01-01T23:00:00Z"))).toBe(3_600_000);
  });
});
