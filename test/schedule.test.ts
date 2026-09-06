// Two cooks is the one feature here that needs a graph rather than a list, so these tests are about
// the graph: that a dependency is never violated, that the schedule is the same on every machine,
// and that a second pair of hands with nowhere to stand is said rather than pretended about.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { Recipe, Step } from "../src/recipes.ts";
import { loadRecipes } from "../src/recipes.ts";
import { ATTEND_S, assignmentsByStep, handsOn, scheduleSteps } from "../src/cook/schedule.ts";
import { advance, allDone, currentStepFor, startSession } from "../src/cook/session.ts";

const recipes = loadRecipes();
const T0 = "2026-09-05T18:00:00.000Z";
const at = (m: number) => new Date(Date.parse(T0) + m * 60_000).toISOString();

/** A recipe made of nothing but steps, for testing the graph rather than the corpus. */
function recipeOf(steps: { order: number; dur_s: number; timer?: boolean; depends_on?: number[] }[]): Recipe {
  return {
    id: "test", title: "Test", title_es: "", source: { book: "", locator: "", original_text: "" },
    category: "main", diet: { vegan: true, gluten_free: true, notes: [] },
    minutes: 30, minutes_source: "estimated", serves: 2, serves_source: "stated",
    ingredients: [],
    steps: steps.map((s): Step => ({
      order: s.order, text: `step ${s.order}`, text_es: "", dur_s: s.dur_s,
      dur_source: "stated", timer: s.timer ?? false, depends_on: s.depends_on ?? [],
    })),
    review: {},
  };
}

test("a step never starts before what it depends on has finished", () => {
  for (const recipe of recipes) {
    const schedule = scheduleSteps(recipe, 2);
    const done = new Map(schedule.assignments.map((a) => [a.step, a.done_s]));
    for (const a of schedule.assignments) {
      const step = recipe.steps.find((s) => s.order === a.step)!;
      for (const dep of step.depends_on) {
        if (!done.has(dep)) continue;
        assert.ok(a.start_s >= done.get(dep)!, `${recipe.id}: step ${a.step} starts before step ${dep} is done`);
      }
    }
  }
});

test("nobody is in two places at once", () => {
  for (const recipe of recipes) {
    const schedule = scheduleSteps(recipe, 2);
    for (const cook of [1, 2]) {
      const mine = schedule.assignments.filter((a) => a.cook === cook).sort((x, y) => x.start_s - y.start_s);
      for (let i = 1; i < mine.length; i++) {
        assert.ok(mine[i].start_s >= mine[i - 1].free_s, `${recipe.id}: cook ${cook} is on two steps at once`);
      }
    }
  }
});

test("a timer holds the pot, not the cook — which is the whole reason a second person helps", () => {
  const simmer = recipeOf([{ order: 1, dur_s: 1800, timer: true }]);
  assert.equal(handsOn(simmer.steps[0]), ATTEND_S, "putting a pot on costs a minute of attention");
  const chop = recipeOf([{ order: 1, dur_s: 1800, timer: false }]);
  assert.equal(handsOn(chop.steps[0]), 1800, "half an hour of chopping is half an hour of somebody");
});

test("two independent jobs are done at once; two dependent ones are not", () => {
  const parallel = recipeOf([{ order: 1, dur_s: 600 }, { order: 2, dur_s: 600 }]);
  const chained = recipeOf([{ order: 1, dur_s: 600 }, { order: 2, dur_s: 600, depends_on: [1] }]);
  assert.equal(scheduleSteps(parallel, 2).makespan_s, 600, "ten minutes each, done together");
  assert.equal(scheduleSteps(parallel, 2).solo_s, 1200);
  assert.equal(scheduleSteps(chained, 2).makespan_s, 1200, "a chain is a chain however many people there are");
  assert.equal(scheduleSteps(chained, 2).saved_s, 0);
});

test("a recipe nobody can help with says so instead of pretending", () => {
  const chained = recipeOf([
    { order: 1, dur_s: 600 },
    { order: 2, dur_s: 600, depends_on: [1] },
    { order: 3, dur_s: 600, depends_on: [2] },
  ]);
  const schedule = scheduleSteps(chained, 2);
  assert.equal(schedule.no_benefit, true);
  assert.equal(schedule.saved_s, 0);
});

test("the longest chain is started first, not the shortest job", () => {
  // A thirty minute chain and two short jobs. The chain has to go first or the dinner is late.
  const recipe = recipeOf([
    { order: 1, dur_s: 300 },
    { order: 2, dur_s: 300 },
    { order: 3, dur_s: 1800 },
    { order: 4, dur_s: 1800, depends_on: [3] },
  ]);
  const schedule = scheduleSteps(recipe, 2);
  const third = schedule.assignments.find((a) => a.step === 3)!;
  assert.equal(third.start_s, 0, "the step with the most work hanging off it starts immediately");
});

test("the same recipe hands out the same jobs every time", () => {
  for (const recipe of recipes.slice(0, 12)) {
    const a = assignmentsByStep(scheduleSteps(recipe, 2));
    const b = assignmentsByStep(scheduleSteps(recipe, 2));
    assert.deepEqual(b, a, `${recipe.id} scheduled differently on a second run`);
  }
});

test("every step is given to exactly one cook", () => {
  for (const recipe of recipes) {
    const schedule = scheduleSteps(recipe, 2);
    assert.equal(schedule.assignments.length, recipe.steps.length, `${recipe.id}`);
    assert.equal(new Set(schedule.assignments.map((a) => a.step)).size, recipe.steps.length);
    for (const a of schedule.assignments) assert.ok(a.cook >= 1 && a.cook <= 2);
  }
});

test("a recipe whose dependencies loop is scheduled one after another rather than hanging", () => {
  const looped = recipeOf([
    { order: 1, dur_s: 300, depends_on: [2] },
    { order: 2, dur_s: 300, depends_on: [1] },
  ]);
  const schedule = scheduleSteps(looped, 2);
  assert.equal(schedule.assignments.length, 2, "a hand-edited recipe degrades to a list, not to nothing");
});

// --- the session side ---------------------------------------------------------------------------

test("each cook is given their own steps, and only their own", () => {
  const recipe = recipeOf([{ order: 1, dur_s: 600 }, { order: 2, dur_s: 600 }]);
  const schedule = scheduleSteps(recipe, 2);
  const s = startSession({ id: "s", userId: "u", recipe, now: T0, cooks: 2, assignments: assignmentsByStep(schedule) });
  const one = currentStepFor(s, recipe, 1).current_step;
  const two = currentStepFor(s, recipe, 2).current_step;
  assert.notEqual(one, two, "two people are not sent to the same pot");
  assert.deepEqual([one, two].sort(), [1, 2]);
});

test("a cook with nothing they can start yet is told what they are waiting on", () => {
  const recipe = recipeOf([{ order: 1, dur_s: 600 }, { order: 2, dur_s: 600, depends_on: [1] }]);
  // Force the split so cook 2 owns the dependent step.
  const s = startSession({ id: "s", userId: "u", recipe, now: T0, cooks: 2, assignments: { 1: 1, 2: 2 } });
  const track = currentStepFor(s, recipe, 2);
  assert.equal(track.current_step, 0, "there is nothing they can begin");
  assert.deepEqual(track.waiting_for, [1], "and the reason is named");
});

test("finishing the blocking step releases the other cook without anybody asking twice", () => {
  const recipe = recipeOf([{ order: 1, dur_s: 600 }, { order: 2, dur_s: 600, depends_on: [1] }]);
  let s = startSession({ id: "s", userId: "u", recipe, now: T0, cooks: 2, assignments: { 1: 1, 2: 2 } });
  s = advance(s, recipe, { now: at(0), cook: 1 }).session;   // cook 1 starts step 1
  assert.equal(currentStepFor(s, recipe, 2).current_step, 0, "still nothing for cook 2");
  s = advance(s, recipe, { now: at(10), cook: 1 }).session;  // cook 1 finishes step 1
  assert.equal(currentStepFor(s, recipe, 2).current_step, 2, "cook 2 can start, worked out rather than pushed");
});

test("the second cook's first word does not tick off a step they were never given", () => {
  // Cook 1 has already left the mise en place, so the session says "cooking". Cook 2 has not, and
  // their first `next` is them picking up a knife rather than putting something down.
  const recipe = recipeOf([{ order: 1, dur_s: 600 }, { order: 2, dur_s: 600 }]);
  let s = startSession({ id: "s", userId: "u", recipe, now: T0, cooks: 2, assignments: { 1: 2, 2: 1 } });
  s = advance(s, recipe, { now: at(0), cook: 1 }).session;
  assert.deepEqual(s.completed_steps, [], "leaving the mise en place completes nothing");
  const second = advance(s, recipe, { now: at(1), cook: 2 });
  assert.deepEqual(second.session.completed_steps, [], "and that is true for each of them separately");
  assert.equal(second.step?.order, 1, "cook 2 is given their own first step, not somebody else's second");
});

test("the session is done when nobody has anything left, not when one of them stops", () => {
  const recipe = recipeOf([{ order: 1, dur_s: 600 }, { order: 2, dur_s: 600 }]);
  let s = startSession({ id: "s", userId: "u", recipe, now: T0, cooks: 2, assignments: { 1: 1, 2: 2 } });
  s = advance(s, recipe, { now: at(0), cook: 1 }).session;
  const first = advance(s, recipe, { now: at(10), cook: 1 });
  s = first.session;
  assert.equal(first.finished, false, "cook 1 is done; the dinner is not");
  assert.equal(allDone(s, recipe), false);
  s = advance(s, recipe, { now: at(1), cook: 2 }).session;
  const last = advance(s, recipe, { now: at(11), cook: 2 });
  assert.equal(last.finished, true);
  assert.equal(allDone(last.session, recipe), true);
});

test("one cook behaves exactly as it always did: every step, in order, all of them theirs", () => {
  for (const recipe of recipes) {
    let s = startSession({ id: "solo", userId: "u", recipe, now: T0 });
    const seen: number[] = [];
    let guard = 0;
    while (s.state !== "finished") {
      const r = advance(s, recipe, { now: at(guard) });
      s = r.session;
      if (r.step) seen.push(r.step.order);
      assert.ok(guard++ <= recipe.steps.length + 1, `${recipe.id} did not finish`);
    }
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b), `${recipe.id} was walked out of order`);
  }
});
