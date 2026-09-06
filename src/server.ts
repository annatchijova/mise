// Mise — MCP server for Alexa+. The server has no LLM of its own: every tool is data plus
// deterministic logic, and nothing external sits on the response path.
//
// One process, one URL, four surfaces:
//   POST /mcp                 the MCP server Alexa+ talks to (recipes, pantry, substitutions,
//                             the week's plan, cooking)
//   GET  /recipes[/:id]       importable recipe pages (schema.org JSON-LD)
//   POST /ingest/:source      the signed door for connected sources (fridge, barcode scanner)
//   GET  /pantry, /sim/fridge the account web: what voice cannot do
//   GET  /data[/*.json]       the curated tables, published with their provenance and caveats
//   GET  /.well-known/ucp     the demo store's UCP profile
//   /store/*                  the five checkout endpoints, the refund policy, receipts
//   GET  /healthz             liveness
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { type Recipe, dataDir as dataDirPath, loadRecipes, searchRecipes } from "./recipes.ts";
import { type Unit, displayName } from "./pantry/events.ts";
import { renderIndexPage, renderRecipePage, toJsonLd } from "./recipe_jsonld.ts";
import {
  ROLES, TECHNIQUES, type Role, type Technique,
  indexSubstitutions, loadSubstitutions, nameOf, ratioText, substitutionIds, substitutionsFor,
} from "./substitutions.ts";
import { renderLinkAccountPage, renderPantryPage, renderSimFridgePage, type SourceLine } from "./pages.ts";
import { foldPantry } from "./pantry/fold.ts";
import { buildShelfLife, loadShelfLife, rolesFromRecipes } from "./pantry/shelf_life.ts";
import { type AuditReason, auditQuestions, confidenceOf, confidenceSentence } from "./pantry/audit.ts";
import { UNITS, voiceEvents } from "./pantry/voice.ts";
import { MemoryPantryStore } from "./pantry/store.ts";
import { buildResolver, loadAliases } from "./integrations/aliases.ts";
import { type BarcodePayload, barcodeSource } from "./integrations/barcode.ts";
import { type ConnectedSource, type IngestDeps, ingest } from "./integrations/ingest.ts";
import { makeOffLookup } from "./integrations/off_client.ts";
import { receiptSource } from "./integrations/receipt.ts";
import { indexNutrition, ingredientSentence, loadNutrition, nutritionOf, nutritionSentence } from "./nutrition.ts";
import { type FridgeStatus, simulatedFridge } from "./integrations/simulated_fridge.ts";
import { type PantrySource, runSource } from "./integrations/types.ts";
import { MemoryCookStore } from "./cook/store.ts";
import { registerCookTools } from "./tools/cook.ts";
import { buildScaling, loadScaling } from "./cook/scaling.ts";
import { indexLongSteps, keyOf as longStepKey, loadLongSteps } from "./cook/check_ins.ts";
import { FileSwapStore, MemorySwapStore } from "./cook/swap_log.ts";
import { MemoryPlanStore } from "./plan/store.ts";
import { registerPlanTools } from "./tools/plan.ts";
import { indexCatalog, loadCatalog } from "./store/catalog.ts";
import { MemoryCartStore, priceOfWanted } from "./store/cart.ts";
import { MemoryCheckoutStore, handleUcp } from "./store/ucp.ts";
import { registerCartTools } from "./tools/cart.ts";
import { renderDataIndexPage, renderReceiptPage, renderRefundPolicyPage } from "./pages.ts";
import { DATA_LICENSE, PUBLISHED, publish } from "./open_data.ts";
import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import { VIEW_URIS, buildViews, loadRuntime } from "./ui/views.ts";

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
/** Where the source lives, cited in every published table so a copy stays attributable. */
const REPOSITORY_URL = process.env.REPOSITORY_URL ?? "https://github.com/annatchijova/mise";
/** Optional JSON mirror of the in-memory ledger, so a local demo survives a restart. */
const PANTRY_FILE = process.env.PANTRY_FILE;
/** The same, for cooking sessions: "where was I?" a day later is the point of them. */
const COOK_FILE = process.env.COOK_FILE;
/** And for the week's plan, which the cart shops from. */
const PLAN_FILE = process.env.PLAN_FILE;
/** And for the basket. */
const CART_FILE = process.env.CART_FILE;
/** Where swaps people made while cooking are queued for review. Unset: they stay in memory and are
 *  lost on restart, which costs a curator a queue and costs a cook nothing. */
const SWAP_LOG_FILE = process.env.SWAP_LOG_FILE ?? join(dataDirPath(), "imports", "swap_candidates.json");
/** The bearer token the demo store's UCP surface accepts. Unset: checkout is closed, the same way
 *  ingest is closed without INGEST_SECRET. Block B replaces this with the OAuth 2.1 access token,
 *  and until then this is a shared secret, not authentication — see docs/BLOCKED.md. */
const UCP_TOKEN = process.env.UCP_TOKEN;

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
// How long things keep, so the planner's deadline pass has something to work on. Every number it
// produces is an estimate and stays labelled as one all the way to what gets said out loud.
const roles = rolesFromRecipes(recipes);
const shelfLifeTable = loadShelfLife();
const shelfLife = buildShelfLife(shelfLifeTable, (id) => roles.get(id) ?? null);
const sessions = new MemoryCookStore(COOK_FILE);
// What multiplies when the servings change, and what does not.
const scalingTable = loadScaling();
const scaling = buildScaling(scalingTable);
/** Where swaps people made are queued for a curator to look at. A file, because that is what it is:
 *  something a person opens and either acts on or does not. */
const swaps = SWAP_LOG_FILE ? new FileSwapStore(SWAP_LOG_FILE) : new MemorySwapStore();

/** Round reference figures for whole ingredients. Deliberately incomplete: an ingredient with no row
 *  is reported as having no figures, never estimated from one that looks similar. */
/** What to look at during a step long enough that nobody sits through it. Keyed on the recipe and
 *  the step, because the steps carry no technique field and reading one out of the text would be a
 *  guess. A step with no row gets no schedule, and the tool says so. */
const longSteps = loadLongSteps();
const longStepIndex = indexLongSteps(longSteps);

const nutrition = loadNutrition();
const nutritionIndex = indexNutrition(nutrition);

/** The four macronutrients plus energy, as the tool reports them. Centigrams keep the arithmetic in
 *  integers for the same reason the pantry keeps thousandths: these are summed, and must not drift. */
const NUTRIENTS = z.object({
  kcal: z.number().int(),
  protein_cg: z.number().int(),
  carb_cg: z.number().int(),
  fat_cg: z.number().int(),
  fibre_cg: z.number().int(),
});

/** A tool answer that is a refusal rather than a result. */
function mcpError(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
/** Does the table already suggest this swap? Decides candidate versus confirmation, and nothing else. */
const tableSuggests = (insteadOf: string, used: string, role: string | null, technique: string | null): boolean =>
  substitutionsFor(substitutions, substitutionIndex, { ingredient: insteadOf, role, technique })
    .some((c) => c.alternatives.some((a) => a.ingredient === used));
const plans = new MemoryPlanStore(PLAN_FILE);
const carts = new MemoryCartStore(CART_FILE);
const catalog = loadCatalog();
const skuIndex = indexCatalog(catalog);
const checkouts = new MemoryCheckoutStore();
// The MCP Apps views, built once. A missing runtime bundle is a "you have not run npm run build"
// condition, not a reason to withhold the views: each one then renders a page saying exactly that,
// and every tool still returns the full structuredContent the client can draw from on its own.
const uiRuntime = loadRuntime();
const views = buildViews(uiRuntime);

const ucpDeps = {
  catalog,
  index: skuIndex,
  sessions: checkouts,
  pantry: store,
  userFor: (bearer: string | null) => (UCP_TOKEN && bearer === UCP_TOKEN && DEMO_USER ? DEMO_USER : null),
  now: () => new Date().toISOString(),
  newId: (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`,
  baseUrl: BASE_URL,
};
const lookupProduct = makeOffLookup();

/** Block B replaces this with per-user sources in DynamoDB. */
const sources: ConnectedSource[] = INGEST_SECRET && DEMO_USER
  ? [
      { id: "sim-fridge", userId: DEMO_USER, kind: "simulated", secret: INGEST_SECRET, label: "Kitchen fridge (simulated)" },
      { id: "scanner", userId: DEMO_USER, kind: "barcode", secret: INGEST_SECRET, label: "Barcode scanner" },
      { id: "receipt-app", userId: DEMO_USER, kind: "receipt", secret: INGEST_SECRET, label: "Receipts" },
    ]
  : [];

const ingestDeps: IngestDeps = {
  store,
  resolve,
  adapters: {
    simulated: simulatedFridge as PantrySource<unknown>,
    barcode: barcodeSource as PantrySource<unknown>,
    receipt: receiptSource as PantrySource<unknown>,
  },
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
  return { events, fold: foldPantry(events, { now, shelfLife }) };
}

/** Why a line is `inferred` rather than confirmed. The reservation the pantry carries is only
 *  useful if it names the right source: a number worked out from a recipe is not a fridge reading,
 *  and telling a person "the fridge reported it" about their own cooking is a small lie. */
function whoSaid(origins: string[]): string {
  if (origins.includes("recipe_deduction")) return "worked out from what you cooked, not counted";
  if (origins.includes("simulated") || origins.includes("smartthings")) return "the fridge reported it";
  if (origins.includes("barcode")) return "read off a barcode";
  if (origins.includes("receipt")) return "read off a receipt";
  if (origins.includes("checkout")) return "from what you bought";
  return "my reckoning, not yours";
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
            /** Only a date somebody stated. Never the shelf-life table's number. */
            expires_on: z.string().nullable(),
            /** What the shelf-life table works out, when nobody stated anything. */
            expiry_estimated_on: z.string().nullable(),
            expiry_source: z.enum(["stated", "estimated", "unknown"]),
            expiry_note: z.string().nullable(),
            days_to_expiry: z.number().int().nullable(),
            freshness: z.enum(["expired", "urgent", "soon", "fresh", "unknown"]), origins: z.array(z.string()),
          }),
        ),
        total: z.number().int(),
        as_of: z.string(),
        /** One figure for how much of the pantry rests on something the customer actually said. */
        confidence: z.object({
          total: z.number().int(), confirmed: z.number().int(), inferred: z.number().int(), stale: z.number().int(),
          confirmed_pct: z.number().int(), inferred_pct: z.number().int(), stale_pct: z.number().int(),
          unknown_amount: z.number().int(), estimated_dates: z.number().int(),
          score: z.number().int(), score_basis: z.string(),
        }),
        /** Ledger events the fold could not use. Zero unless a source got past boundary validation. */
        invalid_events: z.number().int(),
      },
      _meta: { ui: { resourceUri: VIEW_URIS.pantry } },
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
      const out = items.map(({ ingredient_id, qty, qty_known, unit, location, confidence, expires_on, expiry_estimated_on, expiry_source, expiry_note, days_to_expiry, freshness, origins }) =>
        ({ ingredient_id, qty, qty_known, unit, location, confidence, expires_on, expiry_estimated_on, expiry_source, expiry_note, days_to_expiry, freshness, origins }));

      const say = (i: (typeof out)[number]) => {
        const name = displayName(i.ingredient_id);
        const amount = !i.qty_known
          ? `some ${name}, amount unknown`
          : i.unit === "pc"
            ? `${i.qty} ${name}`
            // A portion is a portion *of* something, and it pluralises.
            : i.unit === "portion"
              ? `${i.qty} portion${i.qty === 1 ? "" : "s"} of ${name}`
              : `${i.qty} ${i.unit} ${name}`;
        // A date somebody gave and a number a table worked out are two different sentences, and
        // they stay two different sentences right up to the moment they are spoken.
        const guessed = i.expiry_source === "estimated";
        // A two-year estimate on a bag of lentils is true and useless. An estimate is only worth
        // saying out loud while it is near enough to change what somebody cooks; a date a person
        // actually gave is always worth saying, however far off it is.
        const worthSaying = !guessed || (i.days_to_expiry !== null && i.days_to_expiry <= ESTIMATE_SPEAK_WITHIN_DAYS);
        const when = !worthSaying ? "" : i.days_to_expiry === null
          ? ""
          : i.days_to_expiry < 0
            ? guessed ? ", probably past its best by now" : ", already past its date"
            : i.days_to_expiry <= 1
              ? guessed ? ", about a day left by my reckoning" : ", expiring today or tomorrow"
              : guessed ? `, roughly ${i.days_to_expiry} days by my reckoning` : `, ${i.days_to_expiry} days left`;
        const sure = i.confidence === "stale" ? " (not confirmed lately)" : i.confidence === "inferred" ? ` (${whoSaid(i.origins)})` : "";
        return `${amount}${when}${sure}`;
      };
      const caveat = fold.invalid > 0 ? ` ${fold.invalid} record${fold.invalid === 1 ? "" : "s"} could not be read and ${fold.invalid === 1 ? "was" : "were"} left out.` : "";
      // Over the whole pantry, not the filtered slice: "how sure is my kitchen" is a question about
      // the kitchen, and answering it about whatever was just asked for would be a different number
      // every time somebody narrowed the list.
      const confidence = confidenceOf(fold.items);
      const spoken = (out.length === 0 ? "Nothing on record yet." : `${out.length} item${out.length === 1 ? "" : "s"}: ${out.map(say).join("; ")}.`) + caveat;
      return {
        structuredContent: { items: out, total: out.length, as_of: now, confidence, invalid_events: fold.invalid },
        content: [{ type: "text", text: spoken }],
      };
    },
  );

  server.registerTool(
    "recipe_nutrition",
    {
      title: "What is in a dish, as far as anybody knows",
      description:
        "Say roughly what a recipe comes to, or say honestly why it cannot be said. Use when the customer asks about calories, protein, or how healthy something is. Most recipes here do not state their amounts, so most of the time this gives a floor — 'at least this much, and the rest can only add to it' — together with which ingredients it could not account for and why. Pass an ingredient instead of a recipe to ask what one food is per 100 g. Never guesses a number, and never offers a total with a hole in it. Works without a linked account.",
      inputSchema: {
        recipe_id: z.string().optional().describe("The recipe to add up"),
        ingredient: z.string().optional().describe("A single food to ask about instead, as they said it"),
        servings: z.number().int().min(1).max(24).optional().describe("How many people, when they say"),
      },
      outputSchema: {
        table_version: z.number().int(),
        /** The figures for one ingredient, when that is what was asked. */
        ingredient: z
          .object({ id: z.string(), name: z.string(), kcal: z.number().int().nullable(), negligible: z.boolean(), note: z.string().nullable() })
          .nullable(),
        recipe_id: z.string().nullable(),
        servings: z.number().int().nullable(),
        /** Present only when every ingredient is accounted for. Null is the usual answer here. */
        per_serving: NUTRIENTS.nullable(),
        /** What the ingredients we could account for come to. Not a smaller guess: a weaker claim
         *  that is provable, since the ones we could not account for can only add. */
        at_least: NUTRIENTS.nullable(),
        counted: z.array(z.object({
          ingredient_id: z.string(), as: z.string(), grams: z.number().int(),
          how: z.enum(["weighed", "measured"]),
        })),
        gaps: z.array(z.object({
          ingredient_id: z.string(),
          reason: z.enum(["no_amount", "no_measure", "no_data"]),
          stated: z.string().nullable(),
        })),
        ignored_as_trace: z.array(z.string()),
        contribute_nothing: z.array(z.string()),
        covered: z.number().int(),
        of: z.number().int(),
      },
    },
    async (args) => {
      const empty = {
        table_version: nutrition.version, ingredient: null, recipe_id: null, servings: null,
        per_serving: null, at_least: null, counted: [], gaps: [], ignored_as_trace: [],
        contribute_nothing: [], covered: 0, of: 0,
      };

      if (args.ingredient && !args.recipe_id) {
        const id = resolve(args.ingredient);
        const row = id ? nutritionIndex.get(id) : undefined;
        if (!row) {
          const text = `I have no figures for ${args.ingredient}. The table is written by hand and it is not complete; I would rather say that than borrow a number from something that looks similar.`;
          return { structuredContent: empty, content: [{ type: "text", text }] };
        }
        return {
          structuredContent: {
            ...empty,
            ingredient: { id: row.id, name: row.name, kcal: row.kcal, negligible: row.negligible, note: row.note },
          },
          content: [{ type: "text", text: ingredientSentence(row) }],
        };
      }

      const recipe = args.recipe_id ? byId.get(args.recipe_id) : undefined;
      if (!recipe) {
        return mcpError("I do not have a recipe with that id. Search first and give me the id it returns.");
      }
      const report = nutritionOf(recipe, nutritionIndex, nutrition, args.servings);
      return {
        structuredContent: {
          table_version: report.table_version,
          ingredient: null,
          recipe_id: report.recipe_id,
          servings: report.servings,
          per_serving: report.per_serving,
          at_least: report.at_least,
          counted: report.counted.map((c) => ({ ingredient_id: c.ingredient_id, as: c.as, grams: c.grams, how: c.how })),
          gaps: report.gaps,
          ignored_as_trace: report.ignored_as_trace,
          contribute_nothing: report.contribute_nothing,
          covered: report.covered,
          of: report.of,
        },
        content: [{ type: "text", text: nutritionSentence(report) }],
      };
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

  for (const view of views) {
    registerAppResource(server, view.title, view.uri, { description: `Mise view: ${view.title.toLowerCase()}` }, async () => ({
      contents: [{ uri: view.uri, mimeType: RESOURCE_MIME_TYPE, text: view.html }],
    }));
  }

  server.registerTool(
    "pantry_audit",
    {
      title: "Check what the pantry is unsure about",
      description:
        "Ask the customer about the things the pantry is least sure of: amounts nobody counted, items nothing has confirmed in a while, food that is probably past its date. Use when they ask what needs checking, what you are unsure about, whether the list is right, or when a tidy-up of the pantry would help. Returns questions to put to them, heaviest first; their answers go back through pantry_update as a correction or a removal. Reads only — it changes nothing on its own. Needs a linked account.",
      inputSchema: {
        limit: z.number().int().min(1).max(20).optional().describe("How many things to ask about; five otherwise"),
        only: z.enum(["stale", "unknown_amount", "inferred", "past_estimate", "past_date"]).optional().describe("Narrow to one kind of doubt"),
      },
      outputSchema: {
        questions: z.array(
          z.object({
            ingredient_id: z.string(), location: z.string(), unit: z.string(),
            qty: z.number().nullable(), qty_known: z.boolean(), confidence: z.string(),
            age_days: z.number().int(), days_to_expiry: z.number().int().nullable(), expiry_source: z.string(),
            reasons: z.array(z.string()), weight: z.number().int(), question: z.string(),
          }),
        ),
        /** How many lines are worth asking about in total, of which `questions` is the top slice. */
        worth_asking: z.number().int(),
        confidence: z.object({
          total: z.number().int(), confirmed: z.number().int(), inferred: z.number().int(), stale: z.number().int(),
          confirmed_pct: z.number().int(), inferred_pct: z.number().int(), stale_pct: z.number().int(),
          unknown_amount: z.number().int(), estimated_dates: z.number().int(),
          score: z.number().int(), score_basis: z.string(),
        }),
        as_of: z.string(),
      },
      _meta: { ui: { resourceUri: VIEW_URIS.pantry } },
    },
    async (args) => {
      if (!DEMO_USER) {
        return { isError: true, content: [{ type: "text", text: "This needs a linked account. Link Mise in the Alexa app and ask again." }] };
      }
      const now = new Date().toISOString();
      const { fold } = await pantryFor(DEMO_USER, now);
      const confidence = confidenceOf(fold.items);
      const all = auditQuestions(fold.items, { limit: 20, only: args.only as AuditReason | undefined });
      const questions = auditQuestions(fold.items, { limit: args.limit ?? 5, only: args.only as AuditReason | undefined });

      const spoken = questions.length === 0
        ? `Nothing to check. ${confidenceSentence(confidence)}`
        : `${confidenceSentence(confidence)} ${questions.map((q) => q.question).join(" ")}`;
      return {
        structuredContent: { questions, worth_asking: all.length, confidence, as_of: now },
        content: [{ type: "text", text: spoken }],
      };
    },
  );

  registerCartTools(server, {
    catalog,
    index: skuIndex,
    carts,
    plans,
    resolve,
    userId: () => DEMO_USER,
    now: () => new Date().toISOString(),
    newId: () => `cart-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
    baseUrl: BASE_URL,
  });

  registerPlanTools(server, {
    recipes: () => recipes,
    // The plan's figure and the basket's come from the same function, so a week that says $26 and a
    // basket that says $31 is not something anybody discovers at the checkout.
    priceOf: (want) => priceOfWanted(skuIndex, { ingredient_id: want.ingredient_id, unit: want.unit as Unit, qty: want.qty }),
    currency: catalog.currency,
    plans,
    pantryItems: async (userId, now) => (await pantryFor(userId, now)).fold.items,
    resolve,
    userId: () => DEMO_USER,
    now: () => new Date().toISOString(),
  });

  registerCookTools(server, {
    recipeById: (id) => byId.get(id),
    sessions,
    pantry: store,
    resolve,
    userId: () => DEMO_USER,
    now: () => new Date().toISOString(),
    // Sortable by time and unique without a database sequence: the same shape a ULID gives.
    newId: () => `cook-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
    scaling,
    swaps,
    tableSuggests,
    longStep: (recipeId, step) => longStepIndex.get(longStepKey(recipeId, step)),
  });

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

/** How near a shelf-life estimate has to be before the spoken pantry list mentions it at all. */
const ESTIMATE_SPEAK_WITHIN_DAYS = 14;

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
  html(res, renderPantryPage(fold.items, lines, now, {
    location: url.searchParams.get("location") ?? undefined,
    invalid: fold.invalid,
    confidence: confidenceOf(fold.items),
  }));
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

/** The demo store's HTTP surface: the UCP profile and the five checkout calls, plus the two pages
 *  the profile links to. `handleUcp` owns the protocol; this owns reading the body and the headers. */
async function serveStore(pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!UCP_TOKEN || !DEMO_USER) {
    json(res, 503, { error: "checkout_closed", message: "The demo store is closed: UCP_TOKEN and DEMO_USER must both be set." });
    return;
  }
  if (pathname === "/store/refund-policy") { html(res, renderRefundPolicyPage(catalog.store.name)); return; }
  if (pathname.startsWith("/store/receipts/")) {
    const orderId = pathname.slice("/store/receipts/".length);
    const session = ORDER_ID.test(orderId) ? await checkouts.getByOrder(orderId) : null;
    if (!session || session.order === null) { send(res, 404, "No such receipt."); return; }
    html(res, renderReceiptPage({
      order_id: session.order.id,
      placed_at: session.updated_at,
      currency: session.currency,
      lines: session.line_items.map((l) => ({ title: l.title, quantity: l.quantity, total_cents: l.total_cents })),
      totals: session.totals,
      disclosures: session.messages.filter((m) => m.presentation === "disclosure").map((m) => m.content),
    }));
    return;
  }

  let body = "";
  if (req.method !== "GET") {
    try { body = await readBody(req); }
    catch (err) { if (err instanceof BodyTooLarge) tooLarge(req, res); else json(res, 400, { error: "unreadable_body" }); return; }
  }
  const result = await handleUcp(ucpDeps, {
    method: req.method ?? "GET",
    path: pathname === "/.well-known/ucp" ? pathname : pathname.slice("/store".length),
    body,
    headers: {
      authorization: req.headers.authorization,
      "idempotency-key": req.headers["idempotency-key"] as string | undefined,
      "ucp-agent": req.headers["ucp-agent"] as string | undefined,
      "request-id": req.headers["request-id"] as string | undefined,
    },
  });
  if (result === null) { send(res, 404, "No such store route."); return; }
  json(res, result.status, result.body);
}

/** What each published path serves. Built once: these are files, and they do not change under us. */
const DATA_ROUTES: Record<string, () => Record<string, unknown>> = {
  "/data/substitutions.json": () => substitutions as unknown as Record<string, unknown>,
  "/data/shelf-life.json": () => shelfLifeTable as unknown as Record<string, unknown>,
  "/data/scaling.json": () => scalingTable as unknown as Record<string, unknown>,
};

function serveData(pathname: string, res: ServerResponse): boolean {
  if (pathname === "/data" || pathname === "/data/") {
    const entries = PUBLISHED.map((p) => {
      const table = DATA_ROUTES[p.path]() as { entries?: unknown[]; version: number; updated_on: string };
      return { ...p, rows: table.entries?.length ?? 0, version: table.version, updated_on: table.updated_on };
    });
    html(res, renderDataIndexPage(entries, DATA_LICENSE));
    return true;
  }
  const meta = PUBLISHED.find((p) => p.path === pathname);
  if (!meta) return false;
  const body = publish(DATA_ROUTES[pathname](), meta, { baseUrl: BASE_URL, repository: REPOSITORY_URL });
  send(res, 200, JSON.stringify(body, null, 2), "application/json; charset=utf-8", {
    // Published data is meant to be fetched by other people's software, which is the one thing here
    // that benefits from being cached.
    "cache-control": "public, max-age=3600",
    "access-control-allow-origin": "*",
  });
  return true;
}

/** Order ids are 32 hex characters from randomBytes(16). Checked before any lookup so that the path
 *  can never be anything but an id. */
const ORDER_ID = /^order_[0-9a-f]{32}$/;

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", BASE_URL);
  const { pathname } = url;
  try {
    if (pathname === "/healthz") { send(res, 200, "ok"); return; }
    if (req.method === "GET" && serveRecipes(pathname, res)) return;
    if (req.method === "GET" && serveData(pathname, res)) return;
    if (req.method === "POST" && pathname.startsWith("/ingest/")) { await serveIngest(pathname.slice("/ingest/".length), req, res); return; }
    if (req.method === "GET" && pathname === "/pantry") { await servePantry(url, res); return; }
    if (pathname === "/sim/fridge" && (req.method === "GET" || req.method === "POST")) { await serveSimFridge(req, res); return; }
    if (pathname === "/.well-known/ucp" || pathname === "/store" || pathname.startsWith("/store/")) {
      await serveStore(pathname, req, res);
      return;
    }
    if (pathname === "/mcp" && req.method === "POST") {
      // Stateless Streamable HTTP: one server + transport per request.
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
    send(res, pathname === "/" ? 200 : 404, "Mise. POST /mcp · GET /recipes · GET /data · GET /pantry · GET /sim/fridge · POST /ingest/:source · GET /.well-known/ucp");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, "Internal error.");
  }
});

httpServer.listen(PORT, () => {
  console.log(
    `mise listening on ${BASE_URL} — MCP at /mcp, ${recipes.length} recipes at /recipes, ` +
      `${substitutions.entries.length} substitution rows, ${catalog.skus.length} SKUs, ` +
      `pantry at /pantry (${DEMO_USER ? `user: ${DEMO_USER}` : "no demo user: account surfaces closed"}), ` +
      `ingest ${sources.length ? "open" : "closed (set INGEST_SECRET)"}, ` +
      `checkout ${UCP_TOKEN && DEMO_USER ? "open at /store" : "closed (set UCP_TOKEN)"}, ` +
      `${views.length} MCP Apps views${uiRuntime === null ? " (runtime bundle missing — run npm run build)" : ""}`,
  );
});
