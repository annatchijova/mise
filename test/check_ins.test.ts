// The corpus has a four-to-six week sauerkraut. A single alarm six weeks out would be useless, and
// working out a cadence from the duration would be arithmetic wearing an expert's coat — so these
// tests are mostly about what the schedule refuses to invent, and about the three different kinds of
// silence, which must never be collapsed into one.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  LONG_STEP_S,
  type LongStepPlan,
  checkSentence,
  indexLongSteps,
  keyOf,
  loadLongSteps,
  scheduleFor,
} from "../src/cook/check_ins.ts";
import { loadRecipes } from "../src/recipes.ts";

const TABLE = loadLongSteps();
const INDEX = indexLongSteps(TABLE);
const START = "2026-09-01T10:00:00.000Z";
const at = (h: number) => new Date(Date.parse(START) + h * 3_600_000).toISOString();

const plan = (over: Partial<LongStepPlan> = {}): LongStepPlan => ({
  recipe_id: "x", step: 1, kind: "ferment", first_check_s: 3600, check_every_s: 7200,
  look_for: ["Is it still under the brine?"], note: "test", ...over,
});

test("a plan a person wrote decides the cadence, and nothing else does", () => {
  const s = scheduleFor(plan(), START, 36_000, at(0), null);
  assert.equal(s.kind, "scheduled");
  if (s.kind !== "scheduled") return;
  // First at +1h, then every 2h, up to but not past the 10h duration.
  assert.deepEqual(s.checks.map((c) => c.at), [at(1), at(3), at(5), at(7), at(9)]);
});

test("the three silences are different things and are never conflated", () => {
  // Nobody has written a plan.
  assert.equal(scheduleFor(undefined, START, 36_000, at(1), null).kind, "no_plan");
  // Somebody decided there is nothing to look at, and the row says why.
  const decided = scheduleFor(plan({ first_check_s: null, check_every_s: null }), START, 36_000, at(1), null);
  assert.equal(decided.kind, "nothing_to_check");
  // And they say different things out loud.
  assert.equal(checkSentence(scheduleFor(undefined, START, 36_000, at(1), null), at(1)), null);
  assert.match(checkSentence(decided, at(1)) ?? "", /Nothing to check on this one/);
});

test("a look answers everything scheduled up to it, because you cannot look four times at once", () => {
  const missed = scheduleFor(plan(), START, 36_000, at(8), null);
  assert.equal(missed.kind === "scheduled" && missed.overdue.length, 4);

  const caught = scheduleFor(plan(), START, 36_000, at(8), at(8));
  assert.equal(caught.kind === "scheduled" && caught.overdue.length, 0, "one look catches up");
  assert.equal(caught.kind === "scheduled" && caught.checks.filter((c) => c.state === "done").length, 4);
});

test("being behind is said as how late, not as a number of things to do", () => {
  // "Four looks are due" asks somebody for four things they cannot do.
  const said = checkSentence(scheduleFor(plan(), START, 36_000, at(8), null), at(8)) ?? "";
  assert.match(said, /overdue/);
  assert.match(said, /the plan wanted one .* ago/);
  assert.doesNotMatch(said, /4 looks/);
});

test("what to look at is the row's own words, carried through untouched", () => {
  const said = checkSentence(scheduleFor(plan({ look_for: ["Push it back under."] }), START, 36_000, at(2), null), at(2)) ?? "";
  assert.match(said, /Push it back under\./);
});

test("a look that has happened stays done however long ago it came due", () => {
  const s = scheduleFor(plan(), START, 36_000, at(8), at(4));
  assert.equal(s.kind, "scheduled");
  if (s.kind !== "scheduled") return;
  // Looks at +1, +3, +5, +7 and +9 hours; looked at +4; asking at +8.
  assert.deepEqual(s.checks.map((c) => c.state), ["done", "done", "due", "due", "upcoming"]);

  // And a look falling exactly now is due rather than upcoming, which is the useful way round.
  const exact = scheduleFor(plan(), START, 36_000, at(9), at(4));
  assert.equal(exact.kind === "scheduled" && exact.checks[4].state, "due");
});

test("a single-look plan does not repeat", () => {
  const s = scheduleFor(plan({ first_check_s: 10_800, check_every_s: null }), START, 36_000, at(0), null);
  assert.equal(s.kind === "scheduled" && s.checks.length, 1);
});

test("a plan that would produce thousands of looks is cut short and says so", () => {
  // That is a mistake in the table, not a demanding recipe, and it should be visible.
  const s = scheduleFor(plan({ first_check_s: 1, check_every_s: 1 }), START, 36_000, at(0), null);
  assert.equal(s.kind === "scheduled" && s.truncated, true);
  assert.ok(s.kind === "scheduled" && s.checks.length <= 200);
});

test("the sentence never promises to tell you: this server cannot ring", () => {
  const said = checkSentence(scheduleFor(plan(), START, 36_000, at(0), null), at(0)) ?? "";
  assert.match(said, /Next look in about/);
  for (const promise of [/I will remind/i, /I will tell you/i, /I will let you know/i, /I will call/i]) {
    assert.doesNotMatch(said, promise, "an MCP server cannot wake Alexa up; see docs/BLOCKED.md");
  }
});

// --- the table against the corpus ------------------------------------------------------------------

test("every long step in the corpus has a plan, and each is for a step that exists", () => {
  const recipes = loadRecipes();
  const long: string[] = [];
  for (const r of recipes) {
    for (const s of r.steps) if (s.dur_s >= LONG_STEP_S) long.push(keyOf(r.id, s.order));
  }
  assert.ok(long.length > 10, "the corpus really does have long steps");
  for (const k of long) assert.ok(INDEX.has(k), `no plan for ${k}`);
  for (const e of TABLE.entries) {
    const recipe = recipes.find((r) => r.id === e.recipe_id);
    assert.ok(recipe, `${e.recipe_id} is not a recipe`);
    assert.ok(recipe?.steps.some((s) => s.order === e.step), `${e.recipe_id} has no step ${e.step}`);
  }
});

test("a row that says there is nothing to check still says why", () => {
  const quiet = TABLE.entries.filter((e) => e.first_check_s === null && e.check_every_s === null);
  assert.ok(quiet.length > 0, "some long steps genuinely want leaving alone");
  for (const e of quiet) {
    assert.deepEqual(e.look_for, [], "a row asserting nothing must not also look like advice");
    assert.ok(e.note.length > 20, `${e.recipe_id} step ${e.step} decides nothing needs checking without saying why`);
  }
});

test("the sauerkraut is checked on the way through, not once at the end", () => {
  // The case the whole feature exists for: four to six weeks, and the recipe itself says taste at four.
  const s = scheduleFor(INDEX.get(keyOf("sauerkraut", 11)), START, 2_419_200, at(0), null);
  assert.equal(s.kind, "scheduled");
  if (s.kind !== "scheduled") return;
  assert.ok(s.checks.length >= 8, `only ${s.checks.length} looks across four weeks`);
  assert.ok(s.plan.look_for.some((l) => /taste/i.test(l)), "the recipe says to taste it, so the plan does too");
});
