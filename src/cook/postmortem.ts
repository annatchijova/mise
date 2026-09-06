// What actually happened, read back off the transition log.
//
// A cooking session already records every transition with its time, every deviation with the words
// that caused it, every swap, and every timer. Nothing ever read it back. This does — and it can,
// because the session is a state machine rather than a cursor, which is the one thing no recipe app
// can say.
//
// The discipline here is the same one that runs through the rest of the project, and it matters more
// in this file than anywhere else, because a post-mortem is an invitation to tell a story. **The log
// witnessed times and transitions. It did not witness the food.** So every observation is derived
// arithmetic over recorded timestamps, and the questions people actually ask — why was it salty, why
// did it stick — come back in `cannot_say` with the reason nothing here can answer them. A plausible
// explanation of a dinner nobody measured is exactly the kind of thing this server refuses to
// produce, however much a person would enjoy hearing it.
import type { Recipe, Step } from "../recipes.ts";
import { type CookSession, type Transition, orderedSteps, timerViews } from "./session.ts";

export type StepTiming = {
  order: number;
  text: string;
  started_at: string | null;
  finished_at: string | null;
  /** Wall clock spent on this step with paused time removed, or null when it was never started. */
  actual_s: number | null;
  estimated_s: number;
  dur_source: string;
  /** actual minus estimated, when both are known. Negative means it went faster than the book. */
  over_by_s: number | null;
  /** How many times this step was marked done. More than one is a real signal, not a glitch. */
  completions: number;
};

export type Gap = { after_step: number; seconds: number; from: string; to: string; paused: boolean };

export type PostMortem = {
  session_id: string;
  recipe_id: string;
  title: string;
  state: string;
  servings: number;
  started_at: string;
  finished_at: string | null;
  /** Start to finish on the wall clock, pauses included. */
  total_s: number;
  /** The same, with paused time taken out. */
  cooking_s: number;
  paused_s: number;
  /** What the book's own step durations add up to. */
  estimated_s: number;
  /** How many of those durations the book never gave, and this project estimated. */
  estimated_steps: number;
  steps: StepTiming[];
  /** The step that overran its estimate by most, when any did. */
  slowest: StepTiming | null;
  /** The longest stretch where nothing moved. */
  longest_gap: Gap | null;
  deviations: CookSession["deviations"];
  substitutions: CookSession["substitutions"];
  repeated_steps: number[];
  /** Sentences derived from the numbers above, and from nothing else. */
  observations: string[];
  /** What the log did not witness, with the reason. The honest half of the answer. */
  cannot_say: string[];
};

function seconds(from: string, to: string): number {
  return Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / 1000));
}

/** Stretches where the session was paused, closed off by the resume that followed. */
function pausedIntervals(log: Transition[], end: string): [string, string][] {
  const out: [string, string][] = [];
  let open: string | null = null;
  for (const t of log) {
    if (t.action === "cook_pause") open = open ?? t.at;
    else if (open !== null && (t.action === "resume" || t.action === "cook_finish" || t.action === "cook_abandon")) {
      out.push([open, t.at]);
      open = null;
    }
  }
  if (open !== null) out.push([open, end]);
  return out;
}

/** Seconds of [from, to) that fall inside a paused stretch. */
function pausedWithin(intervals: [string, string][], from: string, to: string): number {
  const start = Date.parse(from);
  const end = Date.parse(to);
  let total = 0;
  for (const [a, b] of intervals) {
    const lo = Math.max(start, Date.parse(a));
    const hi = Math.min(end, Date.parse(b));
    if (hi > lo) total += Math.floor((hi - lo) / 1000);
  }
  return total;
}

/** Durations as a person says them. Shared shape with the cook tools, kept separate on purpose:
 *  this one rounds to whole minutes because a post-mortem is not a stopwatch. */
export function spanText(s: number): string {
  if (s < 60) return `${s} seconds`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `${h} hour${h === 1 ? "" : "s"}${rest ? ` ${rest} minutes` : ""}`;
}

export function postMortem(session: CookSession, recipe: Recipe, now: string): PostMortem {
  const steps = orderedSteps(recipe);
  const log = [...session.log].sort((a, b) => a.at.localeCompare(b.at));
  const end = session.state === "finished" || session.state === "abandoned" ? session.updated_at : now;
  const paused = pausedIntervals(log, end);

  // When each step became the current one, in order. `cook_next` is the only action that moves the
  // cursor, so these are the only transitions that mark a boundary.
  const marks: { at: string; step: number }[] = [];
  for (const t of log) {
    if (t.actual_step === null) continue;
    if (marks.length > 0 && marks[marks.length - 1].step === t.actual_step) continue;
    marks.push({ at: t.at, step: t.actual_step });
  }

  // Which steps were ticked off, and how often. The log records the step each call marked done, so
  // this is a count of something written down rather than a reconstruction of it. A session saved
  // before that field existed simply contributes nothing, which is the honest degradation.
  const completions = new Map<number, number>();
  for (const t of log) {
    const done = t.completed_step ?? null;
    if (done !== null && done > 0) completions.set(done, (completions.get(done) ?? 0) + 1);
  }

  const timings: StepTiming[] = steps.map((s: Step) => {
    const startAt = marks.find((m) => m.step === s.order)?.at ?? null;
    const startIndex = marks.findIndex((m) => m.step === s.order);
    const finishAt = startIndex === -1 ? null : (marks[startIndex + 1]?.at ?? (session.completed_steps.includes(s.order) ? end : null));
    const actual = startAt !== null && finishAt !== null ? seconds(startAt, finishAt) - pausedWithin(paused, startAt, finishAt) : null;
    return {
      order: s.order,
      text: s.text,
      started_at: startAt,
      finished_at: finishAt,
      actual_s: actual,
      estimated_s: s.dur_s,
      dur_source: s.dur_source,
      over_by_s: actual === null ? null : actual - s.dur_s,
      completions: completions.get(s.order) ?? 0,
    };
  });

  const totalPaused = paused.reduce((sum, [a, b]) => sum + seconds(a, b), 0);
  const total = seconds(session.started_at, end);

  const overran = timings.filter((t) => t.over_by_s !== null && t.over_by_s > 0);
  const slowest = overran.length === 0 ? null : overran.reduce((a, b) => ((b.over_by_s ?? 0) > (a.over_by_s ?? 0) ? b : a));

  const gaps: Gap[] = [];
  for (let i = 1; i < marks.length; i++) {
    const from = marks[i - 1];
    const to = marks[i];
    const span = seconds(from.at, to.at);
    gaps.push({ after_step: from.step, seconds: span, from: from.at, to: to.at, paused: pausedWithin(paused, from.at, to.at) > span / 2 });
  }
  const longest = gaps.length === 0 ? null : gaps.reduce((a, b) => (b.seconds > a.seconds ? b : a));

  const repeated = [...completions.entries()].filter(([, n]) => n > 1).map(([step]) => step).sort((a, b) => a - b);

  // --- what the numbers say ---------------------------------------------------------------------
  const observations: string[] = [];
  const estimated = steps.reduce((sum, s) => sum + s.dur_s, 0);
  const estimatedSteps = steps.filter((s) => s.dur_source === "estimated").length;

  observations.push(
    `${spanText(total)} from start to finish${totalPaused > 0 ? `, of which ${spanText(totalPaused)} was paused` : ""}. ` +
      `The recipe's own steps add up to about ${spanText(estimated)}${estimatedSteps > 0 ? `, and ${estimatedSteps} of those durations are this kitchen's estimate rather than the book's` : ""}.`,
  );
  if (slowest && slowest.over_by_s !== null && slowest.over_by_s > 60) {
    observations.push(`Step ${slowest.order} took ${spanText(slowest.actual_s ?? 0)} against ${spanText(slowest.estimated_s)}: ${spanText(slowest.over_by_s)} longer than the recipe expects.`);
  }
  if (longest && longest.seconds > 600) {
    observations.push(
      longest.paused
        ? `The pot sat for ${spanText(longest.seconds)} after step ${longest.after_step}, while the session was paused.`
        : `Nothing moved for ${spanText(longest.seconds)} after step ${longest.after_step}, and the session was not paused for it.`,
    );
  }
  for (const step of repeated) {
    observations.push(`Step ${step} was ticked off ${completions.get(step)} times. If that step seasons the dish, it went in more than once.`);
  }
  for (const d of session.deviations.filter((x) => x.kind === "out_of_order")) {
    observations.push(`Out of order: ${d.what}.`);
  }
  for (const s of session.substitutions) {
    observations.push(`You used ${s.used.replace(/-/g, " ")} instead of ${s.instead_of.replace(/-/g, " ")} at step ${s.step}, and the pantry count followed what you used.`);
  }
  const running = timerViews(session, now).filter((t) => t.state === "done" && t.overdue_s > 300);
  for (const t of running) {
    observations.push(`The timer on step ${t.step} ran ${spanText(t.overdue_s)} past its ${spanText(t.duration_s)}.`);
  }

  // --- what it cannot say -----------------------------------------------------------------------
  const cannotSay = [
    "how much of anything actually went in — the session records steps, not the spoon.",
    "how hot the pan was, or how it looked; nothing here measures either.",
    "how it tasted. The log knows what happened and when, and that is all it knows.",
  ];
  if (session.deviations.length === 0) {
    cannotSay.push("whether anything was done differently that you did not say out loud — nothing was recorded, which is not the same as nothing having happened.");
  }
  if (timings.some((t) => t.actual_s === null)) {
    cannotSay.push("how long the steps you never marked took, because nothing marked their start or end.");
  }

  return {
    session_id: session.id,
    recipe_id: session.recipe_id,
    title: recipe.title,
    state: session.state,
    servings: session.servings,
    started_at: session.started_at,
    finished_at: session.state === "finished" ? session.updated_at : null,
    total_s: total,
    cooking_s: Math.max(0, total - totalPaused),
    paused_s: totalPaused,
    estimated_s: estimated,
    estimated_steps: estimatedSteps,
    steps: timings,
    slowest,
    longest_gap: longest,
    deviations: [...session.deviations],
    substitutions: [...session.substitutions],
    repeated_steps: repeated,
    observations,
    cannot_say: cannotSay,
  };
}
