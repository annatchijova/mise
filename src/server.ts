// Mise — MCP server for Alexa+. The server has no LLM of its own: every tool is data plus
// deterministic logic, and nothing external sits on the response path.
//
// One process, one URL, four surfaces:
//   POST /mcp                 the MCP server Alexa+ talks to (recipes, pantry, substitutions)
//   GET  /recipes[/:id]       importable recipe pages (schema.org JSON-LD)
//   POST /ingest/:source      the signed door for connected sources (fridge, barcode scanner)
//   GET  /pantry, /sim/fridge the account web: what voice cannot do
//   GET  /healthz             liveness
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { type Recipe, loadRecipes, searchRecipes } from "./recipes.ts";
import { type Unit, displayName } from "./pantry/events.ts";
import { renderIndexPage, renderRecipePage, toJsonLd } from "./recipe_jsonld.ts";
import {
  ROLES, TECHNIQUES, type Role, type Technique,
  indexSubstitutions, loadSubstitutions, nameOf, ratioText, substitutionIds, substitutionsFor,
} from "./substitutions.ts";
import { renderLinkAccountPage, renderPantryPage, renderSimFridgePage, type SourceLine } from "./pages.ts";
import { foldPantry } from "./pantry/fold.ts";
import { UNITS, voiceEvents } from "./pantry/voice.ts";
import { MemoryPantryStore } from "./pantry/store.ts";
import { buildResolver, loadAliases } from "./integrations/aliases.ts";
import { type BarcodePayload, barcodeSource } from "./integrations/barcode.ts";
import { type ConnectedSource, type IngestDeps, ingest } from "./integrations/ingest.ts";
import { makeOffLookup } from "./integrations/off_client.ts";
import { type FridgeStatus, simulatedFridge } from "./integrations/simulated_fridge.ts";
import { type PantrySource, runSource } from "./integrations/types.ts";

// --- configuration --------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 8080);
/** Canonical public origin, used for the @id of an exported recipe. */
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
/** Until account linking (plan block B) exists, one demo account owns the pantry. Defaults to
 *  "demo"; set DEMO_USER to an empty string and every account-bound surface — pantry_list, /pantry,
 *  /sim/fridge and the ingest sources — answers "link your account" instead of pretending. */
const DEMO_USER: string | null = (process.env.DEMO_USER ?? "demo").trim() || null;
/** Secret for the two demo sources reachable through POST /ingest. Unset: the door is closed. */
const INGEST_SECRET = process.env.INGEST_SECRET;
/** Optional JSON mirror of the in-memory ledger, so a local demo survives a restart. */
const PANTRY_FILE = process.env.PANTRY_FILE;

/** Ties a POST to /sim/fridge to a page this process served. It is not authentication — there are
 *  no accounts yet — but it stops a foreign website, or a bare request, from writing to the demo
 *  pantry through the unsigned route. Rotates on every start. */
const SIM_TOKEN = randomBytes(16).toString("hex");
const ORIGIN = new URL(BASE_URL).origin;

const recipes: Recipe[] = loadRecipes();
const byId = new Map(recipes.map((r) => [r.id, r]));
const substitutions = loadSubstitutions();
const substitutionIndex = indexSubstitutions(substitutions);
// The resolver knows every id anyone can name: the ones the recipes cook with, and the ones only
// the substitution table mentions. Being out of tamari is a sentence a person can say.
const resolve = buildResolver(loadAliases(), new Set([
  ...recipes.flatMap((r) => r.ingredients.map((i) => i.id)),
  ...substitutionIds(substitutions),
]));
const store = new MemoryPantryStore(PANTRY_FILE);
const lookupProduct = makeOffLookup();

/** Block B replaces this with per-user sources in DynamoDB. */
const sources: ConnectedSource[] = INGEST_SECRET && DEMO_USER
  ? [
      { id: "sim-fridge", userId: DEMO_USER, kind: "simulated", secret: INGEST_SECRET, label: "Kitchen fridge (simulated)" },
      { id: "scanner", userId: DEMO_USER, kind: "barcode", secret: INGEST_SECRET, label: "Barcode scanner" },
    ]
  : [];

const ingestDeps: IngestDeps = {
  store,
  resolve,
  adapters: { simulated: simulatedFridge as PantrySource<unknown>, barcode: barcodeSource as PantrySource<unknown> },
  findSource: (id) => sources.find((s) => s.id === id),
  now: () => new Date().toISOString(),
  enrich: {
    // A scanner sends only the code; the product record is fetched here, once, with a timeout.
    barcode: async (payload) => {
      const p = payload as Partial<BarcodePayload>;
      if (p?.product !== undefined || !p?.scan?.ean) return payload;
      return { scan: p.scan, product: await lookupProduct(p.scan.ean) } satisfies BarcodePayload;
    },
  },
};

async function pantryFor(userId: string, now: string) {
  const events = await store.events(userId);
  return { events, fold: foldPantry(events, { now }) };
}

// --- MCP ------------------------------------------------------------------------------------

function buildServer(): McpServer {
  const server = new McpServer({ name: "mise", version: "0.1.0" });

  server.registerTool(
    "recipe_search",
    {
      title: "Search recipes",
      description:
        "Find recipes. Use when the customer asks what to cook, wants ideas, asks for a dish by name or ingredient, or asks what they can make with what they have. Returns candidates ranked by how many of the given ingredients are already on hand. Works without a linked account.",
      inputSchema: {
        query: z.string().optional().describe("Free text: a dish name or an ingredient"),
        use_ingredients: z.array(z.string()).optional().describe("Ingredients the customer already has"),
        max_minutes: z.number().int().positive().optional().describe("Maximum total cooking time in minutes"),
      },
      outputSchema: {
        candidates: z.array(
          z.object({
            id: z.string(), title: z.string(), category: z.string(), minutes: z.number().int(),
            serves: z.number().int(), have_pct: z.number().int(), missing: z.array(z.string()),
          }),
        ),
        total: z.number().int(),
      },
    },
    async (args) => {
      const result = searchRecipes(recipes, args);
      const spoken =
        result.total === 0
          ? "I could not find a recipe that fits."
          : `${result.total} option${result.total === 1 ? "" : "s"}: ` +
            result.candidates.map((c) => `${c.title} (${c.minutes} min, ${c.have_pct}% on hand)`).join("; ") + ".";
      return { structuredContent: result, content: [{ type: "text", text: spoken }] };
    },
  );

  server.registerTool(
    "pantry_update",
    {
      title: "Update the pantry",
      description:
        "Record what the customer has, used, or corrected. Use when they say they bought, have, got, or put away food ('I've got two onions', 'the tofu expires Friday'), used some up ('I used the last of the lentils'), or correct an amount ('actually there are three'). Pass the items as extracted, with a YYYY-MM-DD date when they gave one. Returns what was recorded and anything that could not be placed. Needs a linked account.",
      inputSchema: {
        mode: z.enum(["add", "consume", "correct", "remove"]).describe("add: new food; consume: some was used; correct: the true amount now; remove: it is gone"),
        items: z.array(z.object({
          name: z.string().describe("The food, as the customer said it"),
          qty: z.number().positive().optional().describe("Amount, if they said one"),
          unit: z.enum(UNITS as [Unit, ...Unit[]]).optional().describe("Unit of the amount; pc for a count"),
          expires: z.string().optional().describe("YYYY-MM-DD, if they gave a date"),
          location: z.string().optional().describe("fridge, freezer, pantry, or a named place"),
        })).min(1),
      },
      outputSchema: {
        recorded: z.array(z.object({ ingredient_id: z.string(), qty: z.number().nullable(), unit: z.string(), location: z.string(), expires_on: z.string().nullable() })),
        rejected: z.array(z.object({ name: z.string(), reason: z.string() })),
        as_of: z.string(),
      },
    },
    async (args) => {
      if (!DEMO_USER) {
        return { isError: true, content: [{ type: "text", text: "This needs a linked account. Link Mise in the Alexa app and ask again." }] };
      }
      const now = new Date().toISOString();
      const { events, rejected } = voiceEvents(args.items, args.mode, { now, resolve });
      await store.append(DEMO_USER, events);
      const recorded = events.map((e) => ({ ingredient_id: e.ingredient_id, qty: e.qty_milli === null ? null : e.qty_milli / 1000, unit: e.unit, location: e.location, expires_on: e.expires_on }));
      const verb = { add: "Got it", consume: "Noted", correct: "Corrected", remove: "Removed" }[args.mode];
      const said = recorded.map((r) => `${r.qty === null ? "" : `${r.qty} ${r.unit === "pc" ? "" : `${r.unit} `}`}${displayName(r.ingredient_id)}${r.expires_on ? ` (expires ${r.expires_on})` : ""}`).join(", ");
      const back = rejected.map((r) => `${r.name}: ${r.reason}`).join("; ");
      const spoken = `${recorded.length ? `${verb}: ${said}.` : "Nothing recorded."}${back ? ` Could not place ${back}.` : ""}`;
      return { structuredContent: { recorded, rejected, as_of: now }, content: [{ type: "text", text: spoken }] };
    },
  );

  server.registerTool(
    "pantry_list",
    {
      title: "What is in the pantry",
      description:
        "List what the customer has, with how sure we are and what expires soon. Use when they ask what they have, what is in the fridge or pantry, what is about to go off, or what they should use up. Items reported by a connected fridge are marked inferred, not confirmed; say so when it matters. Needs a linked account.",
      inputSchema: {
        filter: z.enum(["all", "expiring_soon", "unknown_amount"]).optional().describe("Narrow the list"),
        location: z.string().optional().describe("fridge, freezer, pantry, or a named place"),
      },
      outputSchema: {
        items: z.array(
          z.object({
            ingredient_id: z.string(), qty: z.number().nullable(), qty_known: z.boolean(), unit: z.string(),
            location: z.string(), confidence: z.enum(["confirmed", "inferred", "stale"]),
            expires_on: z.string().nullable(), days_to_expiry: z.number().int().nullable(),
            freshness: z.enum(["expired", "urgent", "soon", "fresh", "unknown"]), origins: z.array(z.string()),
          }),
        ),
        total: z.number().int(),
        as_of: z.string(),
        /** Ledger events the fold could not use. Zero unless a source got past boundary validation. */
        invalid_events: z.number().int(),
      },
    },
    async (args) => {
      if (!DEMO_USER) {
        return { isError: true, content: [{ type: "text", text: "This needs a linked account. Link Mise in the Alexa app and ask again." }] };
      }
      const now = new Date().toISOString();
      const { fold } = await pantryFor(DEMO_USER, now);
      let items = fold.items;
      if (args.location) items = items.filter((i) => i.location === args.location);
      if (args.filter === "expiring_soon") items = items.filter((i) => ["expired", "urgent", "soon"].includes(i.freshness));
      if (args.filter === "unknown_amount") items = items.filter((i) => !i.qty_known);
      const out = items.map(({ ingredient_id, qty, qty_known, unit, location, confidence, expires_on, days_to_expiry, freshness, origins }) =>
        ({ ingredient_id, qty, qty_known, unit, location, confidence, expires_on, days_to_expiry, freshness, origins }));

      const say = (i: (typeof out)[number]) => {
        const name = displayName(i.ingredient_id);
        const amount = !i.qty_known ? `some ${name}, amount unknown` : i.unit === "pc" ? `${i.qty} ${name}` : `${i.qty} ${i.unit} ${name}`;
        const when = i.days_to_expiry === null ? "" : i.days_to_expiry < 0 ? ", already past its date" : i.days_to_expiry <= 1 ? ", expiring today or tomorrow" : `, ${i.days_to_expiry} days left`;
        const sure = i.confidence === "inferred" ? " (the fridge reported it)" : i.confidence === "stale" ? " (not confirmed lately)" : "";
        return `${amount}${when}${sure}`;
      };
      const caveat = fold.invalid > 0 ? ` ${fold.invalid} record${fold.invalid === 1 ? "" : "s"} could not be read and ${fold.invalid === 1 ? "was" : "were"} left out.` : "";
      const spoken = (out.length === 0 ? "Nothing on record yet." : `${out.length} item${out.length === 1 ? "" : "s"}: ${out.map(say).join("; ")}.`) + caveat;
      return { structuredContent: { items: out, total: out.length, as_of: now, invalid_events: fold.invalid }, content: [{ type: "text", text: spoken }] };
    },
  );

  server.registerTool(
    "substitute",
    {
      title: "Substitute an ingredient",
      description:
        "Say what to use instead of an ingredient, with how much and what changes. Use when the customer says they have run out of something, asks what they can use instead, or asks whether one thing works in place of another. Every answer comes from a table a cook wrote, with its ratio and its warnings; when the table has nothing for that ingredient it says so instead of guessing. Pass recipe_id when they are cooking something, because the answer depends on what the ingredient was doing. Works without a linked account.",
      inputSchema: {
        ingredient: z.string().describe("What they have run out of, as they said it"),
        recipe_id: z.string().optional().describe("The recipe being cooked, when known: it settles what the ingredient was doing"),
        role: z.enum(ROLES).optional().describe("What the ingredient does in the dish, when there is no recipe: fat, acid, binder, umami, aromatic, thickener"),
        technique: z.enum(TECHNIQUES).optional().describe("What is being done with it: fry, bake, emulsify, bind-cold, simmer, whip"),
      },
      outputSchema: {
        ingredient: z.string(),
        /** false when the name is not one we keep: there is nothing curated, and nothing invented. */
        resolved: z.boolean(),
        table_version: z.number().int(),
        contexts: z.array(
          z.object({
            role: z.string(),
            technique: z.string().nullable(),
            /** How specific the answer is. Anything below ingredient+role+technique is a wider
             *  answer than was asked for, and the narrator should say so. */
            match: z.enum(["ingredient+role+technique", "ingredient+role", "ingredient", "role+technique", "role"]),
            alternatives: z.array(
              z.object({
                ingredient: z.string(), name: z.string(),
                ratio: z.tuple([z.number().int(), z.number().int()]).nullable(),
                how_much: z.string(), note: z.string(), warning: z.string().nullable(),
                /** true/false when there is a pantry to check, null when there is no account. */
                on_hand: z.boolean().nullable(),
              }),
            ),
            if_missing: z.string(),
          }),
        ),
      },
    },
    async (args) => {
      const id = resolve(args.ingredient);
      if (!id) {
        const text = `I do not keep ${args.ingredient}, so I have nothing curated to put in its place. I would rather say that than guess.`;
        return { structuredContent: { ingredient: args.ingredient, resolved: false, table_version: substitutions.version, contexts: [] }, content: [{ type: "text", text }] };
      }

      // The recipe settles the question the table is keyed on: what was this ingredient doing?
      const recipe = args.recipe_id ? byId.get(args.recipe_id) : undefined;
      const inRecipe = recipe?.ingredients.find((i) => i.id === id);
      const role = (inRecipe?.role ?? args.role ?? null) as Role | null;
      const technique = (inRecipe?.technique ?? args.technique ?? null) as Technique | null;

      // Only annotate what is on hand when there is a pantry to read. No account, no claim.
      let onHand: Set<string> | null = null;
      if (DEMO_USER) {
        const { fold } = await pantryFor(DEMO_USER, new Date().toISOString());
        onHand = new Set(fold.items.map((i) => i.ingredient_id));
      }

      const contexts = substitutionsFor(substitutions, substitutionIndex, { ingredient: id, role, technique }).map((c) => ({
        role: c.role,
        technique: c.technique,
        match: c.match,
        alternatives: c.alternatives.map((a) => ({
          ingredient: a.ingredient,
          name: nameOf(substitutions, a.ingredient),
          ratio: a.ratio === null ? null : ([a.ratio[0], a.ratio[1]] as [number, number]),
          how_much: ratioText(a.ratio),
          note: a.note,
          warning: a.warning,
          on_hand: onHand === null ? null : onHand.has(a.ingredient),
        })),
        if_missing: c.if_missing,
      }));

      const name = nameOf(substitutions, id);
      const said = contexts.length === 0
        ? `I have nothing curated for ${name}. Tell me what it was doing in the dish — the fat, the acid, what binds it — and I can answer.`
        : contexts.slice(0, 3).map((c) => {
            const where = c.technique === null || c.technique === "none" ? `as the ${c.role}` : `as the ${c.role}, ${c.technique}`;
            const wide = c.match === "role" || c.match === "role+technique"
              ? `Nothing curated for ${name} itself, but generally ${where}: `
              : `Instead of ${name} ${where}: `;
            if (c.alternatives.length === 0) return `${wide.replace(/: $/, ". ")}${c.if_missing}`;
            const list = c.alternatives.map((a) => {
              const have = a.on_hand ? ", which you have" : "";
              const warn = a.warning ? ` Careful: ${a.warning}` : "";
              return `${a.name}${have}, ${a.how_much}. ${a.note}${warn}`;
            }).join(" ");
            return `${wide}${list}`;
          }).join(" ");

      return {
        structuredContent: { ingredient: id, resolved: true, table_version: substitutions.version, contexts },
        content: [{ type: "text", text: said }],
      };
    },
  );

  return server;
}

// --- HTTP helpers ---------------------------------------------------------------------------

function send(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8", extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...extra });
  res.end(body);
}
const html = (res: ServerResponse, body: string, status = 200) => send(res, status, body, "text/html; charset=utf-8");
const json = (res: ServerResponse, status: number, body: unknown) => send(res, status, JSON.stringify(body, null, 2), "application/json; charset=utf-8");

const BODY_LIMIT = 256 * 1024;
class BodyTooLarge extends Error {}

/** Read the body up to the limit. On overflow it stops reading and rejects with BodyTooLarge; the
 *  caller answers 413 before the socket is closed, so the sender sees the status rather than a reset. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > BODY_LIMIT) { done = true; req.pause(); reject(new BodyTooLarge("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => { if (!done) resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", (err) => { if (!done) reject(err); });
  });
}

/** Answer 413 and only then close the connection: the response must leave before the socket does. */
function tooLarge(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(413, { "content-type": "application/json; charset=utf-8", connection: "close" });
  res.end(JSON.stringify({ ok: false, message: "Body too large." }), () => req.destroy());
}

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// --- routes ---------------------------------------------------------------------------------

function serveRecipes(pathname: string, res: ServerResponse): boolean {
  if (pathname === "/recipes" || pathname === "/recipes/") { html(res, renderIndexPage(recipes)); return true; }
  if (!pathname.startsWith("/recipes/")) return false;
  let id = pathname.slice("/recipes/".length);
  const asJson = id.endsWith(".json");
  if (asJson) id = id.slice(0, -".json".length);
  // The id is a lookup key in a map we built ourselves, never a path.
  const recipe = KEBAB.test(id) ? byId.get(id) : undefined;
  if (!recipe) { send(res, 404, "No such recipe. See /recipes"); return true; }
  if (asJson) send(res, 200, JSON.stringify(toJsonLd(recipe, { baseUrl: BASE_URL }), null, 2), "application/ld+json; charset=utf-8");
  else html(res, renderRecipePage(recipe, { baseUrl: BASE_URL }));
  return true;
}

async function serveIngest(sourceId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (sources.length === 0) { json(res, 503, { ok: false, message: "Ingest is closed: INGEST_SECRET and DEMO_USER must both be set." }); return; }
  let body: string;
  try { body = await readBody(req); } catch (err) { if (err instanceof BodyTooLarge) tooLarge(req, res); else json(res, 400, { ok: false, message: "Could not read the body." }); return; }
  const result = await ingest(ingestDeps, {
    sourceId,
    body,
    headers: { "x-mise-signature": req.headers["x-mise-signature"] as string | undefined, "idempotency-key": req.headers["idempotency-key"] as string | undefined },
  });
  json(res, result.status, result.body);
}

async function servePantry(url: URL, res: ServerResponse): Promise<void> {
  if (!DEMO_USER) { html(res, renderLinkAccountPage(), 403); return; }
  const now = new Date().toISOString();
  const { events, fold } = await pantryFor(DEMO_USER, now);
  // A source's "last report" is simply the newest event it produced; no separate sync state to drift.
  const lines: SourceLine[] = sources.map((s) => {
    const origin = s.kind === "simulated" ? "simulated" : s.kind;
    const last = events.filter((e) => e.origin === origin).map((e) => e.ts).sort().at(-1) ?? null;
    return { label: s.label, kind: s.kind, synced_at: last };
  });
  if (sources.length === 0 && events.some((e) => e.origin === "simulated")) {
    lines.push({ label: "Simulated fridge (web)", kind: "simulated", synced_at: events.filter((e) => e.origin === "simulated").map((e) => e.ts).sort().at(-1) ?? null });
  }
  html(res, renderPantryPage(fold.items, lines, now, { location: url.searchParams.get("location") ?? undefined, invalid: fold.invalid }));
}

/** A browser request that did not come from this origin. Checked on the headers browsers set and
 *  a page cannot forge; a non-browser client simply sends none of them and is stopped by the token. */
function crossSite(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return true;
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== ORIGIN) return true;
  return false;
}

/** The demo fridge page posts here as the demo user. It is the same adapter as the signed
 *  /ingest/sim-fridge door, so it must not be an easier way in: JSON only (a form cannot send it
 *  without a preflight), same origin, and the token the page was served with. Devices use /ingest. */
async function serveSimFridge(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!DEMO_USER) { html(res, renderLinkAccountPage(), 403); return; }
  if (req.method === "GET") { html(res, renderSimFridgePage(SIM_TOKEN)); return; }
  if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    json(res, 415, { ok: false, message: "Send application/json." }); return;
  }
  if (crossSite(req) || req.headers["x-sim-token"] !== SIM_TOKEN) {
    json(res, 403, { ok: false, message: "This route only accepts posts from the simulated fridge page served by this server." }); return;
  }
  let body: string;
  try { body = await readBody(req); } catch (err) { if (err instanceof BodyTooLarge) tooLarge(req, res); else json(res, 400, { ok: false, message: "Could not read the body." }); return; }
  let payload: FridgeStatus;
  try { payload = JSON.parse(body) as FridgeStatus; } catch { json(res, 400, { ok: false, message: "Body is not valid JSON." }); return; }
  const reading = runSource(simulatedFridge, payload, { userId: DEMO_USER, now: new Date().toISOString(), resolve });
  await store.append(DEMO_USER, reading.events);
  json(res, 202, { ok: true, accepted: reading.events.length, unmapped: reading.unmapped, next: "/pantry" });
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", BASE_URL);
  const { pathname } = url;
  try {
    if (pathname === "/healthz") { send(res, 200, "ok"); return; }
    if (req.method === "GET" && serveRecipes(pathname, res)) return;
    if (req.method === "POST" && pathname.startsWith("/ingest/")) { await serveIngest(pathname.slice("/ingest/".length), req, res); return; }
    if (req.method === "GET" && pathname === "/pantry") { await servePantry(url, res); return; }
    if (pathname === "/sim/fridge" && (req.method === "GET" || req.method === "POST")) { await serveSimFridge(req, res); return; }
    if (pathname === "/mcp" && req.method === "POST") {
      // Stateless Streamable HTTP: one server + transport per request.
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
    send(res, pathname === "/" ? 200 : 404, "Mise. POST /mcp · GET /recipes · GET /pantry · GET /sim/fridge · POST /ingest/:source");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, "Internal error.");
  }
});

httpServer.listen(PORT, () => {
  console.log(`mise listening on ${BASE_URL} — MCP at /mcp, ${recipes.length} recipes at /recipes, pantry at /pantry (${DEMO_USER ? `user: ${DEMO_USER}` : "no demo user: account surfaces closed"}), ingest ${sources.length ? "open" : "closed (set INGEST_SECRET)"}`);
});
