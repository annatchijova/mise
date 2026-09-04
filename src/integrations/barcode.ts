// A scanned barcode, as a pantry source.
//
// The scan itself is a person's act — they held the thing — so this source may say `confirmed`,
// which the fridge camera may not. What the barcode does not tell us is what the thing *is* in
// recipe terms: for that we go through Open Food Facts, whose product record carries a name and
// category tags, and then through the same resolver every other source uses. The lookup happens
// in the ingest route (network, timeout, cache); this adapter only sees the result, so it stays
// pure and testable against a saved product record.
//
// Open Food Facts: GET https://world.openfoodfacts.org/api/v2/product/{ean}?fields=... — public,
// no key. Verified against its published documentation; the field names below are the ones that
// documentation lists.
import { type PantryEvent, type Unit, isIsoDate, isIsoTimestamp, milliOrNull } from "../pantry/events.ts";
import { type PantrySource, type SourceContext, type SourceReading, type UnmappedItem } from "./types.ts";

/** The subset of an Open Food Facts product record this adapter reads. */
export type OffProduct = {
  code?: string;
  product_name?: string;
  product_name_en?: string;
  brands?: string;
  /** e.g. "250 g", "1 L" — the package size as printed. */
  quantity?: string;
  /** e.g. ["en:plant-based-foods", "en:legumes", "en:tofu"], general to specific. */
  categories_tags?: string[];
};

export type BarcodeScan = {
  ean: string;
  /** ISO 8601, from the scanning device. */
  scanned_at: string;
  /** Optional, from the person: how many packages, and where they went. */
  packages?: number | null;
  location?: string | null;
  expires_on?: string | null;
};

export type BarcodePayload = {
  scan: BarcodeScan;
  /** null when the lookup failed or the code is unknown to Open Food Facts. */
  product: OffProduct | null;
};

const UNITS = new Set<Unit>(["g", "kg", "ml", "l", "pc"]);
const PACKAGE = /^\s*(\d+(?:[.,]\d+)?)\s*(g|kg|ml|l)\b/i;

/** "250 g" -> [250000, "g"] in milli-units. Anything else -> null: we do not guess package sizes. */
export function parsePackage(quantity: string | undefined): [number, Unit] | null {
  if (typeof quantity !== "string") return null;
  const m = PACKAGE.exec(quantity);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  const unit = m[2].toLowerCase() as Unit;
  if (!UNITS.has(unit)) return null;
  const milli = milliOrNull(n);
  return milli === null ? null : [milli, unit];
}

/** The names worth trying, most specific first: the product name, then category tags from the
 *  most specific to the most general. The first that resolves wins. */
export function candidateNames(product: OffProduct): string[] {
  const names: string[] = [];
  for (const n of [product.product_name_en, product.product_name]) if (typeof n === "string" && n.trim()) names.push(n.trim());
  const tags = Array.isArray(product.categories_tags) ? [...product.categories_tags].reverse() : [];
  for (const t of tags) if (typeof t === "string") names.push(t.replace(/^[a-z]{2}:/, "").replace(/-/g, " "));
  return names;
}

export const barcodeSource: PantrySource<BarcodePayload> = {
  kind: "barcode",
  // A person scanned a physical package. That is a confirmation, not an inference.
  maxConfidence: "confirmed",

  toEvents(payload: BarcodePayload, ctx: SourceContext): SourceReading {
    const unmapped: UnmappedItem[] = [];
    const scan = payload?.scan;
    const product = payload?.product ?? null;
    const ean = typeof scan?.ean === "string" ? scan.ean.trim() : "";
    if (!ean) return { events: [], unmapped: [{ raw_name: "", reason: "scan carried no barcode" }] };

    // The scan time is the event time and half of its external id. A device that sends a bad one
    // gets the reading rejected, not a guessed time.
    const scannedAt = scan.scanned_at === undefined || scan.scanned_at === null || scan.scanned_at === "" ? ctx.now : scan.scanned_at;
    if (!isIsoTimestamp(scannedAt)) {
      return { events: [], unmapped: [{ raw_name: ean, reason: `scanned_at '${String(scan.scanned_at)}' is not an ISO 8601 timestamp` }] };
    }

    if (!product) {
      unmapped.push({ raw_name: ean, reason: "barcode not found in Open Food Facts, or the lookup failed" });
      return { events: [], unmapped };
    }

    let id: string | null = null;
    const tried = candidateNames(product);
    for (const name of tried) {
      id = ctx.resolve(name);
      if (id) break;
    }
    if (!id) {
      unmapped.push({
        raw_name: typeof product.product_name === "string" ? product.product_name : ean,
        reason: `no canonical ingredient id for any of: ${tried.join(" | ") || "(no names on the record)"}`,
      });
      return { events: [], unmapped };
    }

    let expires: string | null = null;
    if (scan.expires_on !== undefined && scan.expires_on !== null && scan.expires_on !== "") {
      if (isIsoDate(scan.expires_on)) expires = scan.expires_on;
      else unmapped.push({ raw_name: ean, reason: `expires_on '${String(scan.expires_on)}' is not a YYYY-MM-DD date; the item was kept without a date` });
    }

    // Quantity: the package size times how many packages, when both are known. If the person did
    // not say how many, one package is NOT assumed — the amount is unknown and the line says so.
    const pkg = parsePackage(product.quantity);
    const packages = scan.packages;
    const known = pkg !== null && typeof packages === "number" && Number.isInteger(packages) && packages > 0;
    const events: PantryEvent[] = [{
      ts: scannedAt,
      seq: 0,
      type: "add",
      ingredient_id: id,
      qty_milli: known ? pkg![0] * packages : null,
      unit: pkg ? pkg[1] : "pc",
      origin: "barcode",
      confidence: "confirmed",
      location: typeof scan.location === "string" && scan.location.trim() ? scan.location.trim() : "pantry",
      expires_on: expires,
      external_id: `barcode:${ean}:${scannedAt}`,
      source_device: null,
    }];
    return { events, unmapped };
  },
};
