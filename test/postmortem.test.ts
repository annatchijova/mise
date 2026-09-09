// A post-mortem is an invitation to tell a story, which is exactly why this file exists. The log
// witnessed times and transitions; it did not witness the food. These tests hold that line: every
// observation has to be arithmetic over something recorded, and the questions people actually ask
// have to come back unanswered with a reason.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { loadRecipes } from "../src/recipes.ts";
import { advance, finish, note, pause, resume, startSession } from "../src/cook/session.ts";
import { postMortem, spanText } from "../src/cook/postmortem.ts";

const recipes = loadRecipes();
const stew = recipes.find((r) => r.id === "broad-bean-red-lentil-stew")!;
const T0 = "2026-09-05T18:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

/** Walk the whole recipe, spending `perStep` minutes on each. */
function cookThrough(perStep: number[]) {
  let s = startSession({ id: "cook-review", userId: "u1", recipe: stew, now: T0 });
  let clock = 0;
  for (const minutes of perStep) {
    s = advance(s, stew, { now: at(clock) }).session;
    clock += minutes;
  }
  return { session: s, clock };
}

test("the whole cook is measured against what the recipe's own steps add up to", () => {
  const { session, clock } = cookThrough([30, 15, 5, 2, 30]);
  const review = postMortem(finish(session, stew, at(clock)), stew, at(clock));
  assert.equal(review.total_s, clock * 60);
  assert.equal(review.paused_s, 0);
  assert.equal(review.estimated_s, stew.steps.reduce((sum, s) => sum + s.dur_s, 0));
  assert.match(review.observations[0], /from start to finish/);
});

test("a step that overran is named, with both numbers", () => {
  // Step 1 is a 30 minute job. Take 75.
  const { session, clock } = cookThrough([75, 15, 5, 2, 30]);
  const review = postMortem(finish(session, stew, at(clock)), stew, at(clock));
  assert.ok(review.slowest);
  assert.equal(review.slowest.order, 1);
  assert.equal(review.slowest.actual_s, 75 * 60);
  assert.equal(review.slowest.over_by_s, 45 * 60);
  assert.ok(review.observations.some((o) => /Step 1 took/.test(o) && /longer than the recipe expects/.test(o)));
});

test("paused time is taken out of the step it spans, not counted against the cook", () => {
  let s = startSession({ id: "cook-review", userId: "u1", recipe: stew, now: T0 });
  s = advance(s, stew, { now: at(0) }).session;   // on step 1
  s = pause(s, at(10));
  s = resume(s, at(70));                          // an hour away
  s = advance(s, stew, { now: at(75) }).session;  // step 1 done: 15 minutes of actual work
  const review = postMortem(s, stew, at(75));
  const step1 = review.steps.find((x) => x.order === 1)!;
  assert.equal(step1.actual_s, 15 * 60, "ten minutes before the pause and five after");
  assert.equal(review.paused_s, 60 * 60);
  assert.equal(review.cooking_s, review.total_s - review.paused_s);
});

test("a long gap that was not a pause is reported as exactly that", () => {
  let s = startSession({ id: "cook-review", userId: "u1", recipe: stew, now: T0 });
  s = advance(s, stew, { now: at(0) }).session;
  s = advance(s, stew, { now: at(90) }).session;  // ninety minutes, nobody paused anything
  const review = postMortem(s, stew, at(95));
  assert.ok(review.longest_gap);
  assert.equal(review.longest_gap.paused, false);
  assert.ok(review.observations.some((o) => /Nothing moved for/.test(o) && /not paused/.test(o)));
});

test("a step ticked off twice is the one thing that can answer 'did I salt it twice'", () => {
  let s = startSession({ id: "cook-review", userId: "u1", recipe: stew, now: T0 });
  s = advance(s, stew, { now: at(0) }).session;                                                    // to step 1
  s = advance(s, stew, { now: at(30) }).session;                                                   // step 1 done, on step 2
  s = advance(s, stew, { now: at(35), completed_hint: "cook the broad beans separately" }).session; // step 1 claimed done again
  const review = postMortem(s, stew, at(10));
  assert.deepEqual(review.repeated_steps, [1]);
  assert.ok(review.observations.some((o) => /ticked off 2 times/.test(o) && /seasons the dish/.test(o)));
});

test("a swap is reported with what it did to the pantry, because that part was witnessed", () => {
  let s = startSession({ id: "cook-review", userId: "u1", recipe: stew, now: T0 });
  s = advance(s, stew, { now: at(0) }).session;
  s = note(s, stew, { now: at(3), note: "chickpeas instead", used: "chickpea", instead_of: "broad-bean" }).session;
  const review = postMortem(s, stew, at(10));
  assert.ok(review.observations.some((o) => /chickpea instead of broad bean/.test(o) && /pantry count followed/.test(o)));
});

test("the questions people actually ask come back unanswered, with the reason", () => {
  const { session, clock } = cookThrough([30, 15, 5, 2, 30]);
  const review = postMortem(finish(session, stew, at(clock)), stew, at(clock));
  const joined = review.cannot_say.join(" ");
  assert.match(joined, /how much of anything actually went in/);
  assert.match(joined, /how hot the pan was/);
  assert.match(joined, /how it tasted/);
});

test("no observation asserts anything about the food itself", () => {
  const { session, clock } = cookThrough([75, 15, 5, 2, 45]);
  const review = postMortem(finish(session, stew, at(clock)), stew, at(clock));
  for (const o of review.observations) {
    assert.ok(!/tasted|flavour|flavor|salty|burnt|overcooked|delicious|texture/i.test(o), `"${o}" claims something about the food`);
  }
});

test("a session nobody finished still reviews, and says which steps have no times", () => {
  let s = startSession({ id: "cook-review", userId: "u1", recipe: stew, now: T0 });
  s = advance(s, stew, { now: at(0) }).session;
  const review = postMortem(s, stew, at(20));
  assert.ok(review.steps.some((x) => x.actual_s === null), "the steps nobody reached have no duration");
  assert.ok(review.cannot_say.some((c) => /steps you never marked/.test(c)));
  assert.equal(review.finished_at, null);
});

test("every observation is a finished sentence", () => {
  let s = startSession({ id: "cook-review", userId: "u1", recipe: stew, now: T0 });
  s = advance(s, stew, { now: at(0) }).session;
  s = advance(s, stew, { now: at(90) }).session;
  s = advance(s, stew, { now: at(95), completed_hint: "cook the broad beans separately" }).session;
  s = note(s, stew, { now: at(96), note: "swapped", used: "chickpea", instead_of: "broad-bean" }).session;
  for (const o of postMortem(s, stew, at(100)).observations) {
    assert.ok(o.endsWith("."), `"${o}" is not a finished sentence`);
    assert.ok(!/undefined|NaN|\[object/.test(o), `"${o}" leaked a value`);
  }
});

test("durations come out in words a person would use", () => {
  assert.equal(spanText(45), "45 seconds");
  assert.equal(spanText(60), "1 minute");
  assert.equal(spanText(1800), "30 minutes");
  assert.equal(spanText(3600), "1 hour");
  assert.equal(spanText(7800), "2 hours 10 minutes");
});
