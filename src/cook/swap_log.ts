// How a curated table grows without becoming a guess.
//
// The substitution table's one weakness is that it stops growing: it holds what one cook thought to
// write down, and nothing that happens in anybody's kitchen ever gets into it. The obvious fix is to
// learn from what people actually do, and the obvious fix is exactly the thing this project refuses
// — a table that quietly absorbs what somebody did once is no longer a table anybody wrote.
//
// So the swaps people record while cooking go into a **queue for a human**, the same way an imported
// recipe goes to `data/imports/` for somebody to finish. Two rules hold the line:
//
//   1. **Nothing here is ever consulted by `substitute`.** The tool reads `data/substitutions.json`
//      and nothing else. The table grows when a person edits that file, and at no other moment.
//   2. **A swap the table already covers is a confirmation, not a candidate.** Somebody doing what
//      the table suggested is evidence *for* the row, and it is worth counting separately — a row
//      thirty people have followed is a different thing from a row nobody has tested.
//
// What the queue is for is the question a curator cannot otherwise answer: what are people doing
// that I did not think of?
import { readFileSync, writeFileSync } from "node:fs";

export type SwapKind = "candidate" | "confirmation";

export type Sighting = {
  at: string;
  session_id: string;
  recipe_id: string;
  /** What the person actually said, kept verbatim. It is the most useful thing here for a curator. */
  note: string;
};

export type SwapRecord = {
  instead_of: string;
  used: string;
  /** What the ingredient was doing, from the recipe. Null when the recipe does not use it — somebody
   *  swapping something the dish never called for is itself worth a curator's attention. */
  role: string | null;
  technique: string | null;
  /** The sides held verbatim rather than as an ingredient id, because we have no id for them. Empty
   *  for an ordinary swap. A name that keeps turning up here is usually an alias nobody has written
   *  yet, which is the cheapest curation there is. */
  unresolved: string[];
  kind: SwapKind;
  count: number;
  first_seen: string;
  last_seen: string;
  sightings: Sighting[];
};

export type SwapLog = {
  version: number;
  /** Said in the file, because a file outlives the reason it was made. */
  note: string;
  records: SwapRecord[];
};

/** At most this many verbatim sightings per record. A curator needs a few examples, not a log. */
const KEEP_SIGHTINGS = 5;

export const EMPTY_LOG: SwapLog = {
  version: 1,
  note:
    "Swaps people made while cooking, queued for review. NOTHING HERE IS CONSULTED BY `substitute`: " +
    "the tool reads data/substitutions.json and nothing else, and this file only becomes advice when " +
    "a person moves a row into it. `candidate` means the table has no answer for that swap; " +
    "`confirmation` means somebody did what the table already suggests. See docs/SUBSTITUTION_SCHEMA.md.",
  records: [],
};

function keyOf(r: { instead_of: string; used: string; role: string | null; technique: string | null }): string {
  return `${r.instead_of}|${r.used}|${r.role ?? "*"}|${r.technique ?? "*"}`;
}

export type SwapInput = {
  instead_of: string;
  used: string;
  role: string | null;
  technique: string | null;
  unresolved?: string[];
  kind: SwapKind;
  at: string;
  session_id: string;
  recipe_id: string;
  note: string;
};

/**
 * Fold one swap into the log.
 *
 * Pure: a log and a swap in, a new log out. Records are keyed on all four fields, so "chickpeas for
 * broad beans, simmering" and "chickpeas for broad beans, fried" stay separate — they are different
 * claims and a curator would answer them differently.
 */
export function recordSwap(log: SwapLog, input: SwapInput): SwapLog {
  const key = keyOf(input);
  const records = log.records.map((r) => ({ ...r, sightings: [...r.sightings] }));
  const existing = records.find((r) => keyOf(r) === key);
  const sighting: Sighting = { at: input.at, session_id: input.session_id, recipe_id: input.recipe_id, note: input.note };

  if (existing) {
    existing.count += 1;
    existing.last_seen = input.at;
    // The newest few, because the oldest example of a swap somebody keeps making is the least useful.
    existing.sightings = [...existing.sightings, sighting].slice(-KEEP_SIGHTINGS);
    // A swap the table has since learned to cover stops being a candidate. The count carries over:
    // the evidence did not stop existing when somebody wrote the row.
    existing.kind = input.kind;
  } else {
    records.push({
      instead_of: input.instead_of,
      used: input.used,
      role: input.role,
      technique: input.technique,
      unresolved: input.unresolved ?? [],
      kind: input.kind,
      count: 1,
      first_seen: input.at,
      last_seen: input.at,
      sightings: [sighting],
    });
  }

  // Most-seen first, then alphabetically: the queue a curator opens is in the order they would work.
  records.sort(
    (a, b) =>
      b.count - a.count ||
      a.instead_of.localeCompare(b.instead_of) ||
      a.used.localeCompare(b.used) ||
      (a.role ?? "").localeCompare(b.role ?? "") ||
      (a.technique ?? "").localeCompare(b.technique ?? ""),
  );
  return { ...log, records };
}

/** The candidates worth a curator's time: what the table has no answer for, most-seen first. */
export function candidates(log: SwapLog): SwapRecord[] {
  return log.records.filter((r) => r.kind === "candidate");
}

export type SwapStore = {
  read(): SwapLog;
  write(log: SwapLog): void;
};

/**
 * The queue on disk.
 *
 * A file rather than a table, because that is what it is: something a person opens, reads, and
 * either acts on or does not. Failing to write it must never break a cook — the swap is already in
 * the session's own log, which is where it matters — so `write` swallows nothing and the caller
 * decides, but the tool that calls it treats a failure as a note it could not file rather than as a
 * cooking error.
 */
export class FileSwapStore implements SwapStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  read(): SwapLog {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as SwapLog;
      // A queue written before a field existed is still a queue. Fill the gap rather than trusting
      // the file's shape: this one is edited by hand, so it is exactly the file that will be wrong.
      const records = (parsed.records ?? []).map((r) => ({ ...r, unresolved: r.unresolved ?? [] }));
      return { ...EMPTY_LOG, ...parsed, records };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_LOG;
      throw err;
    }
  }

  write(log: SwapLog): void {
    writeFileSync(this.file, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  }
}

/** For a server with nowhere to write. The swaps still reach the session log; only the queue is lost. */
export class MemorySwapStore implements SwapStore {
  private log: SwapLog = EMPTY_LOG;
  read(): SwapLog {
    return this.log;
  }
  write(log: SwapLog): void {
    this.log = log;
  }
}
