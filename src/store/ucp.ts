// The demo store's checkout surface, shaped after UCP.
//
// ⚠ What is verified and what is not. The behaviour here follows the summary of the Universal
// Commerce Protocol written down in docs/PLAN.md §06 — five endpoints plus a profile, always 200
// with the session state, `messages[]` for commercial errors, `Idempotency-Key` on state-changing
// calls with 409 on a reused key and a different body, `Cache-Control: no-store`, a six hour TTL,
// and the `stored_payment_method` handler. It has **not** been checked field by field against the
// specification or against a real Alexa+ client, because neither is reachable from where this was
// written. docs/BLOCKED.md keeps that admission where somebody will find it before the demo. Treat
// the field names as this project's reading of the protocol, not as conformance.
//
// What is not in doubt is the part that matters to a shopper:
//
//   - **Prices come from the catalog, never from the request.** An agent sends SKU ids and counts;
//     the money is looked up here. A store that takes the price it is handed is one crafted payload
//     away from selling everything for a cent.
//   - **Idempotency is a claim, not a check.** The same three-step claim/commit/release the pantry
//     ingest uses, one layer up: a retried Complete cannot charge twice or ship twice.
//   - **Allergens are disclosed at checkout**, from the SKUs actually in the basket, as a message
//     the surface is expected to show rather than a field somebody has to think to read.
//   - **Completing writes to the pantry.** That is the loop closing: what you bought is in the
//     kitchen, and the next `plan_week` already sees it.
import { createHash } from "node:crypto";

import type { PantryEvent, Unit } from "../pantry/events.ts";
import { canonicalAmount, toMilli } from "../pantry/events.ts";
import type { PantryStore } from "../pantry/store.ts";
import { type Catalog, type SkuIndex, allergensOf, money, totalsFor } from "./catalog.ts";

export const UCP_VERSION = "2026-04-08";
export const PAYMENT_HANDLER = "com.amazon.payments.stored_payment_method";
/** Six hours, as docs/PLAN.md §06 records. A checkout nobody finished should not be finishable
 *  tomorrow at yesterday's prices. */
export const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

export type CheckoutStatus = "incomplete" | "ready_for_complete" | "completed" | "canceled" | "expired";

export type CheckoutLineItem = {
  id: string;
  sku_id: string;
  title: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
};

export type CheckoutMessage = {
  code: string;
  severity: "info" | "warning" | "error";
  /** "disclosure" is the one the surface is expected to show before the customer commits. */
  presentation: "disclosure" | "inline" | "toast";
  content: string;
};

export type PaymentMethod = { id: string; type: string; brand: string; last4: string; label: string };

export type Address = { name?: string; line1?: string; city?: string; postal_code?: string; country?: string };

export type CheckoutSession = {
  id: string;
  status: CheckoutStatus;
  user_id: string;
  currency: string;
  merchant_of_record: string;
  refund_policy_url: string;
  line_items: CheckoutLineItem[];
  totals: { subtotal_cents: number; tax_cents: number; shipping_cents: number; total_cents: number };
  payment_methods: PaymentMethod[];
  fulfillment: { method: "delivery"; address: Address | null; eta_days: number | null };
  messages: CheckoutMessage[];
  order: { id: string; receipt_url: string } | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

export type CheckoutStore = {
  get(id: string): Promise<CheckoutSession | null>;
  /** For the receipt link. The order id is the capability: it is unguessable and it is the only
   *  thing needed to see the receipt, the way a receipt link normally works. */
  getByOrder(orderId: string): Promise<CheckoutSession | null>;
  put(session: CheckoutSession): Promise<void>;
};

export class MemoryCheckoutStore implements CheckoutStore {
  private sessions = new Map<string, CheckoutSession>();
  async get(id: string): Promise<CheckoutSession | null> {
    return this.sessions.get(id) ?? null;
  }
  async getByOrder(orderId: string): Promise<CheckoutSession | null> {
    for (const s of this.sessions.values()) if (s.order?.id === orderId) return s;
    return null;
  }
  async put(session: CheckoutSession): Promise<void> {
    this.sessions.set(session.id, session);
  }
}

/** The fictional instruments the demo store holds for a customer. They are returned at Create and
 *  validated at Complete against the same customer: an id from somebody else's session is refused,
 *  which is the one security property `stored_payment_method` actually asks the merchant for. */
export function instrumentsFor(userId: string): PaymentMethod[] {
  const tag = createHash("sha256").update(userId, "utf8").digest("hex").slice(0, 4);
  return [
    { id: `pm_${tag}_visa`, type: PAYMENT_HANDLER, brand: "Visa", last4: "4242", label: "Visa ending 4242 (demo)" },
    { id: `pm_${tag}_mc`, type: PAYMENT_HANDLER, brand: "Mastercard", last4: "5454", label: "Mastercard ending 5454 (demo)" },
  ];
}

export type UcpDeps = {
  catalog: Catalog;
  index: SkuIndex;
  sessions: CheckoutStore;
  pantry: PantryStore;
  /** Bearer token to account. Null when the token is missing or not one we issued. */
  userFor: (bearer: string | null) => string | null;
  now: () => string;
  newId: (prefix: string) => string;
  baseUrl: string;
};

export type UcpRequest = {
  method: string;
  /** Path with the /store prefix already stripped, e.g. "/checkout-sessions/cs_x/complete". */
  path: string;
  body: string;
  headers: Record<string, string | undefined>;
};

export type UcpResponse = { status: number; body: unknown };

const jsonOf = (body: string): unknown | undefined => {
  if (body.trim() === "") return {};
  try { return JSON.parse(body); } catch { return undefined; }
};

const bearerOf = (headers: Record<string, string | undefined>): string | null => {
  const raw = headers.authorization ?? headers.Authorization;
  if (typeof raw !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1] : null;
};

function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function disclosureFor(deps: UcpDeps, session: CheckoutSession): CheckoutMessage[] {
  const skus = session.line_items.map((l) => deps.index.byId.get(l.sku_id)).filter((s) => s !== undefined);
  const allergens = allergensOf(skus);
  if (allergens.length === 0) return [];
  return [{
    code: "allergen_disclosure",
    severity: "info",
    presentation: "disclosure",
    content: `Contains ${allergens.join(", ")}. Declared per item: ${skus
      .filter((s) => s.allergens.length > 0)
      .map((s) => `${s.title} (${s.allergens.join(", ")})`)
      .join("; ")}.`,
  }];
}

function priceSession(deps: UcpDeps, session: CheckoutSession): CheckoutSession {
  const subtotal = session.line_items.reduce((sum, l) => sum + l.total_cents, 0);
  const totals = totalsFor(subtotal, deps.catalog.store);
  // Shipping is only charged once there is somewhere to ship to; before that the total is honest
  // about being incomplete rather than quoting a number that will change.
  const shipping = session.fulfillment.address === null ? 0 : totals.shipping_cents;
  return {
    ...session,
    totals: { ...totals, shipping_cents: shipping, total_cents: totals.subtotal_cents + totals.tax_cents + shipping },
    messages: [
      ...disclosureFor(deps, session),
      ...(session.fulfillment.address === null
        ? [{ code: "shipping_pending", severity: "info" as const, presentation: "inline" as const, content: "Delivery is not priced until there is an address." }]
        : []),
    ],
  };
}

function expired(session: CheckoutSession, now: string): boolean {
  return Date.parse(now) > Date.parse(session.expires_at);
}

function withExpiry(session: CheckoutSession, now: string): CheckoutSession {
  if (session.status === "completed" || session.status === "canceled") return session;
  return expired(session, now) ? { ...session, status: "expired" } : session;
}

// --- the routes --------------------------------------------------------------------------------

export function ucpProfile(deps: UcpDeps): unknown {
  return {
    version: UCP_VERSION,
    capabilities: ["dev.ucp.shopping.checkout"],
    merchant_of_record: deps.catalog.store.merchant_of_record,
    currency: deps.catalog.currency,
    payment: { handlers: [PAYMENT_HANDLER] },
    endpoints: {
      create: `${deps.baseUrl}/store/checkout-sessions`,
      retrieve: `${deps.baseUrl}/store/checkout-sessions/{id}`,
      update: `${deps.baseUrl}/store/checkout-sessions/{id}`,
      complete: `${deps.baseUrl}/store/checkout-sessions/{id}/complete`,
      cancel: `${deps.baseUrl}/store/checkout-sessions/{id}/cancel`,
    },
    refund_policy_url: `${deps.baseUrl}${deps.catalog.store.refund_policy_url}`,
    session_ttl_seconds: SESSION_TTL_MS / 1000,
    /** Said in the profile as well as in the docs, so nobody integrates against this by accident. */
    disclaimer: "Demo store for a hackathon entry. Not conformance-tested against the UCP specification; see docs/BLOCKED.md.",
  };
}

/**
 * Handle a checkout call.
 *
 * Returns null when the path is not ours, so the HTTP layer can go on looking. Protocol failures —
 * no token, no idempotency key, a session nobody has — come back as real status codes; commercial
 * failures — out of stock, an item we do not sell — come back as 200 with the session and a
 * message, which is what an agent-driven checkout needs in order to say something useful instead of
 * throwing.
 */
export async function handleUcp(deps: UcpDeps, req: UcpRequest): Promise<UcpResponse | null> {
  const { path } = req;
  if (path === "/.well-known/ucp" && req.method === "GET") return { status: 200, body: ucpProfile(deps) };
  if (!path.startsWith("/checkout-sessions")) return null;

  const userId = deps.userFor(bearerOf(req.headers));
  if (!userId) {
    return { status: 401, body: { error: "unauthorized", message: "Checkout needs a bearer token this store issued." } };
  }

  const rest = path.slice("/checkout-sessions".length);
  const now = deps.now();

  if (rest === "" || rest === "/") {
    if (req.method !== "POST") return { status: 405, body: { error: "method_not_allowed" } };
    return await create(deps, req, userId, now);
  }

  const parts = rest.split("/").filter(Boolean);
  const sessionId = parts[0];
  const action = parts[1];
  const stored = await deps.sessions.get(sessionId);
  if (!stored || stored.user_id !== userId) {
    // Same answer either way: a session belonging to somebody else must not be distinguishable
    // from one that never existed.
    return { status: 404, body: { error: "not_found", message: "No such checkout session." } };
  }
  const session = withExpiry(stored, now);

  if (action === undefined) {
    if (req.method === "GET") return { status: 200, body: session };
    if (req.method === "PUT") return await update(deps, req, session, now);
    return { status: 405, body: { error: "method_not_allowed" } };
  }
  if (action === "complete" && req.method === "POST") return await complete(deps, req, session, now);
  if (action === "cancel" && req.method === "POST") return await cancel(deps, req, session, now);
  return { status: 404, body: { error: "not_found" } };
}

/** Reserve the idempotency key for this call, or say what to do instead. */
async function guard(
  deps: UcpDeps,
  req: UcpRequest,
  scope: string,
): Promise<{ ok: true; key: string } | { ok: false; response: UcpResponse }> {
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || key.trim() === "") {
    return { ok: false, response: { status: 400, body: { error: "idempotency_key_required", message: "State-changing calls need an Idempotency-Key header." } } };
  }
  const outcome = await deps.pantry.claimKey(scope, key, hashBody(req.body));
  if (outcome === "new") return { ok: true, key };
  if (outcome === "conflict") {
    return { ok: false, response: { status: 409, body: { error: "idempotency_conflict", message: "That Idempotency-Key was used for a different body." } } };
  }
  if (outcome === "in_flight") {
    return { ok: false, response: { status: 409, body: { error: "in_flight", message: "The same call is still being processed. Retry in a moment." } } };
  }
  return { ok: false, response: { status: 200, body: { replayed: true, message: "Already done; nothing was repeated." } } };
}

async function create(deps: UcpDeps, req: UcpRequest, userId: string, now: string): Promise<UcpResponse> {
  const claim = await guard(deps, req, `ucp:create:${userId}`);
  if (!claim.ok) return claim.response;

  try {
    const body = jsonOf(req.body) as { line_items?: { sku_id?: string; id?: string; quantity?: number }[] } | undefined;
    if (body === undefined) return { status: 400, body: { error: "invalid_json" } };
    const requested = body.line_items ?? [];

    const lineItems: CheckoutLineItem[] = [];
    const messages: CheckoutMessage[] = [];
    for (const [n, item] of requested.entries()) {
      const skuId = item.sku_id ?? item.id ?? "";
      const sku = deps.index.byId.get(skuId);
      if (!sku) {
        messages.push({ code: "unknown_item", severity: "error", presentation: "inline", content: `We do not sell ${skuId || "that"}.` });
        continue;
      }
      const quantity = Math.max(1, Math.floor(item.quantity ?? 1));
      if (quantity > sku.stock) {
        messages.push({ code: "out_of_stock", severity: "warning", presentation: "inline", content: `Only ${sku.stock} of ${sku.title} left; the rest was not added.` });
        if (sku.stock === 0) continue;
      }
      const q = Math.min(quantity, sku.stock);
      lineItems.push({
        id: `li_${n}_${sku.id}`,
        sku_id: sku.id,
        title: sku.title,
        quantity: q,
        // The price is read here and nowhere else. Whatever the request said about money is ignored.
        unit_price_cents: sku.price_cents,
        total_cents: sku.price_cents * q,
      });
    }

    const created = new Date(Date.parse(now));
    const session: CheckoutSession = priceSession(deps, {
      id: deps.newId("cs"),
      status: lineItems.length === 0 ? "incomplete" : "incomplete",
      user_id: userId,
      currency: deps.catalog.currency,
      merchant_of_record: deps.catalog.store.merchant_of_record,
      refund_policy_url: `${deps.baseUrl}${deps.catalog.store.refund_policy_url}`,
      line_items: lineItems,
      totals: { subtotal_cents: 0, tax_cents: 0, shipping_cents: 0, total_cents: 0 },
      payment_methods: instrumentsFor(userId),
      fulfillment: { method: "delivery", address: null, eta_days: null },
      messages: [],
      order: null,
      created_at: now,
      updated_at: now,
      expires_at: new Date(created.getTime() + SESSION_TTL_MS).toISOString(),
    });
    session.messages = [...session.messages, ...messages];
    await deps.sessions.put(session);
    await deps.pantry.commitKey(`ucp:create:${userId}`, claim.key);
    return { status: 200, body: session };
  } catch (err) {
    await deps.pantry.releaseKey(`ucp:create:${userId}`, claim.key);
    throw err;
  }
}

async function update(deps: UcpDeps, req: UcpRequest, session: CheckoutSession, now: string): Promise<UcpResponse> {
  if (session.status === "completed" || session.status === "canceled" || session.status === "expired") {
    return { status: 200, body: { ...session, messages: [...session.messages, { code: "not_updatable", severity: "error", presentation: "inline", content: `This checkout is ${session.status}.` }] } };
  }
  const claim = await guard(deps, req, `ucp:update:${session.id}`);
  if (!claim.ok) return claim.response;

  try {
    const body = jsonOf(req.body) as { fulfillment?: { address?: Address } } | undefined;
    if (body === undefined) return { status: 400, body: { error: "invalid_json" } };
    const address = body.fulfillment?.address ?? null;

    let next: CheckoutSession = {
      ...session,
      fulfillment: { method: "delivery", address, eta_days: address ? 2 : null },
      updated_at: now,
    };
    next = priceSession(deps, next);
    // Ready to be completed only once there is something to buy and somewhere to send it.
    next.status = next.line_items.length > 0 && address !== null ? "ready_for_complete" : "incomplete";
    await deps.sessions.put(next);
    await deps.pantry.commitKey(`ucp:update:${session.id}`, claim.key);
    return { status: 200, body: next };
  } catch (err) {
    await deps.pantry.releaseKey(`ucp:update:${session.id}`, claim.key);
    throw err;
  }
}

async function complete(deps: UcpDeps, req: UcpRequest, session: CheckoutSession, now: string): Promise<UcpResponse> {
  if (session.status === "completed") return { status: 200, body: session };
  if (session.status === "canceled" || session.status === "expired") {
    return { status: 200, body: { ...session, messages: [{ code: "not_completable", severity: "error", presentation: "inline", content: `This checkout is ${session.status}.` }] } };
  }
  const claim = await guard(deps, req, `ucp:complete:${session.id}`);
  if (!claim.ok) return claim.response;

  try {
    const body = jsonOf(req.body) as { payment_method_id?: string } | undefined;
    if (body === undefined) return { status: 400, body: { error: "invalid_json" } };
    const paymentId = body.payment_method_id ?? "";
    // The instrument must be one this session offered, to this customer. Nothing else is accepted,
    // and the two failures are not distinguished in the message.
    if (!session.payment_methods.some((p) => p.id === paymentId)) {
      await deps.pantry.releaseKey(`ucp:complete:${session.id}`, claim.key);
      return {
        status: 200,
        body: { ...session, messages: [{ code: "payment_method_invalid", severity: "error", presentation: "inline", content: "That payment method is not one this checkout offered." }] },
      };
    }
    if (session.status !== "ready_for_complete") {
      await deps.pantry.releaseKey(`ucp:complete:${session.id}`, claim.key);
      return {
        status: 200,
        body: { ...session, messages: [{ code: "not_ready", severity: "error", presentation: "inline", content: "The checkout needs a delivery address before it can be completed." }] },
      };
    }

    // Stock comes off the shelf, and the same food goes onto the pantry ledger. Both happen once:
    // the idempotency claim above is what makes "once" true under a retry.
    const events: PantryEvent[] = [];
    let seq = 0;
    for (const line of session.line_items) {
      const sku = deps.index.byId.get(line.sku_id);
      if (!sku) continue;
      sku.stock = Math.max(0, sku.stock - line.quantity);
      const amount = canonicalAmount(toMilli(sku.pack.qty), sku.pack.unit as Unit);
      events.push({
        ts: now,
        seq: seq++,
        type: "add",
        ingredient_id: sku.ingredient_id,
        qty_milli: amount.qty_milli === null ? null : amount.qty_milli * line.quantity,
        unit: amount.unit,
        origin: "checkout",
        // A receipt is evidence. The customer did not say it, but the shop did, and the shop knows
        // what it put in the box — this is the one non-voice source that earns `confirmed`.
        confidence: "confirmed",
        location: "pantry",
        expires_on: null,
        external_id: `checkout:${session.id}:${sku.id}`,
        source_device: null,
      });
    }
    await deps.pantry.append(session.user_id, events);

    const orderId = deps.newId("order");
    const completed: CheckoutSession = {
      ...session,
      status: "completed",
      updated_at: now,
      order: { id: orderId, receipt_url: `${deps.baseUrl}/store/receipts/${orderId}` },
      messages: [
        ...disclosureFor(deps, session),
        {
          code: "order_placed",
          severity: "info",
          presentation: "inline",
          content: `Paid ${money(session.totals.total_cents, session.currency)}. ${events.length} item${events.length === 1 ? "" : "s"} added to your pantry.`,
        },
      ],
    };
    await deps.sessions.put(completed);
    await deps.pantry.commitKey(`ucp:complete:${session.id}`, claim.key);
    return { status: 200, body: completed };
  } catch (err) {
    await deps.pantry.releaseKey(`ucp:complete:${session.id}`, claim.key);
    throw err;
  }
}

async function cancel(deps: UcpDeps, req: UcpRequest, session: CheckoutSession, now: string): Promise<UcpResponse> {
  if (session.status === "completed") {
    return { status: 200, body: { ...session, messages: [{ code: "not_cancelable", severity: "error", presentation: "inline", content: "This order is already paid; cancelling it is a refund, not a checkout state." }] } };
  }
  const claim = await guard(deps, req, `ucp:cancel:${session.id}`);
  if (!claim.ok) return claim.response;
  const canceled: CheckoutSession = { ...session, status: "canceled", updated_at: now };
  await deps.sessions.put(canceled);
  await deps.pantry.commitKey(`ucp:cancel:${session.id}`, claim.key);
  return { status: 200, body: canceled };
}
