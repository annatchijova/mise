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
import type { Recipe, Step } from "../recipes.ts";
import { type PantryEvent, type Unit, canonicalAmount, toMilli } from "../pantry/events.ts";

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
};

export type CookSession = {
  id: string;
  user_id: string;
  recipe_id: string;
  servings: number;
  state: SessionState;
  /** 0 while gathering the mise en place; then the step number being worked on. */
  current_step: number;
  started_at: string;
  updated_at: string;
  completed_steps: number[];
  timers: Timer[];
  deviations: Deviation[];
  substitutions: Substitution[];
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
  input: string | null, expected: number | null, actual: number | null, completed: number | null = null,
): Transition {
  return { at, from: s.state, to, action, input, expected_step: expected, actual_step: actual, completed_step: completed };
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

export type StartInput = { id: string; userId: string; recipe: Recipe; servings?: number; now: string };

export function startSession({ id, userId, recipe, servings, now }: StartInput): CookSession {
  const wanted = servings && servings > 0 ? Math.floor(servings) : recipe.serves;
  const session: CookSession = {
    id,
    user_id: userId,
    recipe_id: recipe.id,
    servings: wanted,
    state: "mise_en_place",
    current_step: 0,
    started_at: now,
    updated_at: now,
    completed_steps: [],
    timers: [],
    deviations: [],
    substitutions: [],
    log: [],
  };
  session.log.push({ at: now, from: "mise_en_place", to: "mise_en_place", action: "cook_start", input: null, expected_step: null, actual_step: 0 });
  return session;
}

export type AdvanceResult = {
  session: CookSession;
  /** The step now being worked on, or null when the recipe is done. */
  step: Step | null;
  /** Recorded when the hint pointed somewhere other than where we were. */
  deviation: Deviation | null;
  /** True when the hint was heard but could not be pinned to a step. Ask, do not guess. */
  unmatched_hint: boolean;
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
export function advance(s: CookSession, recipe: Recipe, opts: { now: string; completed_hint?: string | null }): AdvanceResult {
  const now = opts.now;
  const hint = (opts.completed_hint ?? "").trim();
  if (s.state === "finished" || s.state === "abandoned") {
    return { session: s, step: null, deviation: null, unmatched_hint: false, finished: true };
  }

  const steps = orderedSteps(recipe);
  const last = lastStep(recipe);
  const session = s.state === "paused" ? resumeIfPaused(s, now) : clone(s);

  let deviation: Deviation | null = null;
  let unmatched = false;
  let completed = session.current_step;

  if (hint !== "") {
    const match = matchStep(hint, recipe);
    if (match === null) {
      unmatched = true;
      // Heard, kept, not acted on. The transcript will show it was said.
      session.deviations.push({ at: now, step: session.current_step, kind: "note", what: hint });
    } else {
      completed = match.step;
      // From the mise en place the "current" step is the first one nobody has done.
      const expected = session.current_step === 0
        ? (steps.find((st) => !session.completed_steps.includes(st.order))?.order ?? 0)
        : session.current_step;
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

  // The next step is the lowest one nobody has done yet. A jump forward therefore does not skip the
  // work in between — it comes back for it, which is what a cook actually wants.
  const next = steps.find((st) => !session.completed_steps.includes(st.order)) ?? null;
  const to: SessionState = next === null ? "finished" : "cooking";
  session.log.push(transition(session, to, "cook_next", now, hint || null, s.current_step, next?.order ?? null, completed > 0 ? completed : null));
  session.state = to;
  session.current_step = next?.order ?? last;
  session.updated_at = now;

  if (next) {
    const timer = startTimerFor(next, now);
    if (timer && !session.timers.some((t) => t.step === next.order)) session.timers.push(timer);
  }

  return { session, step: next, deviation, unmatched_hint: unmatched, finished: next === null };
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
  session.log.push(transition(s, "cooking", "resume", now, null, s.current_step, s.current_step));
  session.state = "cooking";
  session.updated_at = now;
  return session;
}

export function pause(s: CookSession, now: string): CookSession {
  if (s.state === "finished" || s.state === "abandoned" || s.state === "paused") return s;
  const session = clone(s);
  for (const t of session.timers) if (t.stopped_at === null && t.paused_at === null) t.paused_at = now;
  session.log.push(transition(s, "paused", "cook_pause", now, null, s.current_step, s.current_step));
  session.state = "paused";
  session.updated_at = now;
  return session;
}

export function resume(s: CookSession, now: string): CookSession {
  return resumeIfPaused(s, now);
}

export type NoteInput = { now: string; note: string; instead_of?: string | null; used?: string | null };

/**
 * Record something the person said about the cooking.
 *
 * A plain note is kept as one. A note that names a swap — Alexa+ passes the two ingredients it
 * extracted, already resolved to canonical ids by the caller — becomes a substitution, and the
 * deduction on close consumes what was actually used instead of what the recipe asked for.
 */
export function note(s: CookSession, input: NoteInput): { session: CookSession; deviation: Deviation } {
  const session = clone(s);
  const swap = input.instead_of && input.used ? { instead_of: input.instead_of, used: input.used } : null;
  const deviation: Deviation = {
    at: input.now,
    step: s.current_step,
    kind: swap ? "substitution" : "note",
    what: swap ? `used ${swap.used} instead of ${swap.instead_of}: "${input.note}"` : input.note,
  };
  session.deviations.push(deviation);
  if (swap) session.substitutions.push({ at: input.now, step: s.current_step, ...swap });
  session.log.push(transition(s, s.state, "cook_note", input.now, input.note, s.current_step, s.current_step));
  session.updated_at = input.now;
  return { session, deviation };
}

export function finish(s: CookSession, recipe: Recipe, now: string): CookSession {
  if (s.state === "finished") return s;
  const session = clone(s);
  for (const st of orderedSteps(recipe)) if (!session.completed_steps.includes(st.order)) session.completed_steps.push(st.order);
  session.completed_steps.sort((a, b) => a - b);
  for (const t of session.timers) if (t.stopped_at === null) t.stopped_at = now;
  session.log.push(transition(s, "finished", "cook_finish", now, null, s.current_step, s.current_step));
  session.state = "finished";
  session.updated_at = now;
  return session;
}

export function abandon(s: CookSession, now: string): CookSession {
  const session = clone(s);
  for (const t of session.timers) if (t.stopped_at === null) t.stopped_at = now;
  session.log.push(transition(s, "abandoned", "cook_abandon", now, null, s.current_step, s.current_step));
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
};

/** The mise en place, scaled to the servings asked for. An amount the book never gave stays null. */
export function misePlace(recipe: Recipe, servings: number): MiseItem[] {
  return recipe.ingredients.map((i) => ({
    ingredient_id: i.id,
    qty: i.qty === null ? null : scaleMilli(toMilli(i.qty) ?? 0, servings, recipe.serves) / 1000,
    unit: i.unit,
    note: i.note,
    qty_source: i.qty_source,
    role: i.role,
  }));
}

export type SessionView = {
  session_id: string;
  recipe_id: string;
  state: SessionState;
  servings: number;
  step: (Step & { of: number }) | null;
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

export function view(s: CookSession, recipe: Recipe, now: string): SessionView {
  const steps = orderedSteps(recipe);
  const step = stepOf(recipe, s.current_step) ?? null;
  return {
    session_id: s.id,
    recipe_id: s.recipe_id,
    state: s.state,
    servings: s.servings,
    step: step === null ? null : { ...step, of: steps.length },
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
export function consumptionEvents(s: CookSession, recipe: Recipe, now: string): Deduction {
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
      milli = base === null ? null : scaleMilli(base, s.servings, recipe.serves);
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
