// The review queue ranks curated rows by what it would cost if one were wrong, and it measures reach
// by walking the same lookup chains the server walks. That means it holds a second copy of those
// chains, in Python — and two copies of a rule are two rules that drift.
//
// So this is mostly one test: run the real TypeScript lookup over the real corpus, run the queue, and
// assert they credit exactly the same rows with exactly the same counts. If somebody changes the
// chain in `substitutionsFor` and not in the script, this fails, and the queue stops quietly ranking
// by a rule the server no longer uses.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadRecipes } from "../src/recipes.ts";
import { indexSubstitutions, loadSubstitutions, substitutionsFor } from "../src/substitutions.ts";

const SHELF = "data/shelf_life.json";

/** Run something with the shelf-life table restored afterwards, whatever happens. Same idiom as
 *  test/reviews.test.ts -- duplicated rather than imported, because there is no shared test-helper
 *  module in this project and one file's private fixture is not worth inventing one for. */
function withShelf<T>(fn: () => T): T {
  const backup = mkdtempSync(join(tmpdir(), "shelf-"));
  const saved = join(backup, "shelf_life.json");
  copyFileSync(SHELF, saved);
  try {
    return fn();
  } finally {
    copyFileSync(saved, SHELF);
  }
}

type QueueItem = {
  table: string;
  row: string;
  summary: string;
  note: string | null;
  score: number;
  because: { points: number; why: string }[];
};

function queue(table?: string): QueueItem[] {
  const args = ["scripts/review_queue.py", "--json", ...(table ? ["--table", table] : [])];
  return JSON.parse(execFileSync("python3", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
}

/** The row that actually answered, keyed the way the queue keys it. */
function keyFromMatch(id: string, role: string, technique: string, match: string): string {
  switch (match) {
    case "ingredient+role+technique": return `${id}|${role}|${technique}`;
    case "ingredient+role": return `${id}|${role}|*`;
    case "ingredient": return `${id}|*|*`;
    case "role+technique": return `*|${role}|${technique}`;
    default: return `*|${role}|*`;
  }
}

test("the queue's reach is the real lookup's, row for row and count for count", () => {
  const table = loadSubstitutions();
  const index = indexSubstitutions(table);
  const truth = new Map<string, number>();
  for (const r of loadRecipes()) {
    for (const i of r.ingredients) {
      if (!i.role || !i.technique) continue;
      const got = substitutionsFor(table, index, { ingredient: i.id, role: i.role, technique: i.technique });
      if (!got.length) continue;
      const key = keyFromMatch(i.id, i.role, i.technique, got[0].match);
      truth.set(key, (truth.get(key) ?? 0) + 1);
    }
  }

  const mine = new Map<string, number>();
  for (const item of queue("substitutions")) {
    for (const b of item.because) {
      const m = /^answers (\d+) ingredient line/.exec(b.why);
      if (!m || Number(m[1]) === 0) continue;
      const [rawIngredient, role, rawTechnique] = item.row.split(" · ");
      const ingredient = rawIngredient.startsWith("(any ") ? "*" : rawIngredient;
      const technique = rawTechnique === "any" ? "*" : rawTechnique;
      mine.set(`${ingredient}|${role}|${technique}`, Number(m[1]));
    }
  }

  assert.ok(truth.size > 50, "the corpus really does exercise the table");
  assert.deepEqual(
    [...mine.entries()].sort(),
    [...truth.entries()].sort(),
    "the script's copy of the lookup chain has drifted from the server's",
  );
});

test("and the guard says how much of the chain it can actually check", () => {
  // Worth being exact about, because it is easy to believe this guard is stronger than it is. It can
  // only catch drift at a level the corpus reaches. The table currently has no ingredient-only rows
  // at all, so deleting that level from the script's chain changes nothing and this would not
  // notice — verified by trying it. If a level ever gains rows, this figure moves and the guard
  // silently gets stronger; if somebody removes the last row of a level, it gets weaker and says so.
  const table = loadSubstitutions();
  const index = indexSubstitutions(table);
  const levels = new Set<string>();
  for (const r of loadRecipes()) {
    for (const i of r.ingredients) {
      if (!i.role || !i.technique) continue;
      const got = substitutionsFor(table, index, { ingredient: i.id, role: i.role, technique: i.technique });
      if (got.length) levels.add(got[0].match);
    }
  }
  assert.deepEqual(
    [...levels].sort(),
    ["ingredient+role+technique", "role", "role+technique"],
    "the levels the corpus exercises, and so the only ones the drift guard above can check",
  );
});

test("every point in a score says what produced it", () => {
  // A ranking nobody can argue with row by row is an opinion with a number on it.
  for (const item of queue()) {
    assert.equal(item.score, item.because.reduce((n, b) => n + b.points, 0), `${item.row} does not add up`);
    for (const b of item.because) {
      assert.ok(b.why.length > 10, `${item.row} has a point with no reason: ${JSON.stringify(b)}`);
    }
  }
});

test("a row nothing reaches scores nothing, and says that rather than saying nothing", () => {
  // The zero is the point. A row ranked last with no explanation looks like an oversight; a row
  // ranked last because nothing in the corpus reaches it is a finding, and it is the one a curator
  // most needs before spending a Saturday on it.
  const unread = queue().filter((i) => i.score === 0);
  assert.ok(unread.length > 0, "some rows really are unused, and pretending otherwise helps nobody");
  for (const i of unread) {
    assert.ok(i.because.length > 0, `${i.row} scores nothing and does not say why`);
    assert.ok(i.because.every((b) => b.points === 0));
  }
});

test("a safety row outranks everything while unreviewed, and leaves the queue once it is not", () => {
  // docs/BLOCKED.md §H.1 names the garlic-oil row by hand, and it carries `caution: true` for
  // exactly this reason. Other curated safety rows may exist and be signed off; asserting that
  // THIS row is always item [0] would make the test depend on
  // nobody ever reviewing it -- which is backwards: reviewing it is the point of the whole mechanism,
  // and the day somebody does their job and signs it off, the row is *supposed* to drop out of the
  // top spot (see test/reviews.test.ts: "a signed row leaves the queue"). So this tests the
  // *property* the row is the live example of, not the row's permanent rank.
  //
  // Un-reviewing garlic-oil temporarily (restored after) re-exercises the real caution mechanism —
  // its real curated `caution_reason`, mentioning botulism -- without freezing the corpus in a state
  // where the row can never legitimately be reviewed again.
  withShelf(() => {
    const shelf = JSON.parse(readFileSync(SHELF, "utf8")) as { entries: Record<string, unknown>[] };
    const row = shelf.entries.find((e) => e.ingredient === "garlic-oil" && e.location === "fridge")!;
    assert.ok(row.caution, "the fixture for this test is the garlic-oil caution row");
    delete row.reviewed;
    writeFileSync(SHELF, JSON.stringify(shelf, null, 2));

    const top = queue()[0];
    assert.match(top.row, /garlic-oil/, "an unreviewed caution row outranks everything, popularity included");
    const care = top.because.find((b) => /safety matter/.test(b.why));
    assert.ok(care, "the top row is top for a stated reason");
    assert.ok(care.points >= 100, "and by a distance, so popularity cannot overtake it");
    assert.match(care.why, /botulism/, "the reason is the row's own, not the script's");
  });
});

test("...and once reviewed, that same row leaves the queue rather than staying frozen at the top", () => {
  // The complement of the test above, run against the real, currently-signed row -- so the two
  // together cover both states of the one mechanism, instead of only ever exercising one of them.
  const item = queue("shelf_life").find((i) => i.row === "garlic-oil / fridge")!;
  assert.ok(item, "the row still exists and still answers under its real key");
  assert.equal(item.score, 0, "a reviewed row is not open work any more");
  assert.equal(item.because.length, 1, "but it reads as done, not as absent");
  assert.match(item.because[0].why, /corrected by/, "this row's real history: 7 days was corrected to 4");
});

test("the queue ranks by what being wrong would cost, never by how likely it is", () => {
  // The distinction the whole script rests on. "Wrong here has no fallback" is a statement about
  // cost and is welcome; "this row looks doubtful" would be the model grading somebody's judgment,
  // which is not a thing it can do. Curated text the script quotes is data and is not policed —
  // only the script's own words are.
  for (const item of queue()) {
    for (const b of item.because) {
      const own = b.why.split(": ")[0];
      assert.doesNotMatch(own, /likely|probably|unlikely|suspicious|doubtful|questionable|confidence|accurate/i,
        `${item.row}: a reason that grades correctness rather than cost — ${b.why}`);
    }
  }
});
