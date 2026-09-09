// A curated table's one weakness is that it stops growing. The fix everybody reaches for — learn
// from what people do — is the thing this project refuses, so these tests are mostly about the wall
// between the queue and the table: what goes in the queue, what counts as evidence rather than as a
// new claim, and the fact that nothing here can ever change an answer.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EMPTY_LOG, FileSwapStore, MemorySwapStore, candidates, recordSwap } from "../src/cook/swap_log.ts";
import { indexSubstitutions, loadSubstitutions, substitutionsFor } from "../src/substitutions.ts";

const NOW = "2026-09-06T18:00:00.000Z";
const later = (n: number) => new Date(Date.parse(NOW) + n * 60_000).toISOString();

const swap = (over: Partial<Parameters<typeof recordSwap>[1]> = {}) => ({
  instead_of: "broad-bean", used: "chickpea", role: "protein", technique: "simmer",
  kind: "candidate" as const, at: NOW, session_id: "s1", recipe_id: "stew", note: "chickpeas instead",
  ...over,
});

test("the same swap twice is one record with a count, not two records", () => {
  let log = recordSwap(EMPTY_LOG, swap());
  log = recordSwap(log, swap({ at: later(10), session_id: "s2" }));
  assert.equal(log.records.length, 1);
  assert.equal(log.records[0].count, 2);
  assert.equal(log.records[0].first_seen, NOW);
  assert.equal(log.records[0].last_seen, later(10));
});

test("the same two ingredients doing different jobs are two different claims", () => {
  let log = recordSwap(EMPTY_LOG, swap({ technique: "simmer" }));
  log = recordSwap(log, swap({ technique: "fry" }));
  assert.equal(log.records.length, 2, "simmering and frying would be answered differently");
});

test("what somebody actually said is kept, because it is the most useful thing to a curator", () => {
  const log = recordSwap(EMPTY_LOG, swap({ note: "no broad beans in the shop, used a tin of chickpeas" }));
  assert.equal(log.records[0].sightings[0].note, "no broad beans in the shop, used a tin of chickpeas");
  assert.equal(log.records[0].sightings[0].recipe_id, "stew");
});

test("a swap somebody keeps making keeps its newest examples, not its oldest", () => {
  let log = EMPTY_LOG;
  for (let i = 0; i < 9; i++) log = recordSwap(log, swap({ at: later(i), note: `note ${i}` }));
  const kept = log.records[0].sightings;
  assert.equal(log.records[0].count, 9);
  assert.ok(kept.length <= 5, "a curator needs a few examples, not a log");
  assert.equal(kept.at(-1)?.note, "note 8");
});

test("the queue is in the order a curator would work: most seen first", () => {
  let log = EMPTY_LOG;
  log = recordSwap(log, swap({ used: "lentil" }));
  for (let i = 0; i < 3; i++) log = recordSwap(log, swap({ used: "chickpea", at: later(i) }));
  assert.equal(log.records[0].used, "chickpea");
  assert.equal(log.records[0].count, 3);
});

test("doing what the table already says is a confirmation, and counts separately", () => {
  let log = recordSwap(EMPTY_LOG, swap({ kind: "confirmation" }));
  // Checked on the very first sighting, before any second one can correct the record: a confirmation
  // that starts life as a candidate would put a row a curator has already written back in their queue.
  assert.equal(log.records[0].kind, "confirmation");
  assert.equal(candidates(log).length, 0, "it is evidence for a row, not a new claim");
  log = recordSwap(log, swap({ kind: "confirmation", at: later(1) }));
  assert.equal(candidates(log).length, 0, "it is evidence for a row, not a new claim");
  assert.equal(log.records[0].count, 2);
});

test("a candidate the table has since learned to cover stops being one, and keeps its evidence", () => {
  let log = recordSwap(EMPTY_LOG, swap({ kind: "candidate" }));
  log = recordSwap(log, swap({ kind: "candidate", at: later(1) }));
  log = recordSwap(log, swap({ kind: "confirmation", at: later(2) }));
  assert.equal(candidates(log).length, 0);
  assert.equal(log.records[0].count, 3, "the evidence did not stop existing when somebody wrote the row");
});

test("nothing in the queue can change what substitute says", () => {
  // The one property that matters. A swap is recorded, and the table answers exactly as before.
  const table = loadSubstitutions();
  const index = indexSubstitutions(table);
  const before = substitutionsFor(table, index, { ingredient: "broad-bean", role: "protein", technique: "simmer" });
  const store = new MemorySwapStore();
  store.write(recordSwap(store.read(), swap()));
  const after = substitutionsFor(table, index, { ingredient: "broad-bean", role: "protein", technique: "simmer" });
  assert.deepEqual(after, before);
  assert.equal(store.read().records.length, 1, "the swap is queued");
});

test("the file says what it is, so it outlives the reason it was made", () => {
  assert.match(EMPTY_LOG.note, /NOTHING HERE IS CONSULTED BY `substitute`/);
  assert.match(EMPTY_LOG.note, /a person moves a row into it/);
});

test("the log is a value: recording never mutates what it was given", () => {
  const before = recordSwap(EMPTY_LOG, swap());
  const snapshot = JSON.stringify(before);
  recordSwap(before, swap({ at: later(5) }));
  assert.equal(JSON.stringify(before), snapshot);
});

test("a swap naming something we have no id for is still queued, and says which name it is", () => {
  // The opposite of what the pantry does, on purpose: the pantry needs an id to deduct anything, but
  // a name nothing recognises is the single most useful thing a curator can be handed.
  const log = recordSwap(EMPTY_LOG, swap({ used: "butter beans", unresolved: ["butter beans"] }));
  assert.equal(log.records[0].used, "butter beans");
  assert.deepEqual(log.records[0].unresolved, ["butter beans"]);
  assert.equal(candidates(log).length, 1);
});

test("an ordinary swap carries no unresolved names, so the two kinds of work stay apart", () => {
  const log = recordSwap(EMPTY_LOG, swap());
  assert.deepEqual(log.records[0].unresolved, []);
});

test("a queue written before the field existed still reads", () => {
  // This file is edited by hand, so it is exactly the file that will be missing a field one day.
  const file = join(mkdtempSync(join(tmpdir(), "swaps-")), "queue.json");
  const old = {
    version: 1,
    note: "an older queue",
    records: [{ instead_of: "broad-bean", used: "chickpea", role: "protein", technique: "simmer",
      kind: "candidate", count: 2, first_seen: NOW, last_seen: NOW, sightings: [] }],
  };
  writeFileSync(file, JSON.stringify(old), "utf8");
  const store = new FileSwapStore(file);
  assert.deepEqual(store.read().records[0].unresolved, [], "a missing field is empty, never undefined");
  // And it survives a round trip, so reading an old file does not corrupt the next write.
  store.write(recordSwap(store.read(), swap({ at: later(1) })));
  assert.equal(store.read().records[0].count, 3);
});
