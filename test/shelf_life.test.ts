// The shelf-life table is advice, and the whole risk of having it is that advice starts reading as
// fact. These tests are almost entirely about that one boundary: a number this table produced must
// never be indistinguishable from a date somebody actually gave.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { type PantryEvent, toMilli } from "../src/pantry/events.ts";
import { foldPantry } from "../src/pantry/fold.ts";
import { buildShelfLife, loadShelfLife, rolesFromRecipes } from "../src/pantry/shelf_life.ts";
import { loadRecipes } from "../src/recipes.ts";
import { whyExpiring } from "../src/plan/planner.ts";

const recipes = loadRecipes();
const roles = rolesFromRecipes(recipes);
const table = loadShelfLife();
const shelfLife = buildShelfLife(table, (id) => roles.get(id) ?? null);

const NOW = "2026-09-10T12:00:00.000Z";
let counter = 0;
function ev(over: Partial<PantryEvent> = {}): PantryEvent {
  counter += 1;
  return {
    ts: "2026-09-08T08:00:00.000Z",
    seq: counter,
    type: "add",
    ingredient_id: "spinach",
    qty_milli: toMilli(1),
    unit: "bunch",
    origin: "voice",
    confidence: "confirmed",
    location: "fridge",
    expires_on: null,
    external_id: null,
    source_device: null,
    ...over,
  };
}

test("without a table the fold behaves exactly as it did: no dates but the ones stated", () => {
  const { items } = foldPantry([ev()], { now: NOW });
  assert.equal(items[0].expiry_source, "unknown");
  assert.equal(items[0].expiry_estimated_on, null);
  assert.equal(items[0].days_to_expiry, null);
});

test("with a table, food nobody dated gets an estimate that is labelled as one", () => {
  const { items } = foldPantry([ev()], { now: NOW, shelfLife });
  const spinach = items[0];
  assert.equal(spinach.expires_on, null, "no date was ever stated, and none is invented in that field");
  assert.equal(spinach.expiry_source, "estimated");
  assert.equal(spinach.expiry_estimated_on, "2026-09-12", "four days from the day it arrived");
  assert.equal(spinach.days_to_expiry, 2);
  assert.equal(spinach.expiry_match, "ingredient+location");
});

test("a date somebody stated always beats the table, and stays the stated one", () => {
  const { items } = foldPantry([ev({ expires_on: "2026-09-20" })], { now: NOW, shelfLife });
  assert.equal(items[0].expires_on, "2026-09-20");
  assert.equal(items[0].expiry_source, "stated");
  assert.equal(items[0].expiry_estimated_on, null, "the table is not even consulted");
  assert.equal(items[0].days_to_expiry, 10);
});

test("the shelf life counts from when the food arrived, not from the last time you used some", () => {
  const arrived = ev({ ts: "2026-09-08T08:00:00.000Z", qty_milli: toMilli(2) });
  const usedSome = ev({ ts: "2026-09-10T08:00:00.000Z", type: "consume", qty_milli: toMilli(1) });
  const { items } = foldPantry([arrived, usedSome], { now: NOW, shelfLife });
  // Cooking with half the spinach on Thursday does not make the other half younger.
  assert.equal(items[0].expiry_estimated_on, "2026-09-12");
});

test("a correction restarts the clock, because it is a fresh statement about the food", () => {
  const old = ev({ ts: "2026-09-01T08:00:00.000Z" });
  const corrected = ev({ ts: "2026-09-09T08:00:00.000Z", type: "correct", qty_milli: toMilli(1) });
  const { items } = foldPantry([old, corrected], { now: NOW, shelfLife });
  assert.equal(items[0].expiry_estimated_on, "2026-09-13", "four days from the correction, not from the first sighting");
});

test("the lookup widens from the ingredient to its role, and says which row answered", () => {
  // Nobody wrote a row for jalapenos. The spice rows answer, and the match says so.
  const { items } = foldPantry([ev({ ingredient_id: "jalapeno", unit: "pc", location: "pantry" })], { now: NOW, shelfLife });
  assert.equal(items[0].expiry_source, "estimated");
  assert.ok(["role+location", "role"].includes(items[0].expiry_match ?? ""), `got ${items[0].expiry_match}`);
});

test("a place the table does not know about gets no estimate, because how long food keeps depends on where", () => {
  // "The second fridge in the garage" is a location the ledger allows and this table has never seen.
  // A lemon keeps three weeks in a fridge and a week on a counter; in an unnamed place we do not
  // know which, and answering anyway would be the whole failure this table is arranged against.
  assert.equal(shelfLife("lemon", "other:the cabin"), null);
  const { items } = foldPantry([ev({ ingredient_id: "lemon", unit: "pc", location: "other:the cabin" })], { now: NOW, shelfLife });
  assert.equal(items[0].expiry_source, "unknown");
  // The same lemon in a place the table does know is answered without hesitation.
  assert.equal(shelfLife("lemon", "fridge")?.days, 21);
});

test("an ingredient the table has nothing for gets no date at all, rather than a default", () => {
  const answer = shelfLife("something-nobody-cooks-with", "spaceship");
  assert.equal(answer, null);
  const { items } = foldPantry([ev({ ingredient_id: "something-nobody-cooks-with", location: "spaceship" })], { now: NOW, shelfLife });
  assert.equal(items[0].expiry_source, "unknown");
});

test("the freezer answers for anything, because that is the one row that can", () => {
  const answer = shelfLife("some-leftover", "freezer");
  assert.ok(answer !== null);
  assert.equal(answer.match, "location");
  assert.match(answer.note ?? "", /pause, not a preservative/);
});

test("the reason the planner gives hedges an estimate and quotes a stated date", () => {
  assert.match(whyExpiring("tofu", 1, "stated"), /goes off tomorrow/);
  assert.ok(!/table|reckoning|roughly/.test(whyExpiring("tofu", 1, "stated")));
  assert.match(whyExpiring("tofu", 3, "estimated"), /shelf-life table/);
  assert.match(whyExpiring("tofu", 3, "estimated"), /nobody gave it a date/);
});

test("every row's days is a whole number, and nothing claims to keep for a decade by accident", () => {
  for (const e of table.entries) {
    assert.ok(Number.isInteger(e.days) && e.days > 0, `${e.ingredient ?? e.role}: ${e.days}`);
    assert.ok(e.days <= 3650, `${e.ingredient ?? e.role}: ${e.days} days is a typo, not a shelf life`);
  }
});

test("no row for a named ingredient also sets a role, which would make it unreachable", () => {
  for (const e of table.entries) {
    if (e.ingredient !== null) assert.equal(e.role ?? null, null, `${e.ingredient} sets both`);
  }
});
