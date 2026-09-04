// The cooking session is the part of the demo that has to survive a cut in the video: "pause" —
// a day later, on another device — "where was I?". These tests are written so that each one fails
// if the rule it names is dropped: a timer that forgets it was paused, a deviation treated as an
// error, a deduction that invents a number the book never gave.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { type Recipe, loadRecipes } from "../src/recipes.ts";
import { foldPantry } from "../src/pantry/fold.ts";
import {
  advance, consumptionEvents, finish, matchStep, misePlace, note, pause, resume, scaleMilli,
  startSession, timerViews, view,
} from "../src/cook/session.ts";
import { MemoryCookStore } from "../src/cook/store.ts";

const recipes = loadRecipes();
const stew = recipes.find((r) => r.id === "broad-bean-red-lentil-stew")!;
const T0 = "2026-09-04T18:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

function begin(recipe: Recipe = stew, servings?: number) {
  return startSession({ id: "cook-test", userId: "u1", recipe, servings, now: T0 });
}

test("pause holds the timer where it stopped, and a day away does not move it", () => {
  let s = begin();
  s = advance(s, stew, { now: at(1) }).session;          // step 1: a 30 minute timer starts
  assert.equal(s.current_step, 1);
  s = pause(s, at(11));                                   // ten minutes in
  const paused = timerViews(s, at(11)).find((t) => t.step === 1)!;
  assert.equal(paused.state, "paused");
  assert.equal(paused.remaining_s, 1800 - 600);

  // A day later, on another device. The clock did not run while the session was paused.
  const tomorrow = new Date(Date.parse(T0) + 26 * 3_600_000).toISOString();
  const stillPaused = timerViews(s, tomorrow).find((t) => t.step === 1)!;
  assert.equal(stillPaused.remaining_s, 1200, "a paused timer does not tick");
  const v = view(s, stew, tomorrow);
  assert.equal(v.state, "paused");
  assert.equal(v.step?.order, 1, "and the place is exactly where it was left");
});

test("resuming restarts the clock without giving back the minutes already spent", () => {
  let s = begin();
  s = advance(s, stew, { now: T0 }).session;
  s = pause(s, at(10));
  s = resume(s, at(70));                                  // an hour of pause
  const t = timerViews(s, at(75)).find((x) => x.step === 1)!;
  // 10 minutes before the pause + 5 after it = 15 elapsed, not 75.
  assert.equal(t.elapsed_s, 900);
  assert.equal(t.remaining_s, 900);
  assert.equal(t.state, "running");
});

test("a timer past its duration reports as done and says by how much, instead of going negative in silence", () => {
  let s = begin();
  s = advance(s, stew, { now: T0 }).session;
  const t = timerViews(s, at(40)).find((x) => x.step === 1)!;
  assert.equal(t.state, "done");
  assert.equal(t.overdue_s, 600);
});

test("a hint naming another step is a deviation, not an error, and the work in between is not skipped", () => {
  let s = begin();
  s = advance(s, stew, { now: T0 }).session;               // on step 1
  const r = advance(s, stew, { now: at(5), completed_hint: "I already sauteed the onions and the zucchini" });
  assert.ok(r.deviation, "the jump is recorded");
  assert.equal(r.deviation.kind, "out_of_order");
  assert.ok(r.session.completed_steps.includes(2), "the step they named is marked done");
  assert.equal(r.step?.order, 1, "and we come back for step 1, which nobody has done");
  assert.equal(r.session.state, "cooking", "a deviation never puts the session in an error state");
});

test("a hint nobody can pin to a step is kept as a note and changes nothing", () => {
  let s = begin();
  s = advance(s, stew, { now: T0 }).session;
  const before = s.completed_steps.length;
  const r = advance(s, stew, { now: at(5), completed_hint: "ok" });
  assert.equal(r.unmatched_hint, true);
  assert.equal(r.deviation, null);
  assert.equal(r.session.completed_steps.length, before + 1, "only the current step advances");
  assert.ok(r.session.deviations.some((d) => d.kind === "note" && d.what === "ok"), "but what was said is kept");
});

test("the step matcher refuses to guess: two content words and one clear winner, or nothing", () => {
  assert.equal(matchStep("done", stew), null, "one common word is not evidence");
  assert.equal(matchStep("cook the broad beans separately", stew)?.step, 1);
  // "cooking" appears in more than one step; on its own it settles nothing.
  assert.equal(matchStep("cooking", stew), null);
});

test("the machine is pure: the session handed in is never the session handed back", () => {
  const s = begin();
  const before = JSON.stringify(s);
  const r = advance(s, stew, { now: at(1), completed_hint: "cook the broad beans separately" });
  assert.notEqual(r.session, s);
  assert.equal(JSON.stringify(s), before, "the input session is untouched, arrays included");
});

test("finishing deducts what the recipe stated, scaled, as inferred and never as the customer's word", () => {
  let s = begin(stew, 3);                                  // half of the recipe's 6 servings
  s = finish(s, stew, at(90));
  const { events } = consumptionEvents(s, stew, at(90));
  const beans = events.find((e) => e.ingredient_id === "broad-bean")!;
  assert.equal(beans.type, "consume");
  assert.equal(beans.origin, "recipe_deduction");
  assert.equal(beans.confidence, "inferred", "the system worked this out; the customer never said it");
  assert.equal(beans.qty_milli, 250_000, "500 g for six is 250 g for three, in integers");
});

test("an amount the book never gave is consumed as unknown, and the pantry line says so", () => {
  const s = finish(begin(), stew, at(90));
  const { events, skipped } = consumptionEvents(s, stew, at(90));
  // Water, salt, paprika: measured to taste. Not deducted, and the reason is reported.
  assert.ok(skipped.some((x) => x.ingredient_id === "salt"), "salt to taste is not an amount to subtract");
  assert.ok(!events.some((e) => e.ingredient_id === "salt"));

  // Now a line where the amount is genuinely unknown rather than "to taste": corn, 1 pc, is stated,
  // so use a pantry that holds an unknown amount and check the fold keeps it unknown.
  const stocked = [
    { ts: T0, seq: 0, type: "add" as const, ingredient_id: "corn", qty_milli: null, unit: "pc" as const, origin: "voice" as const, confidence: "confirmed" as const, location: "pantry", expires_on: null, external_id: null, source_device: null },
  ];
  const { items } = foldPantry([...stocked, ...events.filter((e) => e.ingredient_id === "corn")], { now: at(90) });
  const corn = items.find((i) => i.ingredient_id === "corn")!;
  assert.equal(corn.qty_known, false, "an unknown total stays unknown after cooking with it");
  assert.equal(corn.confidence, "inferred", "and it is only as certain as its least certain part");
});

test("a swap recorded while cooking redirects the deduction to what was actually used", () => {
  let s = begin();
  s = advance(s, stew, { now: T0 }).session;
  s = note(s, { now: at(5), note: "I used chickpeas instead of the broad beans", used: "chickpea", instead_of: "broad-bean" }).session;
  const { events } = consumptionEvents(s, stew, at(90));
  assert.ok(events.some((e) => e.ingredient_id === "chickpea"), "the chickpeas come off the shelf");
  assert.ok(!events.some((e) => e.ingredient_id === "broad-bean"), "the broad beans are left alone");
});

test("finishing twice does not eat the pantry twice", () => {
  const s = finish(begin(), stew, at(90));
  const first = consumptionEvents(s, stew, at(90)).events;
  const second = consumptionEvents(s, stew, at(95)).events;   // a retried call, a double tap
  const { items } = foldPantry(
    [
      { ts: T0, seq: 0, type: "add" as const, ingredient_id: "red-lentil", qty_milli: 1_000_000, unit: "g" as const, origin: "voice" as const, confidence: "confirmed" as const, location: "pantry", expires_on: null, external_id: null, source_device: null },
      ...first, ...second,
    ],
    { now: at(95) },
  );
  const lentils = items.find((i) => i.ingredient_id === "red-lentil")!;
  assert.equal(lentils.qty, 750, "1000 g minus one deduction of 250, not two");
});

test("scaling stays in integers, so a doubled recipe never arrives with a rounding error", () => {
  assert.equal(scaleMilli(500_000, 3, 6), 250_000);
  assert.equal(scaleMilli(1_000, 1, 3), 333, "a third of a gram rounds once, here, and never again");
  const mise = misePlace(stew, 12);
  assert.equal(mise.find((m) => m.ingredient_id === "broad-bean")?.qty, 1000);
  assert.equal(mise.find((m) => m.ingredient_id === "water")?.qty, null, "an amount the book never gave stays null");
});

test("the store keeps one live session per user and hands back the newest", async () => {
  const store = new MemoryCookStore();
  const first = begin();
  await store.put(first);
  assert.equal((await store.active("u1"))?.id, "cook-test");
  await store.put(finish(first, stew, at(90)));
  assert.equal(await store.active("u1"), null, "a finished session is not something to resume");
  assert.equal((await store.history("u1")).length, 1, "but it is still on the record");
});

test("every step of every recipe can be walked start to finish without the machine stalling", () => {
  for (const recipe of recipes) {
    let s = startSession({ id: `walk-${recipe.id}`, userId: "u1", recipe, now: T0 });
    let guard = 0;
    while (s.state !== "finished") {
      const r = advance(s, recipe, { now: at(guard) });
      s = r.session;
      assert.ok(guard++ <= recipe.steps.length + 1, `${recipe.id} did not finish in ${recipe.steps.length} steps`);
    }
    assert.deepEqual(s.completed_steps, recipe.steps.map((x) => x.order).sort((a, b) => a - b), `${recipe.id} left a step behind`);
  }
});
