// A shop receipt, as a pantry source.
//
// A receipt is the cheapest complete record of what entered a house that exists: no scanning, no
// photographing, no listing things out loud. It is also the messiest. `CHKPS 400G` is chickpeas,
// `2 X TOMATOES` is two of something sold by the piece, `BANANAS 0.842kg @ 2.19/kg` is a weight, and
// half of what is printed is not food at all — a total, a VAT line, a loyalty message, the address.
//
// The temptation with a mess like this is to hand it to a model and take what comes back. Two
// reasons not to. The first is the whole thesis of this project: Alexa+ is the model, this server is
// data and deterministic logic, and a pantry that guesses is worse than no pantry, because a wrong
// count is trusted exactly as much as a right one. The second is narrower and sharper: a receipt is
// *evidence*, and the value of evidence is that it can be checked. A parser with a written grammar
// can be told it is wrong. A reading cannot.
//
// So every line of a receipt ends up in exactly one of three places, and never anywhere else:
//
//   - an **event**, when the line yields a food this kitchen has an id for;
//   - **unmapped**, when it is plainly a purchase but the name resolves to nothing — reported with
//     the raw text, because that is a missing alias and somebody can add one;
//   - **skipped**, when the grammar recognises it as something that is not a purchase at all —
//     reported *with the rule that skipped it*, so a receipt that parses badly says why rather than
//     quietly losing half its lines.
//
// Nothing is dropped silently and nothing is invented. A line whose amount is not printed becomes an
// event with `qty_milli: null` — "some, amount unknown" — which the ledger already understands, and
// which is the truth: the receipt says you bought tomatoes and does not say how many.
import {
  type PantryEvent,
  type Unit,
  canonicalAmount,
  isIsoDate,
  isIsoTimestamp,
  milliOrNull,
} from "../pantry/events.ts";
import type { PantrySource, SourceContext, SourceReading, UnmappedItem } from "./types.ts";

export type ReceiptPayload = {
  /** The receipt as it was pasted or scanned: newlines and all, unedited. */
  text: string;
  /** ISO 8601. When the shopping happened, not when it was pasted — a receipt is often days old. */
  purchased_at: string;
  merchant?: string | null;
  /** Where the shopping was put away, when the person said. Defaults to the pantry. */
  location?: string | null;
};

/** Why a line produced nothing. Kept as a code so the reason is testable, and rendered for people. */
export type SkipRule =
  | "blank"
  | "no_letters"
  | "separator"
  | "totals"
  | "payment"
  | "shop_furniture"
  | "date_or_time"
  | "no_price"
  | "no_name_left";

export type SkippedLine = { line: number; text: string; rule: SkipRule };

/** One line the grammar read as a purchase, before any ingredient id is involved. */
export type ReceiptLine = {
  line: number;
  text: string;
  /** What is left after the price, the multiplier and the pack size are taken off. */
  name: string;
  /** Integer thousandths, or null when the receipt printed no amount. Never a guess. */
  qty_milli: number | null;
  unit: Unit;
  /** The line's price in integer cents, when one was printed. Carried for the person to check
   *  against, never used to work out an amount: price divided by a unit price is not a quantity we
   *  are entitled to assert. */
  price_cents: number | null;
};

export type ReceiptParse = {
  purchases: ReceiptLine[];
  skipped: SkippedLine[];
};

// --- the grammar -------------------------------------------------------------------------------
//
// Every rule below is a whole-line or end-of-line pattern, applied in a fixed order. Order matters
// and is part of the contract: the price comes off before the pack size is looked for, so that
// `CHICKPEAS 400G 1.29` does not read `1.29` as a quantity.

/** A line with no letter at all is a number, a rule, or noise. Never a food. */
const HAS_LETTER = /\p{L}/u;
/** `-----`, `=====`, `*** ***`. */
const SEPARATOR = /^[\s\-=_*.~#]+$/;
/** The arithmetic at the foot of a receipt. Anchored to the start so `TOTAL WHEAT FLOUR` survives. */
const TOTALS = /^(sub[\s-]?total|total|balance|amount due|net|gross|vat|tax|iva|discount|savings|you saved|rounding)\b/i;
/** How it was paid for. */
const PAYMENT = /^(cash|change|card|credit|debit|visa|mastercard|amex|contactless|chip|approved|auth|terminal|aid|arqc|tender|paid)\b/i;
/** What a shop prints around the shopping. */
const FURNITURE =
  /^(thank you|thanks|welcome|please|customer|copy|receipt|invoice|ticket|store|shop|branch|tel|phone|fax|vat no|tax id|cuit|cif|nif|reg|till|cashier|operator|server|order|table|www\.|http|survey|points|loyalty|member|card no|items?\b.*\d|no\.? of items|qty\b\s*$)/i;
/** A date or a time on a line of its own. */
const DATE_OR_TIME = /^\s*(\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}|\d{1,2}:\d{2})/;

/** A trailing price: `1.29`, `1,29`, `$1.29`, `£1.29 A`, `1.29-`. The letter suffix is a VAT class. */
const TRAILING_PRICE = /(?:^|\s)(?:[$£€]\s?)?(\d{1,5})[.,](\d{2})\s*[-A-Z*]?\s*$/;
/** A leading count: `2 X `, `3x `, `2 @ `. */
const LEADING_COUNT = /^\s*(\d{1,3})\s*(?:x|\*|@)\s+/i;
/** A unit price the shop shows its working with: `@ 2.19/kg`, `@ £1.50 each`. Removed, never used. */
const UNIT_PRICE = /\s@\s*[$£€]?\s*\d+[.,]\d{1,3}\s*(?:\/\s*\w+|each|c\/u)?/gi;
/** A weight or volume anywhere in the line: `0.842 kg`, `400G`, `1 L`, `250ml`. */
const AMOUNT = /(?:^|\s)(\d+(?:[.,]\d+)?)\s*(kg|g|gr|grs|ml|l|lt|lts|cl|oz|lb)\b/i;
/** Codes shops print beside a name: a PLU, an EAN, a department number. */
const CODE = /(?:^|\s)(?:\d{4,14}|[A-Z]{1,3}\d{2,6})(?=\s|$)/g;

const UNIT_WORDS: Record<string, Unit | null> = {
  kg: "kg", g: "g", gr: "g", grs: "g",
  l: "l", lt: "l", lts: "l", ml: "ml",
  // Deliberately not converted, and so deliberately not read: a centilitre is exactly ten millilitres
  // and an ounce is not exactly anything useful without knowing what it measures. `cl` we could
  // convert and choose not to, because a receipt that prints cl is not one this shop's aliases cover
  // and a quantity we never see is better than one we half-support.
  cl: null, oz: null, lb: null,
};

function skipRule(text: string): SkipRule | null {
  const t = text.trim();
  if (!t) return "blank";
  if (SEPARATOR.test(t)) return "separator";
  if (!HAS_LETTER.test(t)) return "no_letters";
  if (TOTALS.test(t)) return "totals";
  if (PAYMENT.test(t)) return "payment";
  if (FURNITURE.test(t)) return "shop_furniture";
  if (DATE_OR_TIME.test(t)) return "date_or_time";
  return null;
}

/** Tidy what is left of a line into something a resolver can be asked about. */
function tidy(name: string): string {
  return name
    .replace(CODE, " ")
    .replace(/[*#]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-.,:]+|[\s\-.,:]+$/g, "")
    .toLowerCase();
}

/**
 * Read a receipt into purchases and skipped lines.
 *
 * Pure, and exported on its own so it can be tested against a saved receipt without a store, a user
 * or a clock. Every input line appears in exactly one of the two output arrays.
 */
export function parseReceipt(text: string): ReceiptParse {
  const purchases: ReceiptLine[] = [];
  const skipped: SkippedLine[] = [];

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const rule = skipRule(raw);
    if (rule) {
      skipped.push({ line, text: raw.trim(), rule });
      return;
    }

    let rest = raw.trim();

    // 1. The price at the end, before anything else could mistake it for an amount.
    //
    //    A line with no price is not a purchase. That is not a heuristic about layout, it is what a
    //    receipt is: the shop charged for it, so it printed what it charged. It is also the rule
    //    that disposes of everything around the shopping — the shop's name, its address, a loyalty
    //    message, a footer nobody could enumerate — without a list of things to look for.
    //
    //    A shop that prints prices on their own line breaks this, and breaks it *loudly*: every item
    //    comes back skipped as `no_price` rather than quietly missing. A receipt reader that fails
    //    visibly can be fixed. Same for a currency printed without decimals, which this does not
    //    read, because `CHICKPEAS 400` would then be a price and a pack size at once.
    const price = TRAILING_PRICE.exec(rest);
    if (!price) {
      skipped.push({ line, text: rest, rule: "no_price" });
      return;
    }
    const priceCents = Number(price[1]) * 100 + Number(price[2]);
    rest = rest.slice(0, price.index).trim();

    // 2. The shop showing its working. Removed and not read: a total divided by a unit price is a
    //    quantity we worked out, not one anybody printed, and the difference is the whole point.
    rest = rest.replace(UNIT_PRICE, " ").trim();

    // 3. A leading count. `2 X TOMATOES` is two pieces.
    let qtyMilli: number | null = null;
    let unit: Unit = "pc";
    const count = LEADING_COUNT.exec(rest);
    if (count) {
      qtyMilli = milliOrNull(Number(count[1]));
      rest = rest.slice(count[0].length).trim();
    }

    // 4. A printed weight or volume. It beats a count: `2 X CHICKPEAS 400G` bought 400 g twice over,
    //    and we are not entitled to multiply them — that is a pack size, and two packs of it is a
    //    fact about packaging we do not have. So the amount wins and the count is dropped, which
    //    understates rather than invents.
    const amount = AMOUNT.exec(rest);
    if (amount) {
      const word = UNIT_WORDS[amount[2].toLowerCase()];
      if (word) {
        const milli = milliOrNull(Number(amount[1].replace(",", ".")));
        if (milli !== null) {
          const canonical = canonicalAmount(milli, word);
          qtyMilli = canonical.qty_milli;
          unit = canonical.unit;
          rest = `${rest.slice(0, amount.index)} ${rest.slice(amount.index + amount[0].length)}`;
        }
      }
    }

    const name = tidy(rest);
    if (!name || !HAS_LETTER.test(name)) {
      skipped.push({ line, text: raw.trim(), rule: "no_name_left" });
      return;
    }
    purchases.push({ line, text: raw.trim(), name, qty_milli: qtyMilli, unit, price_cents: priceCents });
  });

  return { purchases, skipped };
}

/** What a skipped line means, for a person reading the ingest response. */
export const SKIP_REASON: Record<SkipRule, string> = {
  blank: "an empty line",
  no_letters: "no words on it, so nothing to look up",
  separator: "a rule drawn across the receipt",
  totals: "the arithmetic at the foot of the receipt",
  payment: "how it was paid for",
  shop_furniture: "the shop's own printing, not shopping",
  date_or_time: "a date or a time",
  no_price: "no price on it, so the shop did not charge for it",
  no_name_left: "nothing but a price and a code — no name to look up",
};

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${what} is required`);
  return value;
}

export const receiptSource: PantrySource<ReceiptPayload> = {
  kind: "receipt",
  // Never `confirmed`, and this is the interesting decision in the file.
  //
  // A barcode scan may say confirmed because a person held the thing and put it away. A receipt is a
  // document, and it proves something narrower than it appears to: the shop sold it. It does not say
  // the food reached the kitchen, that it was for this household, that it was not eaten on the way
  // or given to somebody, or that the abbreviation on line 7 means what the alias table thinks it
  // means. Every one of those gaps is small; the point is that nobody checked them.
  //
  // `inferred` is not a hedge here, it is a hook: the pantry audit asks about inferred lines, so a
  // receipt puts food in the pantry *and* puts a question in the queue for the person to settle. The
  // person confirming "yes, four tomatoes" is what makes it confirmed, and nothing else should.
  maxConfidence: "inferred",

  toEvents(payload: ReceiptPayload, ctx: SourceContext): SourceReading {
    const text = requireString(payload?.text, "text");
    const purchasedAt = payload?.purchased_at;
    if (!isIsoTimestamp(purchasedAt)) throw new TypeError("purchased_at must be an ISO 8601 timestamp");
    if (payload.location !== undefined && payload.location !== null && typeof payload.location !== "string") {
      throw new TypeError("location must be a string when given");
    }

    const { purchases, skipped } = parseReceipt(text);
    const events: PantryEvent[] = [];
    const unmapped: UnmappedItem[] = [];
    // A receipt often has the same food twice — two lines of tomatoes, or the same tin at two
    // prices. Both are real purchases and both become events; the ledger folds them.
    const location = payload.location?.trim() || "pantry";
    const merchant = payload.merchant?.trim() || null;

    for (const p of purchases) {
      const id = ctx.resolve(p.name);
      if (!id) {
        unmapped.push({ raw_name: p.name, reason: `line ${p.line}: no ingredient of ours is called that` });
        continue;
      }
      events.push({
        ts: purchasedAt,
        // The receipt's own line number, so the order of the ledger is the order of the receipt and
        // re-reading the same receipt lands the same events in the same places.
        seq: p.line,
        type: "add",
        ingredient_id: id,
        qty_milli: p.qty_milli,
        unit: p.unit,
        origin: "receipt",
        confidence: "inferred",
        location,
        // A receipt never prints a use-by date. The shelf-life table estimates one, and says it did.
        expires_on: null,
        external_id: `receipt:${merchant ?? "shop"}:${purchasedAt}:${p.line}`,
        source_device: merchant,
      });
    }

    // Skipped lines are not unmapped items — a total is not a food we failed to recognise — but they
    // must still be visible, or a receipt whose format we read badly looks like a short shop.
    for (const s of skipped) {
      if (s.rule === "no_name_left") {
        unmapped.push({ raw_name: s.text, reason: `line ${s.line}: ${SKIP_REASON[s.rule]}` });
      }
    }

    return { events, unmapped };
  },
};

/** The date a receipt was printed, when it prints one, for a caller that has only the text. Returns
 *  null rather than today: a receipt with no date is not a receipt from today. */
export function receiptDate(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const m = /(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    if (m && isIsoDate(m[0])) return m[0];
  }
  return null;
}
