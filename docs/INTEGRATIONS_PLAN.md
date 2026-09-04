# Mise — IoT and recipe-portal integration plan (block I)

> Extends `docs/PLAN.es.md` (blocks A–H) with a block **I · Integrations**. Written in response to the
> team's proposal (3 Sep 2026): smart fridges that track and reorder food (Samsung Family Hub with
> Instacart, GE Profile Kitchen Assistant), their platforms (Samsung Food, Taste of Home), and the
> leading recipe portals (Cookpad, Allrecipes, ChefSteps), with KitchenPal, NoWaste, Pantry Check and
> FridgeBuddy as product references. Spanish version: `docs/PLAN_INTEGRACIONES.es.md`.
>
> Every claim about an external API carries a label. **[verified]** = read in official documentation,
> or in search results pointing at official documentation. **[unverified]** = prior knowledge; confirm
> before betting time on it. **[blocked]** = the documentation could not be opened from the environment
> this plan was written in.

## 0 · Five lines

1. Integrations **do not change the architecture**. They are *sources of pantry events* and *recipe
   exchange formats*. The append-only ledger with origin and confidence was designed for this; what
   it gains is more origins (`smartthings`, `barcode`, `receipt`, `import`) and a `location` field
   (fridge, freezer, pantry, a second place).
2. **Nothing external sits on the Alexa+ response path** (500 ms budget). Every integration runs out of
   band: an inbound signed webhook, a sync job, or an action on the account web. MCP tools only read
   what is already in the store.
3. Of everything proposed, what has a public API usable in a hackathon is **SmartThings** (the Samsung
   fridge), **Instacart Developer Platform** (a real purchase path), **Open Food Facts** (barcodes) and
   **schema.org Recipe JSON-LD** (import/export with any portal). GE SmartHQ has a developer portal
   but inventory access is unconfirmed. Samsung Food, Cookpad, Allrecipes, ChefSteps and Taste of Home
   have **no public API** for third parties: they are integrated through JSON-LD, not an API.
4. We do not own a connected fridge. The demo uses a **simulated adapter with the same contract** as
   the real one, and the video says so. A faked integration presented as real is precisely what this
   project sets out not to do.
5. Order: first what de-risks (keys, payload shapes, JSON-LD), then the SmartThings adapter, then
   Instacart. Everything else is documented as extensible, not built.

## 1 · What the team asked for, and what is actually possible

| Proposal | What exists | Status | Decision |
|---|---|---|---|
| Samsung Family Hub (camera, food list, ordering via Instacart) | The fridge is a **SmartThings** device. The public SmartThings API (REST, personal token or OAuth) exposes devices and capabilities; the Family Hub food/shopping list is the part to confirm — community threads ask how to read it via the API. Ordering via Instacart is a closed Samsung–Instacart deal, not an API for us. | SmartThings API [verified to exist]; food-list capability [unverified, blocked]. | **Build**: a `smartthings` adapter over the public API, with a simulator for the demo. Confirm the exact capability id (candidate: `samsungce.fridgeFoodList`) with a real token. |
| GE Profile Kitchen Assistant | `developer.smarthq.com` exists, with OAuth 2.0 and a "Digital Twin API" for GE appliances. Nothing seen that exposes Kitchen Assistant food tracking to third parties. | Portal [verified to exist]; inventory [unverified, blocked]. | **Do not build.** Leave the adapter contract ready so a second manufacturer enters without touching the core. |
| Samsung Food (formerly Whisk) | Whisk documentation exists (`docs.whisk.com`) but access is for partners and grocers; no open signup. Samsung Food **imports recipes from a URL** via JSON-LD, like nearly every recipe app. | [verified: partner docs]; URL import [unverified]. | **Integrate through JSON-LD**: publish every Mise recipe as an HTML page with `schema.org/Recipe`, importable from Samsung Food, Paprika, Family Hub and the rest. |
| Taste of Home, Cookpad, Allrecipes, ChefSteps | No public API for third parties. All publish JSON-LD `Recipe` in their pages (Allrecipes for certain; the rest to be checked with one URL each). | [verified for Allrecipes via third-party documentation]. | **Import through JSON-LD** into our contract, with `source.kind: "imported"`, `needs_review: true`, and the original block kept verbatim. Never scrape free-form HTML. |
| Ordering from the fridge | What does exist is **Instacart Developer Platform**: creates a "shopping list page" or "recipe page" from a list of ingredients and returns a URL. Open signup, development environment. | [verified in official documentation]. | **Build**: `cart_from_plan` returns an `instacart_url` for what is missing, alongside the UCP cart. Alexa+ checkout remains UCP (the platform requires it); Instacart is the "buy where you always buy" exit. |
| Barcodes (KitchenPal, Pantry Check) | **Open Food Facts**: `GET /api/v2/product/{barcode}` with `fields=`, no key. | [verified]. | **Build**, cheaply: a `barcode` ingest that resolves the product and writes an `add` event with confidence `confirmed`. |
| Receipt and photo scanning (NoWaste) | Needs OCR or vision. Doing it ourselves breaks the "no LLM of our own" rule. | — | **Do not build.** Keep `receipt` as an origin in the contract, fed by webhook from any app that already does it. |

## 2 · Design principle

**An integration is a producer of pantry events or a translator of recipes. Never a tool.**

```
   sources                          ingest (out of band)                  what Alexa+ sees
   ─────────────────────            ────────────────────────────         ───────────────────
   voice (Alexa+) ────────────────► tool pantry_update ───────────┐
   SmartThings (poll / webhook) ──► POST /ingest/smartthings ──────┤
   barcode scanner ──────────────► POST /ingest/barcode ──────────┼──► PANTRY_EVT (ledger) ──► fold ──► pantry_list, plan_week
   receipt app ───────────────────► POST /ingest/receipt ──────────┤        origin + confidence + location
   UCP checkout / Instacart ──────► add event origin=checkout ─────┘

   portal URL (JSON-LD) ─────────► importer ──► data/imports/<id>.json (needs_review) ──► human ──► data/recipes/
   Mise recipe ───────────────────► GET /recipes/<id> (HTML + JSON-LD) ──► Samsung Food, Paprika, Family Hub, Google
```

Three rules follow:

- **Confidence by origin.** Each adapter declares the strongest thing it may claim: voice and barcode
  → `confirmed`; a fridge camera → `inferred` (the camera recognizes "there are tomatoes", not how
  many or when they expire); a receipt → `confirmed` for the item, `inferred` for the amount if the
  receipt does not carry one. The fold and `pantry_list` already know how to narrate that reservation.
- **Idempotent ingest.** Every external event carries an `external_id` (device id + timestamp, or a
  receipt hash). The same `external_id` twice does not double the pantry. Same guarantee as UCP's
  `Idempotency-Key`.
- **Nothing blocks Alexa+.** If SmartThings takes four seconds or is down, the pantry answers with
  the last sync and a `synced_at` that `pantry_list` can narrate ("the fridge last reported an hour
  ago").

## 3 · Data model changes

On top of the single table in the original plan:

| Entity | Change |
|---|---|
| `PANTRY_EVT` | `origin` vocabulary grows: `voice \| recipe_deduction \| checkout \| smartthings \| barcode \| receipt \| import`. New optional fields: `location` (`fridge \| freezer \| pantry \| other:<name>`), `external_id`, `source_device`. |
| `USER#id / SOURCE#<kind>#<id>` | New: a connected source. `kind`, `label` ("kitchen fridge"), encrypted credentials or a Secrets Manager reference, `synced_at`, `last_error`, `enabled`. |
| `RECIPE#id / V#n` | `source.kind`: `book \| imported`. For `imported`: `source.url`, `source.site`, `source.fetched_at`, `source.jsonld_sha256` (the original JSON-LD kept verbatim, as `original_text` is for books). |

`location` is the one idea from FridgeBuddy and NoWaste that changes data: it allows "what's in the
freezer?" and several places (garage, weekend house) for no more than a filter in `pantry_list`.

## 4 · Components

### 4.1 Adapter contract (`src/integrations/`)

```ts
interface PantrySource<Payload> {
  kind: "smartthings" | "barcode" | "receipt" | "simulated";
  /** The strongest confidence this source may assert. Enforced by runSource, not by trust. */
  maxConfidence: "confirmed" | "inferred";
  /** Pure: receives a payload someone else fetched, returns events plus what it could not map. */
  toEvents(payload: Payload, ctx: { userId; now; resolve }): { events; unmapped };
}
```

`toEvents` is pure and deterministic; it is tested against payloads saved as fixtures
(`test/fixtures/`). Network access lives elsewhere, outside the MCP server.

### 4.2 HTTP ingest

- `POST /ingest/:source` with an HMAC signature per connected source (`X-Mise-Signature`), a
  mandatory `Idempotency-Key`, and a 202 response. Writes events; a replay answers 202 with nothing
  appended; a reused key with a different body is a 409.
- `POST /sources/:kind/sync` (from the account web only): triggers a manual sync. Enough for the
  demo; an App Runner or EventBridge schedule every N minutes is the next step.

### 4.3 SmartThings adapter

1. A SmartThings personal token from an account with a Family Hub (someone on the team with the
   fridge, or a contact lending a token for an afternoon). Without it, the real adapter is written
   against documentation and **not shown as working**.
2. `GET /v1/devices` → filter for a fridge capability; `GET /v1/devices/{id}/status` → read the food
   list if the capability is public.
3. Map food names to canonical ids through `data/source_aliases.json`. What does not map is reported
   as `unmapped` and `pantry_list` narrates it ("the fridge reported 'kimchi', which I don't know yet").
4. Confidence `inferred`, `location: fridge`, `external_id = deviceId + reading timestamp + name`.

### 4.4 Simulated fridge (for the demo)

- The same payload shape the real adapter reads (copied from a real status once we have a token; until
  then, from the documented envelope, and the README says so).
- A page on the account web, "Simulated fridge", with the food list as editable rows. Serves the video
  and the planner's tests.
- In the video: "The fridge logged the tofu on Monday" appears with the `inferred` badge and origin
  `fridge`. Honest, and it shows the ledger's argument better than voice alone.

### 4.5 Barcodes (Open Food Facts)

- `POST /ingest/barcode` with `{ scan: { ean, scanned_at, packages?, location?, expires_on? } }` → the
  server fetches `GET https://world.openfoodfacts.org/api/v2/product/{ean}?fields=…` with a timeout and
  a cache → an `add` event, `confirmed`. Package size times package count when both are known; a
  missing count does not assume one package.
- Product name and category tags go through the same resolver as everything else, most specific
  first. What does not map stays `unmapped`.

### 4.6 Recipes: import and export through JSON-LD

- **Export**: `GET /recipes/:id` serves HTML with a `schema.org/Recipe` block generated from
  `data/recipes/<id>.json`. Provenance is encoded by omission: a stated value is published plainly, an
  estimate is published and flagged, an unspecified value is left out. A `mise:` provenance block
  carries role, technique and every `*_source` flag so another Mise instance can round-trip a recipe
  without losing the chef's judgment. This is what makes Mise readable by Samsung Food, Paprika,
  Family Hub, Google and any portal. Zero risk, one afternoon.
- **Import**: `scripts/import_jsonld.py <page>` extracts the `Recipe` block, keeps it verbatim with its
  hash, and writes a staging file with `role`, `technique`, ingredient `id` and `diet.vegan` set to
  `null`. Quantities are parsed only when plainly stated; ranges and prose stay unspecified with the
  site's wording kept. `validate_recipes.py --staging` checks that weaker contract. Promotion to
  `data/recipes/` is a human filling in the nulls; the full contract applies there.
- Test one URL from each portal and record in `docs/IMPORT_SOURCES.md` which carries complete JSON-LD.
  That is "portal support" as something we can state with evidence.
- **Not by voice.** A `recipe_import` MCP tool would put an external fetch on the response path.
  Importing is an account-web action.

### 4.7 Instacart Developer Platform

- Sign up, get a development key.
- `POST …/products/products_link` (shopping list page) with `line_items[{name, quantity, unit}]` built
  from the plan's missing items → returns a URL. [shape verified at documentation level; exact fields
  to confirm while implementing].
- `cart_from_plan` adds `instacart_url` to `structuredContent`; the cart view shows "Open in Instacart"
  next to UCP checkout. The Instacart call happens **when the plan is generated** (outside the voice
  turn) or from the view — never inside `cart_from_plan` if it exceeds the budget; measure.
- Closing the loop: Instacart does not notify third parties of purchases. What was bought there comes
  back into the pantry by voice or by barcode, not automatically, and the README says so.

### 4.8 Pantry view, with what the references contribute

- Confidence badge (already planned) plus a **freshness light** (Pantry Check): green beyond 3 days,
  amber within 1–3, red today or past, grey when no date. All integer, deterministic, computed
  server-side.
- Filter by **location** (FridgeBuddy / NoWaste): fridge, freezer, pantry, other named places.
- A "sources" line: "Voice · Kitchen fridge (last report 12 min ago) · Barcode". Shows where each
  datum came from without explaining it.

## 5 · Block I · work inventory

In the order that reduces risk fastest. No dates. All of it can go to a person who is not on recipes.

**I.0 · De-risk (half a day, before writing code)**
- Get an Instacart Developer Platform key and make one call by hand with two items. Save request and
  response as a fixture.
- Get a SmartThings personal token from someone with a Family Hub; `GET /v1/devices` and the fridge's
  `GET status`. Save the JSON as a fixture. If none can be had, decide explicitly: simulator with the
  documented shape.
- Open one URL from each portal (Allrecipes, Cookpad, ChefSteps, Taste of Home, Samsung Food) and save
  the JSON-LD they carry. Note which does not.
- Confirm App Runner's egress policy allows those hosts.

**I.1 · Data and contract**
- Wider `origin` vocabulary, `location`, `external_id`, `SOURCE#` entity.
- `PantrySource` + `simulated` adapter + fixture tests (fold with events from several origins; same
  `external_id` twice does not double; confidence never exceeds `maxConfidence`).

**I.2 · Recipes through JSON-LD**
- `GET /recipes/:id` with JSON-LD. Validate with Google's rich-results tool or the schema.org validator.
- `scripts/import_jsonld.py` + `docs/IMPORT_SOURCES.md` with per-portal evidence.

**I.3 · Ingest**
- `POST /ingest/:source` with HMAC and idempotency; `POST /sources/:kind/sync`.
- `barcode` adapter with Open Food Facts and a cache.
- `smartthings` adapter (real if there is a token; against fixtures regardless).

**I.4 · Purchase**
- Instacart client, `instacart_url` in `cart_from_plan`, button in the cart view.

**I.5 · View and demo**
- Freshness light, location filter, sources line on the pantry view.
- "Simulated fridge" page on the account web.
- Video segment: between 0:00 and 0:30, "The fridge logged the tofu on Monday; you said the lentils
  this morning", with the two different badges.

**Out of scope, written down so it does not come back to the table**: GE SmartHQ (no confirmed
inventory access), receipt and photo OCR (breaks "no LLM of our own"), the Samsung Food API (partners
only), scraping portals without JSON-LD, push notifications for expiry (Alexa+ documents no
proactivity for add-ons; it stays a question to the planner: "what's expiring?").

## 5.bis · Implementation status

What is in the repository, with its tests. Everything else in block I is still pending.

| Item | Status | Where |
|---|---|---|
| Pantry event contract (origin, confidence, location, `external_id`, integer milli-units) | done | `src/pantry/events.ts` |
| Deterministic fold: idempotency, honest degradation, `stale` derived from the clock | done | `src/pantry/fold.ts` |
| Ledger store interface, in-memory implementation with a file mirror, idempotency keys | done | `src/pantry/store.ts` |
| `PantrySource` contract + `runSource` clamping confidence to the declared ceiling | done | `src/integrations/types.ts` |
| Simulated fridge adapter with a SmartThings-shaped envelope | done | `src/integrations/simulated_fridge.ts` |
| External-name resolution to canonical ids, `unmapped` as a first-class output | done | `src/integrations/aliases.ts`, `data/source_aliases.json` |
| Signed ingest door: HMAC, `Idempotency-Key`, replay 202 / conflict 409, `POST /ingest/:source` | done | `src/integrations/ingest.ts`, `src/server.ts` |
| Barcode adapter (Open Food Facts) with package math and a timed, cached lookup | done, lookup unexercised (egress blocked here) | `src/integrations/barcode.ts`, `off_client.ts` |
| Account web: pantry view with badges, freshness light, locations, sources; simulated fridge page | done | `src/pages.ts`, `GET /pantry`, `/sim/fridge` |
| `pantry_list` MCP tool over the same fold | done (demo account until block B linking) | `src/server.ts` |
| Export recipes as pages with JSON-LD, English primary with the book's Spanish beside it | done | `src/recipe_jsonld.ts` |
| Import from JSON-LD into staging, conservative quantity parsing | done | `scripts/import_jsonld.py` |
| Staging contract and its validator | done | `scripts/validate_recipes.py --staging`, `docs/RECIPE_SCHEMA.md` |
| Tests, including the export → import round trip, each checked against a deliberately broken implementation | done | `test/` (`npm test`) |
| Robustness review: correctness, security, degradation, concurrency; every finding fixed with a red-first test | done | `docs/ROBUSTNESS_REVIEW.md` |
| I.0 de-risk: Instacart key, SmartThings token, per-portal evidence | **pending, needs human hands** | `docs/IMPORT_SOURCES.md` |
| Real SmartThings adapter | pending, blocked on I.0 | — |
| Instacart in `cart_from_plan` | pending, blocked on I.0 | — |
| Scheduled sync (`/sources/:kind/sync`) | pending, needs block B sources | — |

Two things the implementation changed against the plan, both toward more honesty:

- **Pantry quantities are integers in thousandths of a unit**, not decimals. A pantry is summed over
  and over, and `0.1 + 0.2` must not drift. Conversion happens once, at the boundary.
- **Units are never converted into each other.** 2 cups of flour and 500 g of flour are two honest
  lines, not one invented sum. A line is (ingredient, unit, location).

## 6 · How it serves the rubric

| Rubric | Where it lives |
|---|---|
| Agentic workflow orchestrating services | fridge → ledger → planner → UCP cart / Instacart → pantry. One more service in the chain, and Alexa+ never has to name it. |
| Context-aware add-on with state across sessions | the pantry updates without the person speaking; `pantry_list` narrates where each datum came from and when. |
| Purchase capabilities | UCP (platform requirement) plus an exit to a real retailer through Instacart. |
| The "obvious" to avoid | no integration is a wrapper: each enters the ledger with origin, confidence and idempotency, and the planner is what decides. |

## 7 · Risks and pending verifications

- **verify** The public SmartThings capability for the Family Hub food list. Without a real token, the
  adapter is written against documentation and the demo uses the simulator. [blocked from this
  environment]
- **verify** Exact fields and limits of Instacart's shopping list page, and whether the development
  environment returns openable URLs. [documentation blocked from this environment; verify with a key]
- **verify** That Samsung Food imports from our JSON-LD page (five-minute manual test with the app).
  The exporter already serves the pages; a public host and the test are what is missing.
- **verify** Which portals carry complete JSON-LD. The four we tried are blocked by this environment's
  egress proxy, so the parser was developed against our own exported pages and against the text forms
  these sites publish. The evidence table in `docs/IMPORT_SOURCES.md` is empty on purpose.
- **verify** Latency of the Instacart call; if it exceeds the budget, move it to plan generation.
- **decision** No OCR or vision of our own. Anything that requires recognizing a photo enters by
  webhook from an app that already does it, or does not enter.
- **decision** Every integration is shown in the video as what it is: real with a real token, or
  simulated with the real shape. Never the second presented as the first.

## 8 · Sources consulted

- Instacart Developer Platform: introduction, shopping list page, recipe page, API reference
  (`docs.instacart.com/developer_platform_api`).
- Open Food Facts API v2 (`openfoodfacts.github.io/openfoodfacts-server/api/`).
- SmartThings: Samsung support pages on View Inside, Food List and shopping lists; the community
  thread on reading lists through the API.
- SmartHQ Developer Portal (`developer.smarthq.com`); open-source `gekitchen` and `ha_gehome`.
- Samsung Food / Whisk: partner docs (`docs.whisk.com`), Grocer Integration Overview.
- schema.org `Recipe`; Google's recipe structured-data guide.
- Product references cited by the team: KitchenPal, NoWaste, Pantry Check, FridgeBuddy.
