// Looking in on something that takes days.
//
// The corpus has a four-to-six week sauerkraut, a three-day brine and a twenty-four hour marinade. A
// session that survives days already works — it is a ledger, not a process — but nothing in it ever
// says "go and look at the cabbage", and a single alarm six weeks out would be useless. The whole
// skill of a ferment is what you do on the way through it.
//
// Two things this refuses to do.
//
// It does not work out a cadence. How often to look at a ferment is culinary knowledge, and deriving
// "every three days" from a duration would be arithmetic wearing an expert's coat. The cadence and
// the things to look at are curated, per step, by a person.
//
// It does not read the step's text to decide what kind of step it is. The corpus's steps carry no
// technique field, and guessing "this looks like a ferment" from the words is exactly the inference
// this project is arranged against. Rows are keyed on the recipe and the step number, which does not
// generalise — and that is honest: a new long step gets no check-ins until somebody writes them, and
// the validator says which steps are waiting.
//
// The schedule itself is **derived from the clock and never stored**, for the same reason `stale` is:
// a stored copy gives the system two answers to one question.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { dataDir } from "../recipes.ts";

export type LongStepPlan = {
  recipe_id: string;
  step: number;
  /** What sort of waiting this is. Curated, never read out of the step's text. */
  kind: string;
  /** Seconds from the start of the step to the first look. Null with `check_every_s` null means a
   *  person decided there is nothing to check. */
  first_check_s: number | null;
  check_every_s: number | null;
  /** What to actually look at, in a person's words. The valuable half of the row. */
  look_for: string[];
  note: string;
};

export type LongSteps = {
  version: number;
  updated_on: string;
  author: string;
  note: string;
  entries: LongStepPlan[];
};

export function loadLongSteps(file?: string): LongSteps {
  return JSON.parse(readFileSync(file ?? join(dataDir(), "long_steps.json"), "utf8")) as LongSteps;
}

export function keyOf(recipeId: string, step: number): string {
  return `${recipeId}:${step}`;
}

export function indexLongSteps(table: LongSteps): Map<string, LongStepPlan> {
  return new Map(table.entries.map((e) => [keyOf(e.recipe_id, e.step), e]));
}

/** A step this long deserves a plan. Also what the validator measures coverage against. */
export const LONG_STEP_S = 3600;

/** Nothing sensible comes of a schedule with thousands of entries; a row that would produce one is a
 *  mistake in the table rather than a demanding recipe. The list says when it was cut short. */
const MAX_CHECKS = 200;

export type CheckIn = {
  /** 1-based, so "the third look" means something to say out loud. */
  index: number;
  at: string;
  state: "done" | "due" | "upcoming";
};

export type CheckSchedule =
  /** A person decided there is nothing to look at, and said why. */
  | { kind: "nothing_to_check"; plan: LongStepPlan; checks: [] }
  /** Nobody has written a plan for this step. Not the same thing, and never conflated with it. */
  | { kind: "no_plan"; plan: null; checks: [] }
  | {
      kind: "scheduled";
      plan: LongStepPlan;
      checks: CheckIn[];
      /** The looks that have come due and not been answered. Empty when up to date. */
      overdue: CheckIn[];
      /** The next one, due or not. Null when the step is over and nothing is outstanding. */
      next: CheckIn | null;
      truncated: boolean;
    };

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * When to look, and which of those looks have already happened.
 *
 * `lastCheckedAt` is the most recent time the person actually looked. Everything scheduled up to
 * that moment counts as done — if you looked at hour five, you looked at it, and the two slots you
 * slept through are not outstanding work. Nagging about a look that is no longer actionable is how a
 * reminder gets ignored altogether.
 */
export function scheduleFor(
  plan: LongStepPlan | undefined,
  startedAt: string,
  durationS: number,
  now: string,
  lastCheckedAt: string | null,
): CheckSchedule {
  if (!plan) return { kind: "no_plan", plan: null, checks: [] };
  if (plan.first_check_s === null && plan.check_every_s === null) {
    return { kind: "nothing_to_check", plan, checks: [] };
  }

  const start = Date.parse(startedAt);
  const at = Date.parse(now);
  const checked = lastCheckedAt ? Date.parse(lastCheckedAt) : null;
  if (Number.isNaN(start) || Number.isNaN(at)) throw new RangeError("not an ISO timestamp");

  const first = plan.first_check_s ?? plan.check_every_s ?? 0;
  const every = plan.check_every_s;
  const checks: CheckIn[] = [];
  let truncated = false;

  for (let offset = first, i = 1; offset < durationS; i++) {
    if (checks.length >= MAX_CHECKS) {
      truncated = true;
      break;
    }
    const when = start + offset * 1000;
    checks.push({
      index: i,
      at: iso(when),
      // Order matters: done beats due, because a look that has happened is not outstanding however
      // long ago it came due.
      state: checked !== null && when <= checked ? "done" : when <= at ? "due" : "upcoming",
    });
    if (!every) break;
    offset += every;
  }

  const overdue = checks.filter((c) => c.state === "due");
  const next = overdue[0] ?? checks.find((c) => c.state === "upcoming") ?? null;
  return { kind: "scheduled", plan, checks, overdue, next, truncated };
}

function spell(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} seconds`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m} minutes`;
  const h = Math.round(seconds / 3600);
  if (h < 48) return `${h} hours`;
  return `${Math.round(seconds / 86_400)} days`;
}

/**
 * What to say about a long step.
 *
 * The sentence has to carry the one thing this server cannot do, which is ring. It answers when
 * asked and nothing more, so it says when the next look is due rather than implying it will tell
 * you — see docs/BLOCKED.md.
 */
export function checkSentence(schedule: CheckSchedule, now: string): string | null {
  if (schedule.kind === "no_plan") return null;
  if (schedule.kind === "nothing_to_check") {
    return `Nothing to check on this one: ${schedule.plan.note.replace(/^[A-Z]/, (c) => c.toLowerCase())}`;
  }

  const { plan, overdue, next } = schedule;
  if (overdue.length) {
    // How far behind, not how many slots passed. Somebody who missed four looks catches up with one,
    // and "four looks are due" asks them for four things they cannot do.
    const behind = Math.round((Date.parse(now) - Date.parse(overdue[0].at)) / 1000);
    const late = overdue.length === 1
      ? "A look is due on this."
      : `A look is overdue on this — the plan wanted one ${spell(behind)} ago.`;
    return `${late} ${plan.look_for.join(" ")} Tell me when you have, and I will stop asking.`;
  }
  if (!next) return "That one is done waiting as far as the clock goes.";

  const away = Math.round((Date.parse(next.at) - Date.parse(now)) / 1000);
  return `Next look in about ${spell(away)}. When you get to it: ${plan.look_for.join(" ")}`;
}
