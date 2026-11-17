/**
 * Daily Spend Cap
 *
 * A single, global, operator-controlled limit on how much money the
 * automaton may spend per UTC day. Configured with the MAX_DAILY_SPEND_USD
 * environment variable (default: $2.00/day).
 *
 * What counts as "spend" (all summed together against the cap):
 *   - inference costs (recorded in the inference_costs table)
 *   - credit transfers, child funding, x402 payments, domain purchases
 *     (recorded in the spend_tracking table)
 *
 * Credit top-ups (USDC -> the automaton's own Conway credits) are not
 * "spending" — the money stays with the agent — but they are limited
 * separately so the wallet cannot be drained into credits in one go:
 * at most max(cap, smallest top-up tier) of USDC may be converted per day.
 *
 * The cap is read from the environment on every check, so changing the
 * variable in the hosting dashboard and restarting takes effect immediately.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { PolicyRule, PolicyRequest, PolicyRuleResult, TreasuryPolicy } from "../types.js";
import { inferenceGetDailyCost } from "../state/database.js";

type Database = BetterSqlite3.Database;

/** Default daily cap in USD when MAX_DAILY_SPEND_USD is not set. Deliberately low. */
export const DEFAULT_MAX_DAILY_SPEND_USD = 2;

/** Smallest Conway top-up tier (USD). Kept in sync with TOPUP_TIERS[0]. */
export const MIN_TOPUP_TIER_USD = 5;

/** Tool names whose spend_tracking rows are top-ups (not consumption). */
export const TOPUP_TOOL_NAMES = ["topup_credits", "bootstrap_topup"];

/** Tools that can move or consume money and are therefore gated by the cap. */
export const SPENDING_TOOL_NAMES = [
  "transfer_credits",
  "fund_child",
  "x402_fetch",
  "register_domain",
  "create_sandbox",
  "spawn_child",
];

/**
 * Daily cap in cents, read from MAX_DAILY_SPEND_USD.
 * Invalid or negative values fall back to the default.
 */
export function getDailySpendCapCents(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MAX_DAILY_SPEND_USD?.trim();
  if (!raw) return Math.round(DEFAULT_MAX_DAILY_SPEND_USD * 100);
  const usd = Number(raw.replace(",", "."));
  if (!Number.isFinite(usd) || usd < 0) {
    return Math.round(DEFAULT_MAX_DAILY_SPEND_USD * 100);
  }
  return Math.round(usd * 100);
}

/** Daily top-up allowance in cents: max(cap, smallest top-up tier). */
export function getDailyTopupCapCents(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(getDailySpendCapCents(env), MIN_TOPUP_TIER_USD * 100);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function safeGet<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Total spent today (cents): inference + non-top-up money movements. */
export function getTodaySpendCents(db: Database): number {
  const inference = safeGet(() => inferenceGetDailyCost(db), 0);
  const placeholders = TOPUP_TOOL_NAMES.map(() => "?").join(",");
  const other = safeGet(
    () =>
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM spend_tracking
             WHERE window_day = ? AND category != 'inference' AND tool_name NOT IN (${placeholders})`,
          )
          .get(today(), ...TOPUP_TOOL_NAMES) as { total: number }
      ).total,
    0,
  );
  return inference + other;
}

/** Total USDC converted into credits today (cents). */
export function getTodayTopupCents(db: Database): number {
  const placeholders = TOPUP_TOOL_NAMES.map(() => "?").join(",");
  return safeGet(
    () =>
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM spend_tracking
             WHERE window_day = ? AND tool_name IN (${placeholders})`,
          )
          .get(today(), ...TOPUP_TOOL_NAMES) as { total: number }
      ).total,
    0,
  );
}

export interface DailyCapStatus {
  capCents: number;
  spentCents: number;
  remainingCents: number;
  exceeded: boolean;
}

export function getDailyCapStatus(db: Database): DailyCapStatus {
  const capCents = getDailySpendCapCents();
  const spentCents = getTodaySpendCents(db);
  return {
    capCents,
    spentCents,
    remainingCents: Math.max(capCents - spentCents, 0),
    exceeded: spentCents >= capCents,
  };
}

/** Can a top-up of `amountCents` happen today without exceeding the top-up allowance? */
export function canTopupToday(db: Database, amountCents: number): { allowed: boolean; reason?: string } {
  const limit = getDailyTopupCapCents();
  const done = getTodayTopupCents(db);
  if (done + amountCents > limit) {
    return {
      allowed: false,
      reason: `Daily top-up limit reached: $${(done / 100).toFixed(2)} already converted today + $${(amountCents / 100).toFixed(2)} > $${(limit / 100).toFixed(2)} (set by MAX_DAILY_SPEND_USD)`,
    };
  }
  return { allowed: true };
}

/** Record a top-up so it counts against the daily top-up allowance. */
export function recordTopup(db: Database, toolName: string, amountCents: number): void {
  const now = new Date().toISOString();
  safeGet(() => {
    db.prepare(
      `INSERT INTO spend_tracking (id, tool_name, amount_cents, recipient, domain, category, window_hour, window_day)
       VALUES (?, ?, ?, NULL, NULL, 'other', ?, ?)`,
    ).run(
      `topup-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      toolName,
      Math.round(amountCents),
      now.slice(0, 13),
      now.slice(0, 10),
    );
    return true;
  }, false);
}

/**
 * Clamp every per-day / per-transfer limit so none can exceed the global
 * daily cap. Never raises a limit — only lowers it.
 */
export function clampTreasuryToDailyCap(policy: TreasuryPolicy, capCents: number): TreasuryPolicy {
  return {
    ...policy,
    maxSingleTransferCents: Math.min(policy.maxSingleTransferCents, capCents),
    maxHourlyTransferCents: Math.min(policy.maxHourlyTransferCents, capCents),
    maxDailyTransferCents: Math.min(policy.maxDailyTransferCents, capCents),
    maxInferenceDailyCents: Math.min(policy.maxInferenceDailyCents, capCents),
    maxX402PaymentCents: Math.min(policy.maxX402PaymentCents, capCents),
    requireConfirmationAboveCents: Math.min(policy.requireConfirmationAboveCents, capCents),
  };
}

/** Milliseconds until the next UTC midnight (when the daily cap resets). */
export function msUntilNextUtcDay(now: Date = new Date()): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime() - now.getTime();
}

function deny(reasonCode: string, humanMessage: string): PolicyRuleResult {
  return { rule: "financial.daily_spend_cap", action: "deny", reasonCode, humanMessage };
}

/**
 * Policy rule enforcing the global daily cap on every money-moving tool,
 * plus the separate daily top-up allowance on topup_credits.
 */
export function createDailySpendCapRule(db: Database): PolicyRule {
  return {
    id: "financial.daily_spend_cap",
    description: "Deny spending once MAX_DAILY_SPEND_USD has been reached for the day",
    priority: 450,
    appliesTo: { by: "name", names: [...SPENDING_TOOL_NAMES, "topup_credits"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      if (request.tool.name === "topup_credits") {
        const amountUsd = Number(request.args.amount_usd);
        if (!Number.isFinite(amountUsd) || amountUsd <= 0) return null;
        const check = canTopupToday(db, amountUsd * 100);
        return check.allowed ? null : deny("DAILY_TOPUP_CAP", check.reason!);
      }

      const status = getDailyCapStatus(db);
      if (status.exceeded) {
        return deny(
          "DAILY_SPEND_CAP",
          `Daily spend cap reached: $${(status.spentCents / 100).toFixed(2)} spent of $${(status.capCents / 100).toFixed(2)} (MAX_DAILY_SPEND_USD). Resets at 00:00 UTC.`,
        );
      }

      const amount = Number(request.args.amount_cents);
      if (Number.isFinite(amount) && amount > 0 && status.spentCents + amount > status.capCents) {
        return deny(
          "DAILY_SPEND_CAP",
          `This would exceed the daily spend cap: $${(status.spentCents / 100).toFixed(2)} + $${(amount / 100).toFixed(2)} > $${(status.capCents / 100).toFixed(2)} (MAX_DAILY_SPEND_USD).`,
        );
      }

      return null;
    },
  };
}
