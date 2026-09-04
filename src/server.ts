// Mise — MCP server for Alexa+. The server has no LLM of its own: every tool is data plus
// deterministic logic, and nothing external sits on the response path.
//
// One process, one URL, four surfaces:
//   POST /mcp                 the MCP server Alexa+ talks to (recipe_search, pantry_list)
//   GET  /recipes[/:id]       importable recipe pages (schema.org JSON-LD)
//   POST /ingest/:source      the signed door for connected sources (fridge, barcode scanner)
//   GET  /pantry, /sim/fridge the account web: what voice cannot do
//   GET  /healthz             liveness
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { type Recipe, loadRecipes, searchRecipes } from "./recipes.ts";
import { renderIndexPage, renderRecipePage, toJsonLd } from "./recipe_jsonld.ts";
import { renderPantryPage, renderSimFridgePage, type SourceLine } from "./pages.ts";
import { foldPantry } from "./pantry/fold.ts";
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
/** Until account linking (plan block B) exists, one demo account owns the pantry. Unset it and
 *  every account-bound surface answers "link your account" instead of pretending. */
const DEMO_USER = process.env.DEMO_USER ?? "demo";
/** Secret for the two demo sources reachable through POST /ingest. Unset: the door is closed. */
const INGEST_SECRET = process.env.INGEST_SECRET;
/** Optional JSON mirror of the in-memory ledger, so a local demo survives a restart. */
const PANTRY_FILE = process.env.PANTRY_FILE;

const recipes: Recipe[] = loadRecipes();
const byId = new Map(recipes.map((r) => [r.id, r]));
const resolve = buildResolver(loadAliases(), new Set(recipes.flatMap((r) => r.ingredients.map((i) => i.id))));
const store = new MemoryPantryStore(PANTRY_FILE);
const lookupProduct = makeOffLookup();

/** Block B replaces this with per-user sources in DynamoDB. */
const sources: ConnectedSource[] = INGEST_SECRET
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
        const name = i.ingredient_id.replace(/-/g, " ");
        const amount = !i.qty_known ? `some ${name}, amount unknown` : i.unit === "pc" ? `${i.qty} ${name}` : `${i.qty} ${i.unit} ${name}`;
        const when = i.days_to_expiry === null ? "" : i.days_to_expiry < 0 ? ", already past its date" : i.days_to_expiry <= 1 ? ", expiring today or tomorrow" : `, ${i.days_to_expiry} days left`;
        const sure = i.confidence === "inferred" ? " (the fridge reported it)" : i.confidence === "stale" ? " (not confirmed lately)" : "";
        return `${amount}${when}${sure}`;
      };
      const spoken = out.length === 0 ? "Nothing on record yet." : `${out.length} item${out.length === 1 ? "" : "s"}: ${out.map(say).join("; ")}.`;
      return { structuredContent: { items: out, total: out.length, as_of: now }, content: [{ type: "text", text: spoken }] };
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
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
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
  if (sources.length === 0) { json(res, 503, { ok: false, message: "Ingest is closed: INGEST_SECRET is not set." }); return; }
  let body: string;
  try { body = await readBody(req); } catch { json(res, 413, { ok: false, message: "Body too large." }); return; }
  const result = await ingest(ingestDeps, {
    sourceId,
    body,
    headers: { "x-mise-signature": req.headers["x-mise-signature"] as string | undefined, "idempotency-key": req.headers["idempotency-key"] as string | undefined },
  });
  json(res, result.status, result.body);
}

async function servePantry(url: URL, res: ServerResponse): Promise<void> {
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
  html(res, renderPantryPage(fold.items, lines, now, { location: url.searchParams.get("location") ?? undefined }));
}

/** The demo fridge page posts here, same-origin, as the demo user. External devices use /ingest. */
async function serveSimFridge(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "GET") { html(res, renderSimFridgePage()); return; }
  let payload: FridgeStatus;
  try { payload = JSON.parse(await readBody(req)) as FridgeStatus; } catch { json(res, 400, { ok: false, message: "Body is not valid JSON." }); return; }
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
  console.log(`mise listening on ${BASE_URL} — MCP at /mcp, ${recipes.length} recipes at /recipes, pantry at /pantry (user: ${DEMO_USER}), ingest ${sources.length ? "open" : "closed (set INGEST_SECRET)"}`);
});
