// The confidence model was a disclaimer until this file: the pantry knew it was unsure and never
// did anything about it. These tests are about the two things that turn a badge into a behaviour —
// one figure a person can act on, and questions the server writes rather than the narrator invents.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { PantryItem } from "../src/pantry/fold.ts";
import { auditQuestions, confidenceOf, confidenceSentence } from "../src/pantry/audit.ts";

const NOW = "2026-09-10T12:00:00.000Z";

function line(over: Partial<PantryItem> = {}): PantryItem {
  return {
    ingredient_id: "tofu", unit: "pc", location: "fridge", qty: 2, qty_known: true,
    confidence: "confirmed", age_days: 0,
    expires_on: null, expiry_estimated_on: null, expiry_source: "unknown", expiry_note: null, expiry_match: null,
    days_to_expiry: null, freshness: "unknown", origins: ["voice"], last_event_ts: NOW,
    ...over,
  };
}

test("the figure counts only what rests on something a person said, with an amount", () => {
  const c = confidenceOf([
    line({ ingredient_id: "tofu" }),                                        // confirmed, counted
    line({ ingredient_id: "onion", qty: null, qty_known: false }),           // confirmed, uncounted
    line({ ingredient_id: "spinach", confidence: "inferred" }),              // a device said it
    line({ ingredient_id: "lentil", confidence: "stale" }),                  // nobody lately
  ]);
  assert.equal(c.total, 4);
  assert.equal(c.score, 25, "one of four lines is both confirmed and counted");
  assert.equal(c.confirmed, 2);
  assert.equal(c.unknown_amount, 1);
  assert.match(c.score_basis, /confirmed and have an amount/);
});

test("the figure is strict on purpose: a flattering number would be no use", () => {
  // Everything the fridge reported, none of it counted. That kitchen is not 100% sure of itself.
  const c = confidenceOf([
    line({ ingredient_id: "a", confidence: "inferred", qty: null, qty_known: false }),
    line({ ingredient_id: "b", confidence: "inferred", qty: null, qty_known: false }),
  ]);
  assert.equal(c.score, 0);
  assert.equal(c.inferred_pct, 100);
});

test("an empty pantry is zero percent and says so without arithmetic", () => {
  const c = confidenceOf([]);
  assert.equal(c.score, 0);
  assert.match(confidenceSentence(c), /nothing to be sure or unsure about/);
});

test("food past a date somebody gave is the first thing asked about", () => {
  const questions = auditQuestions([
    line({ ingredient_id: "onion", confidence: "stale", age_days: 20 }),
    line({ ingredient_id: "tofu", days_to_expiry: -2, expires_on: "2026-09-08", expiry_source: "stated" }),
  ]);
  assert.equal(questions[0].ingredient_id, "tofu");
  assert.ok(questions[0].reasons.includes("past_date"));
  assert.match(questions[0].question, /past the date you gave/);
});

test("food past a date the table only estimated is asked about differently", () => {
  const [q] = auditQuestions([line({ ingredient_id: "spinach", days_to_expiry: -1, expiry_estimated_on: "2026-09-09", expiry_source: "estimated" })]);
  assert.ok(q.reasons.includes("past_estimate"));
  assert.match(q.question, /nobody gave it a date/, "the hedge survives all the way into the question");
});

test("reasons compound, because they are separate ways of being wrong about one shelf", () => {
  const both = auditQuestions([
    line({ ingredient_id: "a", qty: null, qty_known: false }),
    line({ ingredient_id: "b", qty: null, qty_known: false, confidence: "stale", age_days: 30 }),
  ]);
  assert.equal(both[0].ingredient_id, "b", "unknown and unconfirmed outweighs unknown alone");
  assert.ok(both[0].weight > both[1].weight);
});

test("a line nothing is wrong with is never asked about", () => {
  assert.deepEqual(auditQuestions([line()]), []);
});

test("the same pantry asks the same questions in the same order", () => {
  const items = [
    line({ ingredient_id: "b", confidence: "stale", age_days: 9 }),
    line({ ingredient_id: "a", confidence: "stale", age_days: 9 }),
    line({ ingredient_id: "c", confidence: "inferred" }),
  ];
  const first = auditQuestions(items).map((q) => q.ingredient_id);
  const second = auditQuestions([...items].reverse()).map((q) => q.ingredient_id);
  assert.deepEqual(second, first, "a person answering an audit is entitled to it not reshuffling");
  assert.deepEqual(first, ["a", "b", "c"]);
});

test("the limit is a slice off the top, and the total still says how many there were", () => {
  const items = Array.from({ length: 9 }, (_, n) => line({ ingredient_id: `x${n}`, confidence: "stale", age_days: 10 }));
  assert.equal(auditQuestions(items, { limit: 3 }).length, 3);
  assert.equal(auditQuestions(items, { limit: 20 }).length, 9);
});

test("narrowing to one kind of doubt only returns lines that carry it", () => {
  const items = [
    line({ ingredient_id: "a", qty: null, qty_known: false }),
    line({ ingredient_id: "b", confidence: "stale", age_days: 12 }),
  ];
  const only = auditQuestions(items, { only: "unknown_amount" });
  assert.equal(only.length, 1);
  assert.equal(only[0].ingredient_id, "a");
});

test("every question is a question, and none of them leaks a value", () => {
  const items = [
    line({ ingredient_id: "red-lentil", confidence: "stale", age_days: 14, location: "pantry" }),
    line({ ingredient_id: "tofu", qty: null, qty_known: false }),
    line({ ingredient_id: "spinach", confidence: "inferred", origins: ["simulated"] }),
    line({ ingredient_id: "onion", days_to_expiry: -3, expiry_source: "stated", expires_on: "2026-09-07" }),
  ];
  for (const q of auditQuestions(items, { limit: 20 })) {
    assert.ok(q.question.endsWith("?"), `"${q.question}" is not a question`);
    assert.ok(!/undefined|null|NaN|\[object/.test(q.question), `"${q.question}" leaked a value`);
    assert.ok(!q.question.includes("-"), `"${q.question}" reads out a raw id`);
  }
});

test("a question names what actually put the line there, and never calls a receipt a device", () => {
  // The pantry is careful never to tell somebody a device said what they said themselves. The same
  // care belongs in the question: "did a device say this?" about their own receipt is a small lie,
  // and it is also the harder question to answer.
  const asked = (origins: string[]) =>
    auditQuestions([line({ confidence: "inferred", origins })], { limit: 1 })[0].question;

  assert.match(asked(["receipt"]), /came off a receipt/);
  assert.match(asked(["receipt"]), /bought but not that it is still there/);
  assert.match(asked(["simulated"]), /came from the fridge/);
  assert.match(asked(["barcode"]), /came off a barcode/);
  assert.match(asked(["recipe_deduction"]), /worked out from your cooking/);
  assert.match(asked(["checkout"]), /came from an order/);

  for (const origin of ["receipt", "recipe_deduction", "checkout", "barcode"]) {
    assert.doesNotMatch(asked([origin]), /device/, `a ${origin} is not a device`);
  }
});
