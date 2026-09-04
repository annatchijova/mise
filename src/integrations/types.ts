// The adapter contract every integration implements.
//
// An integration is a producer of pantry events or a translator of recipes. Never a tool. Nothing
// here touches the network: `toEvents` is a pure function from a payload someone else fetched to
// events, which is what makes each adapter testable against a saved fixture instead of a live fridge.
//
// The ceiling is the point. A source declares the strongest thing it is entitled to claim, and
// `runSource` clamps every event down to it, so an adapter cannot promise certainty its sensor does
// not have — a camera that recognizes "there are tomatoes" is not a person saying "I have four".
import type { PantryEvent, StoredConfidence } from "../pantry/events.ts";

export type SourceKind = "smartthings" | "barcode" | "receipt" | "simulated";

/** A food name a source reported that we could not map to a canonical ingredient id. Surfaced, not
 *  dropped and not guessed: pantry_list can say "your fridge reported 'kimchi', which I don't know yet". */
export type UnmappedItem = {
  raw_name: string;
  reason: string;
};

export type SourceReading = {
  events: PantryEvent[];
  unmapped: UnmappedItem[];
};

export type SourceContext = {
  userId: string;
  /** ISO 8601. The adapter must not read the clock itself — determinism, and testability. */
  now: string;
  /** Resolve an external food name to a canonical ingredient id, or null. */
  resolve: (rawName: string) => string | null;
};

export type PantrySource<Payload> = {
  kind: SourceKind;
  /** The strongest confidence this source may assert. Enforced by `runSource`, not by trust. */
  maxConfidence: StoredConfidence;
  toEvents: (payload: Payload, ctx: SourceContext) => SourceReading;
};

const RANK: Record<StoredConfidence, number> = { confirmed: 2, inferred: 1 };

/** Run an adapter and clamp what it claims. The only supported way to call an adapter. */
export function runSource<P>(source: PantrySource<P>, payload: P, ctx: SourceContext): SourceReading {
  const reading = source.toEvents(payload, ctx);
  const ceiling = source.maxConfidence;
  return {
    events: reading.events.map((e) =>
      RANK[e.confidence] > RANK[ceiling] ? { ...e, confidence: ceiling } : e,
    ),
    unmapped: reading.unmapped,
  };
}
