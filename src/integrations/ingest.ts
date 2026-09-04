// The door external systems come in through.
//
// POST /ingest/:kind carries a payload for one adapter. Before an adapter sees a byte, three things
// are settled here, in this order:
//
//   1. Who is speaking. The body is HMAC-signed with a secret bound to one connected source, and the
//      source is bound to one user. A bad or missing signature is a 401 and nothing is read.
//   2. Whether we have seen this delivery. The Idempotency-Key is remembered with a hash of the body:
//      the same key with the same body is answered again with the same 202 and no new events; the
//      same key with a different body is a 409. Fridges and webhook relays retry; the ledger must not
//      double.
//   3. What the adapter is allowed to claim. `runSource` clamps confidence to the source's ceiling.
//
// The payload is data from an outside system, never an instruction. It becomes ledger events with
// its origin stamped on them, and that is all it can ever become.
import { createHmac, timingSafeEqual } from "node:crypto";

import type { PantryStore } from "../pantry/store.ts";
import { bodyHash } from "../pantry/store.ts";
import type { Resolver } from "./aliases.ts";
import { type PantrySource, type SourceKind, type UnmappedItem, runSource } from "./types.ts";

export const SIGNATURE_HEADER = "x-mise-signature";
export const IDEMPOTENCY_HEADER = "idempotency-key";

/** A connected source: one secret, one user, one adapter kind. Block B stores these per user. */
export type ConnectedSource = {
  id: string;
  userId: string;
  kind: SourceKind;
  secret: string;
  label: string;
};

export function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/** Constant-time comparison of a presented signature against the expected one. */
export function verify(secret: string, body: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const expected = Buffer.from(sign(secret, body), "utf8");
  const given = Buffer.from(presented.trim(), "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export type IngestResult = {
  status: 202 | 400 | 401 | 404 | 409 | 503;
  body: {
    ok: boolean;
    message: string;
    source?: string;
    accepted?: number;
    unmapped?: UnmappedItem[];
    replay?: boolean;
  };
};

export type IngestDeps = {
  store: PantryStore;
  resolve: Resolver;
  adapters: Partial<Record<SourceKind, PantrySource<unknown>>>;
  /** Look a source up by its id (from the URL). */
  findSource: (sourceId: string) => ConnectedSource | undefined;
  now: () => string;
  /** Optional per-kind step that completes a payload before the adapter sees it — the barcode
   *  lookup, for instance. It runs after signature and idempotency, so a forged or replayed
   *  delivery never triggers an outbound call. */
  enrich?: Partial<Record<SourceKind, (payload: unknown) => Promise<unknown>>>;
};

export async function ingest(
  deps: IngestDeps,
  input: { sourceId: string; body: string; headers: Record<string, string | undefined> },
): Promise<IngestResult> {
  const source = deps.findSource(input.sourceId);
  if (!source) return { status: 404, body: { ok: false, message: "No such connected source." } };

  if (!verify(source.secret, input.body, input.headers[SIGNATURE_HEADER])) {
    return { status: 401, body: { ok: false, message: "Bad or missing signature." } };
  }

  const adapter = deps.adapters[source.kind];
  if (!adapter) {
    return { status: 503, body: { ok: false, message: `No adapter is enabled for '${source.kind}'.` } };
  }

  const key = input.headers[IDEMPOTENCY_HEADER]?.trim();
  if (!key) return { status: 400, body: { ok: false, message: "Idempotency-Key header is required." } };

  let payload: unknown;
  try {
    payload = JSON.parse(input.body);
  } catch {
    return { status: 400, body: { ok: false, message: "Body is not valid JSON." } };
  }

  const outcome = await deps.store.rememberKey(`${source.userId}:${source.id}`, key, bodyHash(input.body));
  if (outcome === "conflict") {
    return { status: 409, body: { ok: false, message: "Idempotency-Key was already used with a different body." } };
  }
  if (outcome === "replay") {
    return { status: 202, body: { ok: true, message: "Already accepted.", source: source.id, accepted: 0, replay: true } };
  }

  const enrich = deps.enrich?.[source.kind];
  const completed = enrich ? await enrich(payload) : payload;
  const reading = runSource(adapter, completed, { userId: source.userId, now: deps.now(), resolve: deps.resolve });
  await deps.store.append(source.userId, reading.events);
  return {
    status: 202,
    body: {
      ok: true,
      message: `Accepted ${reading.events.length} event${reading.events.length === 1 ? "" : "s"}.`,
      source: source.id,
      accepted: reading.events.length,
      unmapped: reading.unmapped,
    },
  };
}
