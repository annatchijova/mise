// Two people, one dinner.
//
// A recipe's steps are a dependency graph — `depends_on` has been in the data contract since the
// beginning — and some of them hold a timer rather than a pair of hands. That is enough to answer a
// question no recipe app can: if somebody else is helping, who does what, and does it actually
// finish sooner?
//
// The model has one idea in it. **A step with a timer occupies the pot, not the cook.** Starting a
// thirty minute simmer costs a minute of somebody's attention and then the pot works alone; anything
// that depends on it still waits the full thirty. A step without a timer holds the cook's hands for
// its whole duration. That distinction is why a second person helps at all, and it is why "make two
// of everything" is not the answer.
//
// The scheduling itself is list scheduling by critical path: at each turn the cook who frees up
// first takes the eligible step that can start soonest, breaking ties by how much work hangs off it
// and then by step order. It is not provably optimal — that problem is NP-hard — but on recipes of
// two to nine steps it is within a step of optimal, and it is *deterministic and explainable*, which
// matters more here than the last thirty seconds. Somebody has to be able to ask why they were given
// the onions and get an answer.
//
// What this file decides is **who**. It does not decide when: the session still tracks what people
// actually did, because a schedule that insisted on its own timings would be a stopwatch pretending
// to be a kitchen.
import type { Recipe, Step } from "../recipes.ts";
import { orderedSteps } from "./session.ts";

/** How long a timer step holds somebody's hands before the pot takes over. One minute: long enough
 *  to be true of putting a pot on, short enough not to distort a schedule made of half-hours. */
export const ATTEND_S = 60;

export type Assignment = {
  step: number;
  /** 1-based, so it can be said out loud. */
  cook: number;
  start_s: number;
  /** How long this step holds the cook. Less than its duration when it has a timer. */
  hands_s: number;
  /** When the cook is free again. */
  free_s: number;
  /** When anything depending on this step may begin — the full duration, timer or not. */
  done_s: number;
  /** Seconds this cook stood waiting for somebody else's step before starting this one. */
  waited_s: number;
  /** The steps that kept them waiting. Empty when they walked straight into it. */
  waited_for: number[];
};

export type Schedule = {
  cooks: number;
  assignments: Assignment[];
  /** When the last step is done, in seconds from the start. */
  makespan_s: number;
  /** The same recipe with one cook, for comparison. */
  solo_s: number;
  saved_s: number;
  /** True when nothing can be done in parallel and a second person has nowhere to stand. */
  no_benefit: boolean;
};

/** Hands-on time: a timer step lets go of the cook, everything else does not. */
export function handsOn(step: Step): number {
  return step.timer ? Math.min(step.dur_s, ATTEND_S) : step.dur_s;
}

/** Longest path from a step to the end of the recipe, in seconds. Steps with more work hanging off
 *  them go first — the ordinary critical-path rule, and the reason the thirty minute simmer is
 *  started before the salad is dressed. */
function tails(steps: Step[]): Map<number, number> {
  const byOrder = new Map(steps.map((s) => [s.order, s]));
  const dependents = new Map<number, number[]>();
  for (const s of steps) {
    for (const dep of s.depends_on) {
      if (!byOrder.has(dep)) continue; // a dependency on a step that is not there is not a cycle
      dependents.set(dep, [...(dependents.get(dep) ?? []), s.order]);
    }
  }
  const tail = new Map<number, number>();
  // Reverse order works because a step may only depend on a lower-numbered one in this data
  // contract; the guard below keeps a hand-edited file from looping forever anyway.
  for (const s of [...steps].sort((a, b) => b.order - a.order)) {
    const after = (dependents.get(s.order) ?? []).map((o) => tail.get(o) ?? 0);
    tail.set(s.order, s.dur_s + (after.length === 0 ? 0 : Math.max(...after)));
  }
  return tail;
}

/**
 * Who does what.
 *
 * Deterministic: the same recipe and the same number of cooks give the same assignments on every
 * machine, because every tie is broken on something written in the data rather than on iteration
 * order.
 */
export function scheduleSteps(recipe: Recipe, cooks: number): Schedule {
  const wanted = Math.max(1, Math.min(4, Math.floor(cooks)));
  const steps = orderedSteps(recipe);
  const tail = tails(steps);
  const byOrder = new Map(steps.map((s) => [s.order, s]));

  const run = (n: number): { assignments: Assignment[]; makespan: number } => {
    const free = Array.from({ length: n }, () => 0);
    const done = new Map<number, number>();
    const owner = new Map<number, number>();
    const assignments: Assignment[] = [];
    const left = new Set(steps.map((s) => s.order));

    while (left.size > 0) {
      const eligible = [...left]
        .map((order) => byOrder.get(order)!)
        .filter((s) => s.depends_on.every((d) => !byOrder.has(d) || done.has(d)));
      if (eligible.length === 0) {
        // A cycle, or a dependency on a step that does not exist. Schedule the rest in order rather
        // than hanging: a hand-edited recipe should degrade to "one after another", not to nothing.
        for (const order of [...left].sort((a, b) => a - b)) {
          const s = byOrder.get(order)!;
          const start = Math.max(...free);
          assignments.push({ step: s.order, cook: 1, start_s: start, hands_s: handsOn(s), free_s: start + handsOn(s), done_s: start + s.dur_s, waited_s: 0, waited_for: [] });
          free[0] = start + handsOn(s);
          done.set(s.order, start + s.dur_s);
          left.delete(order);
        }
        break;
      }

      // The cook who frees up first takes the next step. Ties go to the lower-numbered cook, so the
      // same recipe hands out the same jobs every time.
      let cook = 0;
      for (let i = 1; i < n; i++) if (free[i] < free[cook]) cook = i;

      const readyAt = (s: Step) => Math.max(0, ...s.depends_on.map((d) => done.get(d) ?? 0));
      const picked = eligible
        .map((s) => ({ s, start: Math.max(free[cook], readyAt(s)) }))
        .sort((a, b) => a.start - b.start || (tail.get(b.s.order) ?? 0) - (tail.get(a.s.order) ?? 0) || a.s.order - b.s.order)[0];

      const s = picked.s;
      const start = picked.start;
      const blocking = s.depends_on.filter((d) => (done.get(d) ?? 0) > free[cook] && owner.get(d) !== cook + 1);
      assignments.push({
        step: s.order,
        cook: cook + 1,
        start_s: start,
        hands_s: handsOn(s),
        free_s: start + handsOn(s),
        done_s: start + s.dur_s,
        waited_s: Math.max(0, start - free[cook]),
        waited_for: blocking.sort((a, b) => a - b),
      });
      owner.set(s.order, cook + 1);
      free[cook] = start + handsOn(s);
      done.set(s.order, start + s.dur_s);
      left.delete(s.order);
    }

    const makespan = Math.max(0, ...[...done.values()]);
    return { assignments: assignments.sort((a, b) => a.start_s - b.start_s || a.step - b.step), makespan };
  };

  const many = run(wanted);
  const solo = wanted === 1 ? many : run(1);
  return {
    cooks: wanted,
    assignments: many.assignments,
    makespan_s: many.makespan,
    solo_s: solo.makespan,
    saved_s: Math.max(0, solo.makespan - many.makespan),
    // A second pair of hands with nothing to hold is worth saying rather than pretending about.
    no_benefit: wanted > 1 && solo.makespan - many.makespan < 60,
  };
}

/** Which cook each step belongs to. What the session actually stores. */
export function assignmentsByStep(schedule: Schedule): Record<number, number> {
  const out: Record<number, number> = {};
  for (const a of schedule.assignments) out[a.step] = a.cook;
  return out;
}
