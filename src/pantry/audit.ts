// What the confidence model is *for*.
//
// The pantry has always known how sure it is about each line — confirmed, inferred, stale — and has
// always said so. What it never did was act on it. A system that knows it is unsure and never asks
// is only half honest: the badge is a disclaimer, not a behaviour.
//
// Two pure functions here. `confidenceOf` reduces the whole pantry to one figure, so the honesty
// model is visible as a fact about the kitchen rather than as a per-row footnote. `auditQuestions`
// picks the lines most worth asking about and writes the question — which is exactly the division of
// labour the rest of the project follows: the server decides what is worth asking, Alexa+ asks it,
// and the answer comes back through `pantry_update` as a `correct` or a `remove` the person said.
//
// Nothing here changes the ledger. An audit is a list of questions, and a question is not a fact.
import { displayName } from "./events.ts";
import type { PantryItem } from "./fold.ts";

export type PantryConfidence = {
  total: number;
  confirmed: number;
  inferred: number;
  stale: number;
  confirmed_pct: number;
  inferred_pct: number;
  stale_pct: number;
  /** Lines where nobody counted the amount. */
  unknown_amount: number;
  /** Lines whose date came from the shelf-life table rather than from anybody. */
  estimated_dates: number;
  /**
   * One integer, 0–100: the share of the pantry that rests on something a person actually said —
   * confirmed, with an amount. Deliberately strict. A kitchen that is 40% sure of itself is a useful
   * thing to be told; a flattering number would not be.
   */
  score: number;
  /** What the score counted, in words, so nobody has to guess at the arithmetic. */
  score_basis: string;
};

/** Integer percent, rounded once. Zero items is zero percent, not a division by zero. */
function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part * 100) / whole);
}

export function confidenceOf(items: PantryItem[]): PantryConfidence {
  const total = items.length;
  const confirmed = items.filter((i) => i.confidence === "confirmed").length;
  const inferred = items.filter((i) => i.confidence === "inferred").length;
  const stale = items.filter((i) => i.confidence === "stale").length;
  const solid = items.filter((i) => i.confidence === "confirmed" && i.qty_known).length;
  return {
    total,
    confirmed,
    inferred,
    stale,
    confirmed_pct: pct(confirmed, total),
    inferred_pct: pct(inferred, total),
    stale_pct: pct(stale, total),
    unknown_amount: items.filter((i) => !i.qty_known).length,
    estimated_dates: items.filter((i) => i.expiry_source === "estimated").length,
    score: pct(solid, total),
    score_basis: "lines that are confirmed and have an amount somebody counted, out of every line",
  };
}

export type AuditReason = "stale" | "unknown_amount" | "inferred" | "past_estimate" | "past_date";

export type AuditItem = {
  ingredient_id: string;
  location: string;
  unit: string;
  qty: number | null;
  qty_known: boolean;
  confidence: string;
  age_days: number;
  days_to_expiry: number | null;
  expiry_source: string;
  reasons: AuditReason[];
  /** How much this line is worth asking about. Integer, so the order is the same everywhere. */
  weight: number;
  /** The question to put to the person, written here so the narrator does not have to invent one. */
  question: string;
};

// Weights, in one place so the ordering can be argued with. They are ranked by how wrong the pantry
// could be, not by how old the line is: an amount nobody ever counted is a worse kind of not-knowing
// than a number that has simply gone unconfirmed for a while.
const WEIGHTS: Record<AuditReason, number> = {
  past_date: 50,
  unknown_amount: 40,
  stale: 30,
  past_estimate: 20,
  inferred: 15,
};

function questionFor(item: PantryItem, reasons: AuditReason[]): string {
  const name = displayName(item.ingredient_id);
  const where = item.location === "pantry" ? "" : ` in the ${item.location}`;
  if (reasons.includes("past_date")) return `The ${name}${where} is past the date you gave. Is it still good, or has it gone?`;
  if (reasons.includes("past_estimate")) return `The ${name}${where} is probably past its best by now — nobody gave it a date. Do you still have it?`;
  if (reasons.includes("unknown_amount")) return `I know there is ${name}${where} but not how much. Roughly how much is left?`;
  if (reasons.includes("stale")) {
    const amount = item.qty_known ? `${item.qty} ${item.unit === "pc" ? "" : `${item.unit} `}` : "some ";
    return `I still have ${amount}${name}${where} on the list from ${item.age_days} days ago. Is that right?`;
  }
  return `The ${name}${where} came from a device rather than from you. Is it still there?`;
}

export type AuditOptions = {
  /** How many questions to come back with. */
  limit?: number;
  /** Only ask about lines carrying this reason. */
  only?: AuditReason;
};

/**
 * The lines most worth asking about, heaviest first.
 *
 * A line can carry several reasons and they add up, because they compound: an inferred quantity
 * nobody has confirmed in three weeks, on food that is probably past its date, is three separate
 * ways of being wrong about the same shelf.
 *
 * Ties break on the ingredient id, so two runs over the same pantry ask the same questions in the
 * same order — which matters more than it sounds, because a person answering an audit is entitled to
 * expect it not to reshuffle underneath them.
 */
export function auditQuestions(items: PantryItem[], opts: AuditOptions = {}): AuditItem[] {
  const limit = Math.max(1, Math.min(20, opts.limit ?? 5));
  const scored: AuditItem[] = [];

  for (const item of items) {
    const reasons: AuditReason[] = [];
    if (item.days_to_expiry !== null && item.days_to_expiry < 0) {
      reasons.push(item.expiry_source === "estimated" ? "past_estimate" : "past_date");
    }
    if (!item.qty_known) reasons.push("unknown_amount");
    if (item.confidence === "stale") reasons.push("stale");
    else if (item.confidence === "inferred") reasons.push("inferred");
    if (reasons.length === 0) continue;
    if (opts.only && !reasons.includes(opts.only)) continue;

    scored.push({
      ingredient_id: item.ingredient_id,
      location: item.location,
      unit: item.unit,
      qty: item.qty,
      qty_known: item.qty_known,
      confidence: item.confidence,
      age_days: item.age_days,
      days_to_expiry: item.days_to_expiry,
      expiry_source: item.expiry_source,
      reasons,
      weight: reasons.reduce((sum, r) => sum + WEIGHTS[r], 0),
      question: questionFor(item, reasons),
    });
  }

  return scored
    .sort((a, b) => b.weight - a.weight || a.ingredient_id.localeCompare(b.ingredient_id) || a.location.localeCompare(b.location))
    .slice(0, limit);
}

/** The confidence figure as one sentence. */
export function confidenceSentence(c: PantryConfidence): string {
  if (c.total === 0) return "There is nothing on the list yet, so there is nothing to be sure or unsure about.";
  const parts = [
    `${c.score}% of the pantry rests on something you actually said`,
    c.inferred ? `${c.inferred} line${c.inferred === 1 ? "" : "s"} came from a device or from what you cooked` : "",
    c.stale ? `${c.stale} nobody has confirmed in a while` : "",
    c.unknown_amount ? `${c.unknown_amount} with an amount nobody counted` : "",
  ].filter(Boolean);
  return `${parts.join(", ")}.`;
}
