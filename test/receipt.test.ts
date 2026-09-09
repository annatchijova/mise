// A receipt is the messiest useful thing a kitchen produces, so these tests are mostly about the
// boundary between what the grammar reads and what it refuses to. The rule under all of them: every
// line goes somewhere a person can see, and nothing is invented from a line we did not understand.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildResolver } from "../src/integrations/aliases.ts";
import { type ReceiptPayload, parseReceipt, receiptDate, receiptSource } from "../src/integrations/receipt.ts";
import { runSource } from "../src/integrations/types.ts";

const FIXTURE = readFileSync(new URL("./fixtures/receipt.txt", import.meta.url), "utf8");
const NOW = "2026-09-06T12:00:00.000Z";
const BOUGHT = "2026-09-04T18:42:00.000Z";

const resolve = buildResolver(
  { onion: "onion", chickpeas: "chickpea", "red lentils": "red-lentil", bananas: "banana", "olive oil": "olive-oil", tomatoes: "tomato", carrot: "carrot" },
  ["onion", "chickpea", "red-lentil", "banana", "olive-oil", "tomato", "carrot"],
);

const read = (over: Partial<ReceiptPayload> = {}) =>
  runSource(receiptSource, { text: FIXTURE, purchased_at: BOUGHT, merchant: "La Esquina", ...over }, { userId: "u", now: NOW, resolve });

const byLine = (text: string) => parseReceipt(text).purchases[0];

test("every line of a receipt goes somewhere: nothing is dropped in silence", () => {
  const parsed = parseReceipt(FIXTURE);
  const seen = [...parsed.purchases.map((p) => p.line), ...parsed.skipped.map((s) => s.line)].sort((a, b) => a - b);
  assert.deepEqual(seen, FIXTURE.split("\n").map((_, i) => i + 1), "each line appears exactly once, in one place or the other");
});

test("a line with no price is not a purchase, which disposes of everything around the shopping", () => {
  // The shop's name, its address, its footer: no list of things to look for, one rule about what a
  // receipt is. A shop that prints prices on their own line breaks this loudly, not quietly.
  const parsed = parseReceipt(FIXTURE);
  const noPrice = parsed.skipped.filter((s) => s.rule === "no_price").map((s) => s.text);
  assert.ok(noPrice.some((t) => t.includes("SUPERMERCADO")));
  assert.ok(noPrice.some((t) => t.includes("Rivadavia")));
  assert.equal(parsed.purchases.length, 8, "the eight things that were actually bought");
});

test("the price comes off before the pack size is looked for", () => {
  // `CHICKPEAS 400G 1.29` must not read 1.29 as a quantity, and must not read 400 as a price.
  const line = byLine("CHICKPEAS 400G                 1.29");
  assert.equal(line.name, "chickpeas");
  assert.equal(line.qty_milli, 400_000);
  assert.equal(line.unit, "g");
  assert.equal(line.price_cents, 129);
});

test("kilos and litres are converted at the boundary, so the pantry has one line and not two", () => {
  assert.deepEqual(
    { q: byLine("CARROT 1KG   1.75").qty_milli, u: byLine("CARROT 1KG   1.75").unit },
    { q: 1_000_000, u: "g" },
  );
  assert.equal(byLine("OLIVE OIL 1 L   8.99").unit, "ml");
});

test("a count is a count of pieces", () => {
  const line = byLine("2 X ONION   1.98");
  assert.equal(line.name, "onion");
  assert.equal(line.qty_milli, 2000);
  assert.equal(line.unit, "pc");
});

test("a printed weight beats a count rather than multiplying it", () => {
  // "2 X CHICKPEAS 400G" bought 400 g twice. That two packs is 800 g is a fact about packaging we do
  // not have, so the amount wins: understating beats inventing.
  const line = byLine("2 X CHICKPEAS 400G   2.58");
  assert.equal(line.qty_milli, 400_000);
  assert.equal(line.unit, "g");
});

test("a line with no amount printed is 'some, amount unknown' and never a guess", () => {
  const line = byLine("TOMATOES   3.40");
  assert.equal(line.qty_milli, null, "the receipt says you bought tomatoes and does not say how many");
  assert.equal(line.price_cents, 340);
});

test("the shop showing its working is removed, not read", () => {
  // 1.84 / 2.19 is 0.84 kg, and we could work that out. We are not entitled to: a quantity nobody
  // printed is one we calculated, and a pantry that calculates is a pantry that can be wrong quietly.
  const line = byLine("BANANAS 0.842 kg @ 2.19/kg     1.84");
  assert.equal(line.name, "bananas");
  assert.equal(line.qty_milli, 842_000, "the printed weight, not the divided one");
  assert.equal(line.price_cents, 184);
});

test("a unit we do not convert produces no amount rather than a wrong one", () => {
  // An ounce is not exactly anything useful without knowing what it measures.
  const line = byLine("FLOUR 16 OZ   2.40");
  assert.equal(line.qty_milli, null);
  assert.match(line.name, /flour/);
});

test("a food nothing recognises is reported with its raw name, never dropped and never guessed", () => {
  const reading = read();
  assert.deepEqual(reading.unmapped.map((u) => u.raw_name), ["kimchi"]);
  assert.match(reading.unmapped[0].reason, /line 15/);
  assert.ok(!reading.events.some((e) => e.ingredient_id.includes("kimchi")));
});

test("a receipt may only say inferred, however sure it looks", () => {
  // It proves the shop sold it, not that it reached this kitchen. `inferred` is a hook, not a hedge:
  // the pantry audit asks about inferred lines, and the person answering is what makes it confirmed.
  assert.equal(receiptSource.maxConfidence, "inferred");
  assert.ok(read().events.every((e) => e.confidence === "inferred"));
});

test("events are stamped when the shopping happened, not when the receipt was pasted", () => {
  const reading = read();
  assert.ok(reading.events.every((e) => e.ts === BOUGHT), "a receipt is often days old");
  assert.ok(reading.events.every((e) => e.origin === "receipt"));
});

test("the receipt's own line numbers order the ledger, so re-reading one lands the same events", () => {
  const a = read();
  const b = read();
  assert.deepEqual(a.events, b.events, "the same receipt read twice is the same events");
  assert.deepEqual(a.events.map((e) => e.external_id), b.events.map((e) => e.external_id));
  assert.equal(new Set(a.events.map((e) => e.external_id)).size, a.events.length, "and each is distinct");
});

test("a receipt never states a use-by date, so it never claims one", () => {
  assert.ok(read().events.every((e) => e.expires_on === null), "the shelf-life table estimates, and says it did");
});

test("where the shopping was put away is the person's to say, with a stated default", () => {
  assert.ok(read().events.every((e) => e.location === "pantry"));
  assert.ok(read({ location: "freezer" }).events.every((e) => e.location === "freezer"));
});

test("a payload that is not a receipt is the sender's error, said plainly", () => {
  const ctx = { userId: "u", now: NOW, resolve };
  assert.throws(() => receiptSource.toEvents({ text: "", purchased_at: BOUGHT } as ReceiptPayload, ctx), /text is required/);
  assert.throws(() => receiptSource.toEvents({ text: FIXTURE, purchased_at: "today" } as ReceiptPayload, ctx), /ISO 8601/);
});

test("the date a receipt prints is read only when it prints one", () => {
  assert.equal(receiptDate(FIXTURE), "2026-09-04");
  assert.equal(receiptDate("TOTAL  4.00"), null, "a receipt with no date is not a receipt from today");
});
