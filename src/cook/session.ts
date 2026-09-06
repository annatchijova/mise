// Cooking as a state machine, not as a text being read aloud.
//
// This is the file the demo's best thirty seconds rests on: "pause" — a day later, on another
// device — "where was I?", and the answer is step 5 with the timer where it stopped. That only works
// if the session is a record of transitions rather than a cursor. Everything here is pure: a
// session and an event in, a new session out, no clock read and no store touched. The clock arrives
// as `now` so that a test can run a two-hour braise in a microsecond and get the same answers.
//
// Three rules the rest of the system leans on:
//
//   1. **A deviation is not an error.** Saying "I already did the onions" when the system expected
//      step 2 breaks nothing: it is recorded, the step is marked done, and the deduction on close
//      honours it. A cook is allowed to cook.
//   2. **Time is derived, never stored.** A timer keeps its start, the seconds it spent paused, and
//      nothing else. Remaining time is computed from `now` at the moment somebody asks, so a session
//      that sat closed for a day comes back with the truth rather than with a stale number.
//   3. **The deduction says what it does not know.** An ingredient the recipe never quantified is
//      consumed as "some, amount unknown", which is exactly what the pantry fold does with it. An
//      ingredient measured "to taste" is not deducted at all, and the reason is reported.
//   4. **The current step is derived, never stored.** It is the lowest-numbered step this cook has
//      not done whose dependencies are all met — a fact about `completed_steps` and the recipe's
//      graph. Storing it as well would give the session two answers to the same question, and with
//      two people cooking there is no single answer to store anyway.
import type { Recipe, Step } from "../recipes.ts";
import { type PantryEvent, type Unit, canonicalAmount, toMilli } from "../pantry/events.ts";
import { LINEAR, type Scaling, scaleDamped } from "./scaling.ts";

export type SessionState = "mise_en_place" | "cooking" | "paused" | "finished" | "abandoned";

/** A timer is a start and an accumulated pause, never a countdown. See rule 2. */
export type Timer = {
  step: number;
  label: string;
  duration_s: number;
  started_at: string;
  /** Seconds already spent paused, closed out each time the session resumes. */
  paused_s: number;
  /** When the current pause began; null while running. */
  paused_at: string | null;
  /** When the step it belongs to was completed, or the timer was stopped. */
  stopped_at: string | null;
};

export type TimerView = {
  step: number;
  label: string;
  duration_s: number;
  elapsed_s: number;
  /** Negative once the timer is past its duration; `overdue_s` says by how much. */
  remaining_s: number;
  overdue_s: number;
  state: "running" | "paused" | "done" | "stopped";
};

export type DeviationKind = "out_of_order" | "substitution" | "note";

export type Deviation = {
  at: string;
  /** The step the system believed we were on when this was said. */
  step: number;
  kind: DeviationKind;
  what: string;
};

/** A swap the person actually made, as opposed to one the table merely suggested. */
export type Substitution = { at: string; step: number; instead_of: string; used: string };

export type Transition = {
  at: string;
  from: SessionState;
  to: SessionState;
  action: string;
  /** What the person said, verbatim, when they said anything. */
  input: string | null;
  expected_step: number | null;
  actual_step: number | null;
  /** Which step this call actually marked done — the one the hint named, when it named one, and the
   *  current one otherwise. Recorded rather than inferred, because "was that step ticked off twice?"
   *  is a question only the log can answer, and only if the log wrote it down. Absent on a session
   *  saved before this field existed. */
  completed_step?: number | null;
  /** Which cook this was. Also what tells us whether a given cook has started at all: their first
   *  `cook_next` completes nothing, because they were gathering rather than cooking. Without it the
   *  second person's first word would tick off a step they had never been given. */
  cook?: number;
};

export type Track = { cook: number; current_step: number; waiting_for: number[] };

/** Somebody looked in on a long step. */
export type Check = {
  at: string;
  step: number;
  /** What they saw, when they said. Kept verbatim. */
  note: string | null;
};

export type CookSession = {
  id: string;
  user_id: string;
  recipe_id: string;
  servings: number;
  state: SessionState;
  /** How many people are cooking. 1 unless somebody said otherwise. */
  cooks: number;
  /** Step order to cook, from the scheduler. Empty when one person is doing all of it. */
  assignments: Record<number, number>;
  started_at: string;
  updated_at: string;
  completed_steps: number[];
  timers: Timer[];
  deviations: Deviation[];
  substitutions: Substitution[];
  /** Times somebody actually looked in on a long step. Stored, because a look is a thing that
   *  happened; the schedule it answers stays derived from the clock. Absent on a session saved
   *  before this field existed. */
  checks?: Check[];
  log: Transition[];
};

// --- helpers --------------------------------------------------------------------------------

function seconds(from: string, to: string): number {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) throw new RangeError(`not an ISO timestamp: ${from} / ${to}`);
  return Math.floor((b - a) / 1000);
}

function stepOf(recipe: Recipe, order: number): Step | undefined {
  return recipe.steps.find((s) => s.order === order);
}

/** Steps in the order the recipe gives them, defensively sorted: a hand-edited file can be out of order. */
export function orderedSteps(recipe: Recipe): Step[] {
  return [...recipe.steps].sort((a, b) => a.order - b.order);
}

function lastStep(recipe: Recipe): number {
  return orderedSteps(recipe).at(-1)?.order ?? 0;
}

/** Whose step this is. Unassigned steps belong to everybody, which is the single-cook case. */
function belongsTo(s: CookSession, order: number, cook: number): boolean {
  const owner = s.assignments[order];
  return owner === undefined || owner === cook;
}

/**
 * What this cook is on, worked out rather than remembered.
 *
 * The lowest-numbered step they have not done whose dependencies are all complete. `waiting_for`
 * names the steps standing in their way when there is work left for them but none of it can start —
 * which with two people is the whole point: "nothing for you until the beans are on".
 */
export function currentStepFor(s: CookSession, recipe: Recipe, cook = 1): Track {
  const steps = orderedSteps(recipe);
  const mine = steps.filter((st) => !s.completed_steps.includes(st.order) && belongsTo(s, st.order, cook));
  const ready = mine.find((st) => st.depends_on.every((d) => s.completed_steps.includes(d) || !steps.some((x) => x.order === d)));
  if (ready) return { cook, current_step: ready.order, waiting_for: [] };
  // Only what stands in the way of the step they would do *next*. Listing every dependency of
  // everything left is technically true and useless: nobody is waiting on four things at once, they
  // are waiting on the first one.
  const blocking = mine.length === 0
    ? []
    : mine[0].depends_on.filter((d) => !s.completed_steps.includes(d)).sort((a, b) => a - b);
  return { cook, current_step: 0, waiting_for: blocking };
}

/** Every cook's track, in order. */
export function tracksOf(s: CookSession, recipe: Recipe): Track[] {
  return Array.from({ length: Math.max(1, s.cooks) }, (_, i) => currentStepFor(s, recipe, i + 1));
}

/** True once nobody has anything left to do. */
export function allDone(s: CookSession, recipe: Recipe): boolean {
  return orderedSteps(recipe).every((st) => s.completed_steps.includes(st.order));
}

/** A session is a value. Every operation returns a new one, arrays included — sharing an array
 *  with the stored session is how a "pure" state machine quietly starts mutating the store. */
function clone(s: CookSession): CookSession {
  return {
    ...s,
    completed_steps: [...s.completed_steps],
    timers: s.timers.map((t) => ({ ...t })),
    deviations: [...s.deviations],
    substitutions: [...s.substitutions],
    log: [...s.log],
  };
}

function transition(
  s: CookSession, to: SessionState, action: string, at: string,
  input: string | null, expected: number | null, actual: number | null,
  completed: number | null = null, cook: number | undefined = undefined,
): Transition {
  return { at, from: s.state, to, action, input, expected_step: expected, actual_step: actual, completed_step: completed, cook };
}

/** Has this cook done anything yet? Their first `cook_next` is them leaving the mise en place, and
 *  it completes nothing — which with two people cannot be a property of the session, because one of
 *  them may have been cooking for ten minutes when the other picks up a knife. */
function hasStarted(s: CookSession, cook: number): boolean {
  return s.log.some((t) => t.action === "cook_next" && (t.cook ?? 1) === cook);
}

/** Scale an amount by servings/serves in integers. Milli-units in, milli-units out, so a doubled
 *  recipe never introduces a float the ledger would have to round back. */
export function scaleMilli(milli: number, servings: number, serves: number): number {
  if (serves <= 0) return milli;
  return Math.round((milli * servings) / serves);
}

// --- timers ---------------------------------------------------------------------------------

export function timerView(t: Timer, now: string): TimerView {
  const end = t.stopped_at ?? now;
  const pausedNow = t.paused_at === null ? 0 : Math.max(0, seconds(t.paused_at, end));
  const elapsed = Math.max(0, seconds(t.started_at, end) - t.paused_s - pausedNow);
  const remaining = t.duration_s - elapsed;
  const state: TimerView["state"] =
    t.stopped_at !== null ? "stopped" : t.paused_at !== null ? "paused" : remaining <= 0 ? "done" : "running";
  return {
    step: t.step,
    label: t.label,
    duration_s: t.duration_s,
    elapsed_s: elapsed,
    remaining_s: remaining,
    overdue_s: remaining < 0 ? -remaining : 0,
    state,
  };
}

/** Timers a person would want to hear about first: overdue, then closest to done. */
export function timerViews(s: CookSession, now: string): TimerView[] {
  const rank: Record<TimerView["state"], number> = { done: 0, running: 1, paused: 2, stopped: 3 };
  return s.timers
    .map((t) => timerView(t, now))
    .sort((a, b) => rank[a.state] - rank[b.state] || a.remaining_s - b.remaining_s || a.step - b.step);
}

function startTimerFor(step: Step, now: string): Timer | null {
  if (!step.timer || step.dur_s <= 0) return null;
  return { step: step.order, label: step.text, duration_s: step.dur_s, started_at: now, paused_s: 0, paused_at: null, stopped_at: null };
}

// --- the step matcher -----------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "and", "for", "with", "into", "onto", "from", "that", "this", "then", "until", "about",
  "them", "they", "your", "you", "have", "has", "had", "was", "were", "are", "its", "it's", "all",
  "add", "put", "get", "did", "done", "just", "already", "finished", "ready", "some", "over",
  "under", "when", "while", "very", "more", "less", "make", "made", "let", "set", "out", "off",
  "one", "two", "three", "minutes", "minute", "seconds", "second", "hour", "hours",
]);

function contentWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  return new Set(words.filter((w) => w.length > 3 && !STOPWORDS.has(w)));
}

export type StepMatch = { step: number; score: number } | null;

/**
 * Which step the person is talking about, or nothing.
 *
 * Alexa+ has already done the language work; what is left is a dull, deterministic overlap count.
 * A match is only claimed when one step shares at least two content words with what was said **and**
 * beats every other step outright. Anything less is reported as no match, because a wrong step
 * silently marked done is worse than a question asked out loud.
 */
export function matchStep(hint: string, recipe: Recipe): StepMatch {
  const said = contentWords(hint);
  if (said.size === 0) return null;
  const scored = orderedSteps(recipe).map((s) => {
    const words = contentWords(s.text);
    let score = 0;
    for (const w of said) if (words.has(w)) score++;
    return { step: s.order, score };
  });
  const best = scored.reduce((a, b) => (b.score > a.score ? b : a), { step: 0, score: 0 });
  if (best.score < 2) return null;
  const ties = scored.filter((s) => s.score === best.score).length;
  return ties === 1 ? best : null;
}

// --- the machine ----------------------------------------------------------------------------

export type StartInput = {
  id: string; userId: string; recipe: Recipe; servings?: number; now: string;
  /** How many people are cooking, and which step belongs to which of them. Both come from the
   *  scheduler in `src/cook/schedule.ts`; the session takes them as given and never schedules. */
  cooks?: number;
  assignments?: Record<number, number>;
};

export function startSession({ id, userId, recipe, servings, now, cooks, assignments }: StartInput): CookSession {
  const wanted = servings && servings > 0 ? Math.floor(servings) : recipe.serves;
  const session: CookSession = {
    id,
    user_id: userId,
    recipe_id: recipe.id,
    servings: wanted,
    state: "mise_en_place",
    cooks: Math.max(1, Math.min(4, Math.floor(cooks ?? 1))),
    assignments: assignments ?? {},
    started_at: now,
    updated_at: now,
    completed_steps: [],
    timers: [],
    deviations: [],
    checks: [],
    substitutions: [],
    log: [],
  };
  session.log.push({ at: now, from: "mise_en_place", to: "mise_en_place", action: "cook_start", input: null, expected_step: null, actual_step: 0 });
  return session;
}

export type AdvanceResult = {
  session: CookSession;
  /** The step this cook is now on, or null when they have nothing left. */
  step: Step | null;
  /** Which cook this was for. */
  cook: number;
  /** When there is work for them but none of it can start yet, the steps in the way. */
  waiting_for: number[];
  /** Recorded when the hint pointed somewhere other than where we were. */
  deviation: Deviation | null;
  /** True when the hint was heard but could not be pinned to a step. Ask, do not guess. */
  unmatched_hint: boolean;
  /** True when the whole recipe is done, not merely this cook's part of it. */
  finished: boolean;
};

/**
 * Move to the next step.
 *
 * With no hint this is the ordinary case: the current step is complete, the next one begins, and any
 * timer the new step declares starts running. With a hint that names a *different* step, the named
 * step is marked complete and the jump is recorded as a deviation — including a backwards one, which
 * is how "wait, I did the onions first" is meant to be handled.
 */
export function advance(
  s: CookSession,
  recipe: Recipe,
  opts: { now: string; completed_hint?: string | null; cook?: number },
): AdvanceResult {
  const now = opts.now;
  const hint = (opts.completed_hint ?? "").trim();
  const cook = Math.max(1, Math.min(s.cooks, Math.floor(opts.cook ?? 1)));
  if (s.state === "finished" || s.state === "abandoned") {
    return { session: s, step: null, cook, waiting_for: [], deviation: null, unmatched_hint: false, finished: true };
  }

  const session = s.state === "paused" ? resumeIfPaused(s, now) : clone(s);
  const before = currentStepFor(session, recipe, cook);

  let deviation: Deviation | null = null;
  let unmatched = false;
  // Leaving the mise en place completes nothing: there was nothing on the stove to finish.
  let completed = hasStarted(session, cook) ? before.current_step : 0;

  if (hint !== "") {
    const match = matchStep(hint, recipe);
    if (match === null) {
      unmatched = true;
      // Heard, kept, not acted on. The transcript will show it was said.
      session.deviations.push({ at: now, step: before.current_step, kind: "note", what: hint });
    } else {
      completed = match.step;
      const expected = before.current_step;
      if (match.step !== expected) {
        deviation = {
          at: now,
          step: expected,
          kind: "out_of_order",
          what: `said step ${match.step} was done while step ${expected} was the current one: "${hint}"`,
        };
        session.deviations.push(deviation);
      }
    }
  }

  if (completed > 0 && !session.completed_steps.includes(completed)) session.completed_steps.push(completed);
  session.completed_steps.sort((a, b) => a - b);
  for (const t of session.timers) if (t.step === completed && t.stopped_at === null) t.stopped_at = now;

  // The next step is worked out, not remembered: the lowest one this cook has not done whose
  // dependencies are met. A jump forward therefore does not skip the work in between — it comes
  // back for it, which is what a cook actually wants.
  const after = currentStepFor(session, recipe, cook);
  const next = after.current_step === 0 ? null : stepOf(recipe, after.current_step) ?? null;
  const done = allDone(session, recipe);
  const to: SessionState = done ? "finished" : "cooking";
  session.log.push(transition(session, to, "cook_next", now, hint || null, before.current_step, next?.order ?? null, completed > 0 ? completed : null, cook));
  session.state = to;
  session.updated_at = now;

  if (next) {
    const timer = startTimerFor(next, now);
    if (timer && !session.timers.some((t) => t.step === next.order)) session.timers.push(timer);
  }

  return { session, step: next, cook, waiting_for: after.waiting_for, deviation, unmatched_hint: unmatched, finished: done };
}

/** Close out a pause: the paused seconds are added to every timer and the clock starts again. */
function resumeIfPaused(s: CookSession, now: string): CookSession {
  if (s.state !== "paused") return s;
  const session = clone(s);
  for (const t of session.timers) {
    if (t.paused_at !== null && t.stopped_at === null) {
      t.paused_s += Math.max(0, seconds(t.paused_at, now));
      t.paused_at = null;
    }
  }
  // A pause and a resume do not concern any particular step, and recording one would put a false
  // boundary in the log that the post-mortem reads as a step starting.
  session.log.push(transition(s, "cooking", "resume", now, null, null, null));
  session.state = "cooking";
  session.updated_at = now;
  return session;
}

export function pause(s: CookSession, now: string): CookSession {
  if (s.state === "finished" || s.state === "abandoned" || s.state === "paused") return s;
  const session = clone(s);
  for (const t of session.timers) if (t.stopped_at === null && t.paused_at === null) t.paused_at = now;
  session.log.push(transition(s, "paused", "cook_pause", now, null, null, null));
  session.state = "paused";
  session.updated_at = now;
  return session;
}

export function resume(s: CookSession, now: string): CookSession {
  return resumeIfPaused(s, now);
}

export type NoteInput = { now: string; note: string; instead_of?: string | null; used?: string | null; cook?: number };

/**
 * Record something the person said about the cooking.
 *
 * A plain note is kept as one. A note that names a swap — Alexa+ passes the two ingredients it
 * extracted, already resolved to canonical ids by the caller — becomes a substitution, and the
 * deduction on close consumes what was actually used instead of what the recipe asked for.
 */
export function note(s: CookSession, recipe: Recipe, input: NoteInput): { session: CookSession; deviation: Deviation } {
  const session = clone(s);
  const at = currentStepFor(s, recipe, input.cook ?? 1).current_step;
  const swap = input.instead_of && input.used ? { instead_of: input.instead_of, used: input.used } : null;
  const deviation: Deviation = {
    at: input.now,
    step: at,
    kind: swap ? "substitution" : "note",
    what: swap ? `used ${swap.used} instead of ${swap.instead_of}: "${input.note}"` : input.note,
  };
  session.deviations.push(deviation);
  if (swap) session.substitutions.push({ at: input.now, step: at, ...swap });
  session.log.push(transition(s, s.state, "cook_note", input.now, input.note, at, null, null, input.cook ?? 1));
  session.updated_at = input.now;
  return { session, deviation };
}

export type CheckInput = { now: string; step?: number | null; note?: string | null; cook?: number };

/**
 * Record that somebody looked in on a long step.
 *
 * The point of writing it down is to stop asking: the schedule counts everything up to the last look
 * as answered. It also goes in the log, because "did anybody actually look at this in six weeks" is a
 * question only the log can settle.
 */
export function check(s: CookSession, recipe: Recipe, input: CheckInput): { session: CookSession; check: Check } {
  const session = clone(s);
  const step = input.step ?? currentStepFor(s, recipe, input.cook ?? 1).current_step;
  const entry: Check = { at: input.now, step, note: input.note?.trim() || null };
  session.checks = [...(session.checks ?? []), entry];
  session.log.push(transition(s, s.state, "cook_checked", input.now, input.note ?? null, step, null, null, input.cook ?? 1));
  session.updated_at = input.now;
  return { session, check: entry };
}

/** When a step was last looked in on, or null. Derived, and the only thing the schedule needs. */
export function lastCheckOf(s: CookSession, step: number): string | null {
  const times = (s.checks ?? []).filter((c) => c.step === step).map((c) => c.at).sort();
  return times.length ? times[times.length - 1] : null;
}

export function finish(s: CookSession, recipe: Recipe, now: string): CookSession {
  if (s.state === "finished") return s;
  const session = clone(s);
  for (const st of orderedSteps(recipe)) if (!session.completed_steps.includes(st.order)) session.completed_steps.push(st.order);
  session.completed_steps.sort((a, b) => a - b);
  for (const t of session.timers) if (t.stopped_at === null) t.stopped_at = now;
  session.log.push(transition(s, "finished", "cook_finish", now, null, currentStepFor(s, recipe, 1).current_step, null));
  session.state = "finished";
  session.updated_at = now;
  return session;
}

export function abandon(s: CookSession, now: string): CookSession {
  const session = clone(s);
  for (const t of session.timers) if (t.stopped_at === null) t.stopped_at = now;
  session.log.push(transition(s, "abandoned", "cook_abandon", now, null, null, null));
  session.state = "abandoned";
  session.updated_at = now;
  return session;
}

// --- what the person is told ------------------------------------------------------------------

export type MiseItem = {
  ingredient_id: string;
  qty: number | null;
  unit: string;
  note: string | null;
  /** `estimated` and `unspecified` travel from the recipe data; the narrator must not round them away. */
  qty_source: string;
  role: string;
  /** True when the amount was scaled at less than the full rate — seasoning, mostly. The narrator
   *  should say so, because "one and a half teaspoons" for a doubled recipe looks like a mistake
   *  until somebody explains that salt does not double. */
  damped: boolean;
  /** Why, in the scaling table's own words. null when nothing was damped. */
  scaling_note: string | null;
};

/**
 * The mise en place, scaled to the servings asked for.
 *
 * An amount the book never gave stays null. With a scaling table, seasoning and leavening scale at
 * less than the full rate and say so; without one every amount multiplies straight, which is what
 * this did before the table existed.
 */
export function misePlace(recipe: Recipe, servings: number, scaling?: Scaling): MiseItem[] {
  return recipe.ingredients.map((i) => {
    const rule = scaling ? scaling(i.id, i.role, i.technique) : LINEAR;
    const base = i.qty === null ? null : toMilli(i.qty);
    // Only a number can scale at less than the full rate. Saying "the water did not scale straight"
    // about an amount the book never gave is noise dressed as care.
    const damped = base !== null && rule.damping[0] !== rule.damping[1] && servings !== recipe.serves;
    return {
      ingredient_id: i.id,
      qty: base === null ? null : scaleDamped(base, servings, recipe.serves, rule) / 1000,
      unit: i.unit,
      note: i.note,
      qty_source: i.qty_source,
      role: i.role,
      damped,
      scaling_note: damped ? rule.note : null,
    };
  });
}

export type SessionView = {
  session_id: string;
  recipe_id: string;
  state: SessionState;
  servings: number;
  cooks: number;
  /** The step the cook who asked is on, or null when they have nothing to do. */
  step: (Step & { of: number }) | null;
  /** When there is work left for them but none of it can start, the steps in the way. */
  waiting_for: number[];
  /** Everybody's place at once, for the view that shows both. */
  tracks: { cook: number; step: number; waiting_for: number[] }[];
  completed_steps: number[];
  remaining_steps: number[];
  timers: TimerView[];
  deviations: Deviation[];
  substitutions: Substitution[];
  started_at: string;
  updated_at: string;
  /** Wall-clock seconds since the session started, pauses included. What "how long have I been at
   *  this" means to a person standing in a kitchen. */
  elapsed_s: number;
};

export function view(s: CookSession, recipe: Recipe, now: string, cook = 1): SessionView {
  const steps = orderedSteps(recipe);
  const track = currentStepFor(s, recipe, cook);
  // In the mise en place nothing has begun; showing step one there would be the system getting
  // ahead of the person.
  const step = s.state === "mise_en_place" ? null : stepOf(recipe, track.current_step) ?? null;
  return {
    session_id: s.id,
    recipe_id: s.recipe_id,
    state: s.state,
    servings: s.servings,
    cooks: s.cooks,
    step: step === null ? null : { ...step, of: steps.length },
    waiting_for: track.waiting_for,
    tracks: tracksOf(s, recipe).map((t) => ({ cook: t.cook, step: t.current_step, waiting_for: t.waiting_for })),
    completed_steps: [...s.completed_steps],
    remaining_steps: steps.map((st) => st.order).filter((o) => !s.completed_steps.includes(o)),
    timers: timerViews(s, now),
    deviations: [...s.deviations],
    substitutions: [...s.substitutions],
    started_at: s.started_at,
    updated_at: s.updated_at,
    elapsed_s: Math.max(0, seconds(s.started_at, now)),
  };
}

// --- the deduction --------------------------------------------------------------------------

/** A dish in the pantry, keyed so it can never collide with an ingredient. */
export function leftoverId(recipeId: string): string {
  return `leftover-${recipeId}`;
}

/**
 * What was cooked and not eaten, as a pantry line.
 *
 * The loop most people actually live in: six servings, two people, four portions in the fridge. It
 * goes in as `inferred` — the person said how many portions, but nobody counted what is in them —
 * with no expiry of its own, so the shelf-life table's four days applies and stays labelled as the
 * estimate it is.
 */
export function leftoverEvent(s: CookSession, recipe: Recipe, portions: number, now: string): PantryEvent | null {
  const whole = Math.floor(portions);
  if (!Number.isFinite(whole) || whole <= 0) return null;
  return {
    ts: now,
    seq: 0,
    type: "add",
    ingredient_id: leftoverId(recipe.id),
    qty_milli: whole * 1000,
    unit: "portion",
    origin: "recipe_deduction",
    confidence: "inferred",
    location: "fridge",
    expires_on: null,
    external_id: `leftover:${s.id}`,
    source_device: null,
  };
}

export type Deduction = {
  events: PantryEvent[];
  /** Ingredients deliberately not deducted, with the reason. Reported, never silent. */
  skipped: { ingredient_id: string; reason: string }[];
};

/**
 * What cooking this took out of the pantry.
 *
 * Every event is `consume` / `recipe_deduction` / **inferred** — the person never said these numbers,
 * the system worked them out, and the pantry marks them accordingly for the rest of their life.
 * Three honest cases:
 *
 *   - a quantity the recipe stated → consumed, scaled to the servings actually cooked;
 *   - a quantity the recipe never gave → consumed as `null`, which the fold turns into "some, amount
 *     unknown" for that whole line, because that is the truth;
 *   - `to_taste` → not deducted at all, and named in `skipped`. "To taste" is not an amount, and
 *     pretending otherwise would quietly empty the salt.
 *
 * A swap recorded during the session redirects the deduction: the chickpeas actually used are the
 * ones consumed, and the lentils are left alone.
 */
export function consumptionEvents(s: CookSession, recipe: Recipe, now: string, scaling?: Scaling): Deduction {
  const swapped = new Map(s.substitutions.map((x) => [x.instead_of, x.used]));
  const events: PantryEvent[] = [];
  const skipped: Deduction["skipped"] = [];
  let seq = 0;

  for (const i of recipe.ingredients) {
    const id = swapped.get(i.id) ?? i.id;
    if (i.unit === "to_taste") {
      skipped.push({ ingredient_id: id, reason: "measured to taste, so there is no amount to deduct" });
      continue;
    }
    let milli: number | null = null;
    if (i.qty !== null) {
      const base = toMilli(i.qty);
      // The same damping the mise en place used. Taking twice the salt off a shelf that only lost
      // one and a half times as much would make the pantry disagree with what the cook was told.
      milli = base === null ? null : scaleDamped(base, s.servings, recipe.serves, scaling ? scaling(i.id, i.role, i.technique) : LINEAR);
    }
    const amount = canonicalAmount(milli, i.unit as Unit);
    events.push({
      ts: now,
      seq: seq++,
      type: "consume",
      ingredient_id: id,
      qty_milli: amount.qty_milli,
      unit: amount.unit,
      origin: "recipe_deduction",
      confidence: "inferred",
      location: "pantry",
      expires_on: null,
      // One deduction per session per ingredient. A second `cook_finish` on the same session — a
      // retried call, a double tap on the UI — folds to the same pantry.
      external_id: `cook:${s.id}:${id}`,
      source_device: null,
    });
  }
  return { events, skipped };
}
