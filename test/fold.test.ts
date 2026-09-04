// The fold is where the pantry's honesty is either enforced or lost, so these tests are written to
// fail loudly: each one breaks if the rule it names is dropped from src/pantry/fold.ts.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { type PantryEvent, type StoredConfidence, toMilli, weaker } from "../src/pantry/events.ts";
import { foldPantry } from "../src/pantry/fold.ts";

const NOW = "2026-09-04T12:00:00.000Z";

let counter = 0;
function ev(over: Partial<PantryEvent> = {}): PantryEvent {
  counter += 1;
  return {
    ts: "2026-09-04T08:00:00.000Z",
    seq: counter,
    type: "add",
    ingredient_id: "tofu",
    qty_milli: toMilli(1),
    unit: "pc",
    origin: "voice",
    confidence: "confirmed",
    location: "fridge",
    expires_on: null,
    external_id: null,
    source_device: null,
    ...over,
  };
}

test("quantities are exact: three additions that would drift in floating point do not", () => {
  const events = [0.1, 0.1, 0.1].map((q) => ev({ ingredient_id: "red-lentil", unit: "kg", qty_milli: toMilli(q) }));
  const { items } = foldPantry(events, { now: NOW });
  assert.equal(items.length, 1);
  // 0.1 + 0.2 === 0.30000000000000004 in floats; the ledger sums integers, so this is exact.
  assert.equal(items[0].qty, 0.3);
  assert.equal(items[0].qty_known, true);
});

test("toMilli refuses a quantity finer than the ledger can hold rather than rounding it away", () => {
  assert.equal(toMilli(0.5), 500);
  assert.equal(toMilli(null), null);
  assert.throws(() => toMilli(0.00049), RangeError);
});

test("an unknown quantity stays unknown and is never reported as zero", () => {
  const { items } = foldPantry([ev({ qty_milli: null })], { now: NOW });
  assert.equal(items.length, 1);
  assert.equal(items[0].qty, null);
  assert.equal(items[0].qty_known, false);
});

test("one unknown part makes the whole total unknown", () => {
  const { items } = foldPantry([ev({ qty_milli: toMilli(2) }), ev({ qty_milli: null })], { now: NOW });
  assert.equal(items[0].qty_known, false);
  assert.equal(items[0].qty, null);
});

test("a total is only as certain as its least certain part", () => {
  assert.equal(weaker("confirmed", "inferred"), "inferred");
  assert.equal(weaker("inferred", "stale"), "stale");
  const { items } = foldPantry(
    [ev({ confidence: "confirmed" }), ev({ confidence: "inferred", origin: "simulated" })],
    { now: NOW },
  );
  assert.equal(items[0].confidence, "inferred");
  assert.deepEqual(items[0].origins, ["simulated", "voice"]);
});

test("the same external_id delivered twice is folded once, and the duplicate is reported", () => {
  const twice = [
    ev({ external_id: "fridge:reading-1:tofu", qty_milli: toMilli(2) }),
    ev({ external_id: "fridge:reading-1:tofu", qty_milli: toMilli(2) }),
  ];
  const { items, duplicates } = foldPantry(twice, { now: NOW });
  assert.equal(duplicates, 1);
  assert.equal(items[0].qty, 2);
});

test("stale is derived from the clock, not stored", () => {
  const old = ev({ ts: "2026-08-20T08:00:00.000Z", confidence: "confirmed" });
  const fresh = foldPantry([old], { now: NOW, staleAfterDays: 30 }).items[0];
  const stale = foldPantry([old], { now: NOW, staleAfterDays: 7 }).items[0];
  assert.equal(fresh.confidence, "confirmed");
  assert.equal(stale.confidence, "stale");
  assert.equal(stale.age_days, 15);
});

test("consume subtracts, and an emptied line leaves the pantry", () => {
  const events = [
    ev({ qty_milli: toMilli(3) }),
    ev({ type: "consume", qty_milli: toMilli(3), origin: "recipe_deduction", confidence: "inferred" }),
  ];
  assert.deepEqual(foldPantry(events, { now: NOW }).items, []);
});

test("consuming more than the ledger holds floors at zero instead of going negative", () => {
  const events = [ev({ qty_milli: toMilli(1) }), ev({ type: "consume", qty_milli: toMilli(5) })];
  assert.deepEqual(foldPantry(events, { now: NOW }).items, []);
});

test("remove wipes the line, including what we believed about it", () => {
  const events = [
    ev({ qty_milli: toMilli(2), expires_on: "2026-09-05" }),
    ev({ type: "remove", ts: "2026-09-04T09:00:00.000Z" }),
  ];
  assert.deepEqual(foldPantry(events, { now: NOW }).items, []);
});

test("correct supersedes the history of its line", () => {
  const events = [
    ev({ qty_milli: toMilli(2), confidence: "inferred", origin: "simulated" }),
    ev({ type: "correct", ts: "2026-09-04T09:00:00.000Z", qty_milli: toMilli(5), confidence: "confirmed" }),
  ];
  const { items } = foldPantry(events, { now: NOW });
  assert.equal(items[0].qty, 5);
  assert.equal(items[0].confidence, "confirmed");
  assert.deepEqual(items[0].origins, ["voice"]);
});

test("units are never converted into each other", () => {
  const events = [
    ev({ ingredient_id: "flour-0000", unit: "cup", qty_milli: toMilli(2) }),
    ev({ ingredient_id: "flour-0000", unit: "g", qty_milli: toMilli(500) }),
  ];
  const { items } = foldPantry(events, { now: NOW });
  assert.equal(items.length, 2, "two units are two honest lines, not one invented sum");
});

test("locations are separate lines, so a garage fridge is its own place", () => {
  const events = [ev({ location: "fridge" }), ev({ location: "other:garage" })];
  const { items } = foldPantry(events, { now: NOW });
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.location).sort(), ["fridge", "other:garage"]);
});

test("expiry drives both freshness and order", () => {
  const events = [
    ev({ ingredient_id: "carrot", expires_on: "2026-09-30" }),
    ev({ ingredient_id: "tofu", expires_on: "2026-09-05" }),
    ev({ ingredient_id: "spinach", expires_on: "2026-09-01" }),
    ev({ ingredient_id: "rice", expires_on: null }),
    ev({ ingredient_id: "tomato", expires_on: "2026-09-07" }),
  ];
  const { items } = foldPantry(events, { now: NOW });
  assert.deepEqual(items.map((i) => i.ingredient_id), ["spinach", "tofu", "tomato", "carrot", "rice"]);
  assert.deepEqual(items.map((i) => i.freshness), ["expired", "urgent", "soon", "fresh", "unknown"]);
  assert.equal(items[1].days_to_expiry, 1);
  assert.equal(items[0].days_to_expiry, -3);
});

test("the earliest stated expiry wins for a line", () => {
  const events = [
    ev({ expires_on: "2026-09-20" }),
    ev({ expires_on: "2026-09-06" }),
    ev({ expires_on: null }),
  ];
  assert.equal(foldPantry(events, { now: NOW }).items[0].expires_on, "2026-09-06");
});

test("the fold does not depend on the order events arrive in", () => {
  const events: PantryEvent[] = [
    ev({ ingredient_id: "tofu", qty_milli: toMilli(2), expires_on: "2026-09-05" }),
    ev({ ingredient_id: "carrot", qty_milli: toMilli(4) }),
    ev({ ingredient_id: "tofu", type: "consume", qty_milli: toMilli(1), ts: "2026-09-04T10:00:00.000Z" }),
    ev({ ingredient_id: "rice", unit: "g", qty_milli: toMilli(500), confidence: "inferred", origin: "checkout" }),
  ];
  const forward = foldPantry(events, { now: NOW });
  const backward = foldPantry([...events].reverse(), { now: NOW });
  assert.deepEqual(backward, forward);
  assert.equal(JSON.stringify(backward), JSON.stringify(forward), "byte-identical, not merely equal");
});

test("negative control: a fold that ignored confidence would pass none of the above", () => {
  // If foldPantry stopped tracking confidence and always answered "confirmed", this assertion is the
  // one that catches it, independently of the weaker() unit test.
  const inferredOnly: StoredConfidence = "inferred";
  const { items } = foldPantry([ev({ confidence: inferredOnly, origin: "simulated" })], { now: NOW });
  assert.notEqual(items[0].confidence, "confirmed");
});
