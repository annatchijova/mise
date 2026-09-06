// A row a cook has read and confirmed, and a row nobody has ever opened, used to look identical.
// These tests are about the one field that makes a sign-off worth having — the digest that says what
// was signed — and about the verdict that is easy to get wrong: "unsure" is not a failed review, it
// is a cook declining to sign, which is better information than the row had before.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PUBLISHED, publish } from "../src/open_data.ts";

const SHELF = "data/shelf_life.json";

function py(script: string, args: string[]): string {
  return execFileSync("python3", [`scripts/${script}`, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

/** Run something with the shelf-life table restored afterwards, whatever happens. */
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

const shelf = () => JSON.parse(readFileSync(SHELF, "utf8")) as { version: number; entries: Record<string, unknown>[] };
const rowOf = (id: string, where: string) =>
  shelf().entries.find((e) => e.ingredient === id && e.location === where) as Record<string, unknown>;

const queue = (table: string) =>
  JSON.parse(py("review_queue.py", ["--json", "--table", table])) as {
    row: string; score: number; because: { points: number; why: string }[];
  }[];

test("a signed row leaves the queue, and says who signed it rather than going silent", () => {
  withShelf(() => {
    py("review_sign.py", ["shelf_life", "tomato / pantry", "--verdict", "confirmed", "--note", "Right as it stands."]);
    const item = queue("shelf_life").find((i) => i.row === "tomato / pantry")!;
    assert.equal(item.score, 0, "a row somebody has read is not work any more");
    assert.equal(item.because.length, 1, "but it reads as done, not as absent");
    assert.match(item.because[0].why, /confirmed by the author's kitchen/);
    assert.match(item.because[0].why, /Right as it stands/);
  });
});

test("a review says what it reviewed, so changing the row afterwards un-signs it", () => {
  // The whole mechanism. Without it, somebody changes 7 days to 14 a year later and the row still
  // claims a cook signed it off.
  withShelf(() => {
    py("review_sign.py", ["shelf_life", "tomato / pantry", "--verdict", "confirmed"]);
    assert.equal(queue("shelf_life").find((i) => i.row === "tomato / pantry")!.score, 0);

    const table = shelf();
    for (const e of table.entries) if (e.ingredient === "tomato" && e.location === "pantry") e.days = 14;
    writeFileSync(SHELF, `${JSON.stringify(table, null, 2)}\n`);

    const back = queue("shelf_life").find((i) => i.row === "tomato / pantry")!;
    assert.ok(back.score > 0, "it is work again");
    assert.ok(back.because.some((b) => /the row has changed since/.test(b.why)),
      "and it says why it came back rather than looking never-reviewed");
  });
});

test("a cook declining to sign ranks the row up, because that is information", () => {
  withShelf(() => {
    py("review_sign.py", ["shelf_life", "mushroom / fridge", "--verdict", "unsure",
      "--note", "Depends far too much on how they were bought."]);
    const item = queue("shelf_life").find((i) => i.row === "mushroom / fridge")!;
    const doubt = item.because.find((b) => /would not sign it off/.test(b.why));
    assert.ok(doubt, "an unsure review is stated, not swallowed");
    assert.ok(doubt.points >= 60, "and it lifts the row rather than clearing it");
    assert.match(doubt.why, /how they were bought/, "with the cook's own reason");
  });
});

test("an unsure verdict must say what the doubt is", () => {
  withShelf(() => {
    assert.throws(
      () => py("review_sign.py", ["shelf_life", "mushroom / fridge", "--verdict", "unsure"]),
      /Command failed/,
      "a doubt nobody can act on is not worth recording",
    );
  });
});

test("agreeing with a row changes no advice, so it does not bump the version", () => {
  // `version` travels in every response so a recorded answer can be tied to the advice that produced
  // it. Bumping it for every sign-off would turn the number into noise.
  withShelf(() => {
    const before = shelf().version;
    py("review_sign.py", ["shelf_life", "tomato / pantry", "--verdict", "confirmed"]);
    assert.equal(shelf().version, before, "reading and agreeing is not a change of advice");

    py("review_sign.py", ["shelf_life", "banana / pantry", "--verdict", "corrected", "--set", "days=7",
      "--note", "Five is harsh."]);
    assert.equal(shelf().version, before + 1, "changing a number is");
    assert.equal(rowOf("banana", "pantry").days, 7);
  });
});

test("a correction is signed in its corrected form, not its old one", () => {
  // Otherwise the sign-off would be stale the instant it was written.
  withShelf(() => {
    py("review_sign.py", ["shelf_life", "banana / pantry", "--verdict", "corrected", "--set", "days=7",
      "--note", "Five is harsh."]);
    const item = queue("shelf_life").find((i) => i.row === "banana / pantry")!;
    assert.equal(item.score, 0);
    assert.match(item.because[0].why, /corrected by/);
  });
});

test("a 'corrected' that corrects nothing is refused", () => {
  withShelf(() => {
    assert.throws(
      () => py("review_sign.py", ["shelf_life", "tomato / pantry", "--verdict", "corrected", "--note", "x"]),
      /Command failed/,
      "that is a 'confirmed' with a misleading name, and the table would remember the wrong thing",
    );
  });
});

test("the validator rejects a review nobody could act on, and only reports a stale one", () => {
  withShelf(() => {
    // Stale is the ordinary life of a table, not misconduct.
    py("review_sign.py", ["shelf_life", "tomato / pantry", "--verdict", "confirmed"]);
    const table = shelf();
    for (const e of table.entries) if (e.ingredient === "tomato" && e.location === "pantry") e.days = 14;
    writeFileSync(SHELF, `${JSON.stringify(table, null, 2)}\n`);
    const out = py("validate_reviews.py", []);
    assert.match(out, /STALE shelf_life/);
    assert.doesNotMatch(out, /ERROR/, "a stale review is reported, never an error");
  });
});

test("the published table says how much of it a person has actually read", () => {
  // The caveat goes in the payload, because one that lives only in a repository somebody did not
  // clone has not been given to them. And it is worded as a count of records, not as a claim that
  // each still applies — checking that here would put a third copy of the digest rule in a third
  // language.
  const meta = PUBLISHED.find((p) => p.path.includes("shelf"))!;
  const out = publish(shelf() as unknown as Record<string, unknown>, meta, { baseUrl: "https://x" }) as {
    _published: { reviewed: { records: number; of: number; verify: string } };
  };
  assert.equal(out._published.reviewed.of, shelf().entries.length);
  assert.ok(out._published.reviewed.records >= 0);
  assert.match(out._published.reviewed.verify, /row_digest/);
});
