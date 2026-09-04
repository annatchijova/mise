// The pantry by voice: what the person said, as ledger events.
//
// Alexa+ has already done the language work by the time this runs — it extracted "two onions, half
// a kilo of red lentils, and the tofu expires Friday" into items with a name, a number, a unit and
// a date. What is left is deterministic: resolve each name to a canonical ingredient, turn the
// number into milli-units, and stamp the event `voice` / `confirmed`, because the person said it.
// A name we do not know is reported back, never guessed; Alexa+ can ask.
import type { Resolver } from "../integrations/aliases.ts";
import { type EventType, type PantryEvent, type Unit, canonicalAmount, isIsoDate, toMilli } from "./events.ts";

export const UNITS: readonly Unit[] = [
  "g", "kg", "ml", "l", "tsp", "tbsp", "cup", "pc", "clove", "pinch", "slice", "bunch", "can", "sachet", "to_taste",
];

export type VoiceItem = {
  name: string;
  qty?: number | null;
  unit?: string | null;
  /** YYYY-MM-DD, already resolved by Alexa+ from "Friday". */
  expires?: string | null;
  location?: string | null;
};

export type VoiceMode = "add" | "consume" | "correct" | "remove";

export type VoiceResult = {
  events: PantryEvent[];
  /** What could not become an event, with the reason to say back. */
  rejected: { name: string; reason: string }[];
};

const MODE_TO_TYPE: Record<VoiceMode, EventType> = { add: "add", consume: "consume", correct: "correct", remove: "remove" };

export function voiceEvents(
  items: VoiceItem[],
  mode: VoiceMode,
  ctx: { now: string; resolve: Resolver; defaultLocation?: string },
): VoiceResult {
  const events: PantryEvent[] = [];
  const rejected: VoiceResult["rejected"] = [];
  const type = MODE_TO_TYPE[mode];

  items.forEach((item, index) => {
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    if (!name) { rejected.push({ name: "", reason: "an item with no name" }); return; }
    const id = ctx.resolve(name);
    if (!id) { rejected.push({ name, reason: "I don't know that ingredient yet" }); return; }

    const unit = (item.unit ?? "pc") as Unit;
    if (!UNITS.includes(unit)) { rejected.push({ name, reason: `'${String(item.unit)}' is not a unit I keep` }); return; }

    let qtyMilli: number | null = null;
    if (item.qty !== undefined && item.qty !== null) {
      if (typeof item.qty !== "number" || !Number.isFinite(item.qty) || item.qty <= 0) {
        rejected.push({ name, reason: "the amount has to be a positive number" }); return;
      }
      try { qtyMilli = toMilli(item.qty); } catch { rejected.push({ name, reason: "the amount is finer than a thousandth of a unit" }); return; }
    }
    // Removing needs no amount; the other modes without one record "some, amount unknown".

    let expires: string | null = null;
    if (item.expires !== undefined && item.expires !== null && item.expires !== "") {
      if (!isIsoDate(item.expires)) { rejected.push({ name, reason: `'${String(item.expires)}' is not a date I can keep` }); return; }
      expires = item.expires;
    }

    const amount = canonicalAmount(type === "remove" ? null : qtyMilli, unit);
    events.push({
      ts: ctx.now,
      seq: index,
      type,
      ingredient_id: id,
      qty_milli: amount.qty_milli,
      unit: amount.unit,
      origin: "voice",
      confidence: "confirmed",
      location: typeof item.location === "string" && item.location.trim() ? item.location.trim() : (ctx.defaultLocation ?? "pantry"),
      expires_on: expires,
      external_id: null,
      source_device: null,
    });
  });

  return { events, rejected };
}
