# Mise

**An MCP add-on for Alexa+ that keeps your pantry by voice, plans the week around what you have and what is about to expire, guides cooking step by step without losing the thread between sessions, substitutes with a chef's judgment, and buys what is missing.**

Amazon Developer Hackathon 2026 — track Alexa+. Mini-challenges: AWS Builder, Open Source.

## What it does

- **Pantry by voice.** "I've got two onions, half a kilo of red lentils, and the tofu expires Friday." The pantry is an append-only ledger, not an inventory: every item carries a confidence level — `confirmed` (you said it), `inferred` (a cooked recipe deducted it), `stale` (unconfirmed for N days). The system never presents an inferred quantity as certainty.
- **Weekly plan from what is there.** A deterministic integer scorer fills each meal slot: use what expires soonest, minimize what is missing, respect the time budget, avoid repeating a protein back to back. Same pantry state, same plan, same plan hash — and every meal comes with its reason ("Thursday: tofu stir-fry because the tofu expires Friday").
- **Cooking as a state machine.** Ordered steps with durations, parallel timers and dependencies. "Pause." — a day later, on another device — "Where was I?" resumes at step 5 with the timer where it stopped. Saying you did something out of order is recorded as a deviation, never an error.
- **Substitutions with a chef's judgment.** A curated, versioned table keyed by (ingredient, role, technique). Alexa+ does not invent substitutions; it chooses among the ones written here, each with a ratio and a warning ("aquafaba does not bind when hot").
- **Buy what is missing.** A demo store exposed through UCP (Universal Commerce Protocol) checkout. Completing a purchase writes back to the pantry, so the next weekly plan already sees it. The loop closes.

## Architecture in one paragraph

**Alexa+ is the LLM. This server has no model of its own.** It exposes tools over MCP (Streamable HTTP); Alexa+ decides when to call them, extracts the entities from what the person said, and narrates the result. The server is data plus deterministic logic: every tool is a DynamoDB read/write plus pure computation, with no external call on the response path, so it stays under the platform's 500 ms budget. One container on AWS App Runner (min 1 instance, TLS out of the box) serves three surfaces under one URL: the MCP server (`POST /mcp`), the UCP store endpoints, and OAuth 2.1 account linking (authorization code + PKCE S256, `resource` parameter, PRM document). State between sessions is keyed to the linked account; guest mode still serves `recipe_search` and `substitute`.

## What is deterministic and what Alexa+ does

| The server decides (all that counts) | Alexa+ does |
|---|---|
| pantry ledger fold and confidence levels | understands what the person said |
| weekly plan, its rationale and its hash | decides which tool to call, and when |
| cooking session transitions and deviations | keeps the conversational thread |
| substitution lookup from the curated table | narrates the result, with the reservations the data marks |
| prices, stock, tax, checkout state (UCP) | drives the checkout surface |

If a change to the narrator could ever change a decision, that is a defect in the architecture.

## Status

Hackathon build. The parts that need no Amazon developer account, no cloud bill and no outbound
access to a third party are **built, tested and exercised end to end**; the parts that do are listed
one by one in `docs/BLOCKED.md`, with what blocks them, what to run when they are unblocked, and what
evidence to record. Nothing here is described as working until somebody has watched it work — the
add-on has never met Alexa+, and the first milestone is still a round trip in the Web Simulator.

What runs today, all of it deterministic and all of it covered by tests that can fail:

| | |
|---|---|
| **The pantry** | An append-only ledger with a deterministic fold and three confidence levels. `pantry_update` and `pantry_list` over MCP; a signed, idempotent `POST /ingest/:source` door with a simulated fridge and a barcode adapter behind it; an account web at `/pantry` and `/sim/fridge`. One figure says how much of the kitchen rests on something you actually said, and `pantry_audit` asks about the rest. |
| **How long it keeps** | 149 curated shelf-life rows, derived at fold time and never stored. An estimate from the table and a date you gave stay two different things all the way to the sentence — "roughly four days by my reckoning" against "expiring today or tomorrow". |
| **Substitutions** | 90 curated rows keyed on (ingredient, role, technique), each with an integer ratio, what changes and what breaks. `substitute` walks a fallback chain and says which level it answered from; an ingredient the table does not cover gets silence, out loud. |
| **Cooking** | A pure state machine: ordered steps, parallel timers, dependencies, and a transition log. Seven `cook_*` tools, and a second person can take a track of their own — the scheduler reads the dependency graph and says who does what, or says plainly that this recipe is one long chain and cannot be split. "Pause" — a day later, on another device — "where was I?" answers step 5 with the timer where it stopped. Finishing deducts what was used, as `inferred`, honouring any swap you recorded. `cook_review` reads the log back: how long each step really took, what was done out of order, and which questions the record cannot answer. |
| **The week** | `plan_week`: a deadline pass that schedules food on the last day it is still good, then a coverage pass, with a per-meal reason, a consolidated shopping list that counts shortfalls, and a plan hash. Time limits per day, a spending ceiling, and what the shopping costs. `plan_diff` says what changed since the last plan and why, quoting the planner rather than composing a story. |
| **Buying** | A demo grocery of 107 SKUs, `cart_from_plan` and `cart_edit`, and a UCP-shaped checkout — five endpoints, idempotency with 409, allergen disclosure, server-side tax and shipping. Completing writes back to the pantry, so the next plan already sees it. |
| **Views** | Four MCP Apps `ui://` resources — step card, weekly grid, cart, pantry — each one self-contained HTML with no network of its own. |
| **Recipes** | 49 recipes structured from the author's own cookbooks, served as `schema.org/Recipe` JSON-LD any app can import, and importable back the same way. |
| **Open data** | The three curated tables — substitutions, shelf life, scaling — published at `/data` under Apache-2.0, each carrying its version, its author, its contract and its own reservations *in the payload*. The week's shopping list travels as a `schema.org/ItemList`. |

`npm run check` runs the typecheck, 250 tests and six data validators.

No smart-fridge, Instacart or portal integration is claimed as verified: outbound access to those
services is not available here, so the fridge adapter is honestly named `simulated` and
`docs/IMPORT_SOURCES.md` keeps an evidence table that is empty until someone runs it against the real
thing. The checkout follows this project's reading of UCP and has never met a real client; its own
profile document says so in a `disclaimer` field.

Recipes, substitutions and the store catalog live as **data** (`data/`), not code. Recipes come from
the author's own cookbooks, structured under `docs/RECIPE_SCHEMA.md`: every number carries a
`stated | estimated | unspecified` flag, the original Spanish text travels verbatim beside the
English, and anything estimated is marked `needs_review`. The data never looks more certain than its
source.

`docs/IDEAS.md` is the list of what could come next, and what has been deliberately ruled out.

## Run locally

```bash
npm install
npm run build
INGEST_SECRET=dev-secret UCP_TOKEN=dev-token npm start   # http://localhost:8080 — MCP at /mcp
curl localhost:8080/healthz
open http://localhost:8080/pantry                     # the pantry, as the fold sees it
open http://localhost:8080/sim/fridge                 # drive the demo fridge by hand
open http://localhost:8080/recipes                    # importable recipe pages
curl localhost:8080/recipes/vegan-gnocchi.json        # the JSON-LD on its own
curl localhost:8080/.well-known/ucp                   # the demo store's checkout profile
open http://localhost:8080/data                       # the curated tables, with their caveats
curl localhost:8080/data/substitutions.json           # one of them on its own

npm run check      # typecheck + tests + data validators
```

Environment: `PORT`, `BASE_URL` (the public origin; used for recipe `@id`s and for the same-origin
check on `/sim/fridge`, so set it on a deployment), `DEMO_USER` (the account that owns everything
until linking exists; default `demo`; set it empty to close every account-bound surface),
`INGEST_SECRET` (HMAC secret for the two demo sources at `POST /ingest/sim-fridge` and
`/ingest/scanner`; unset closes that door), `UCP_TOKEN` (the bearer the demo store's checkout
accepts; unset and `/store` answers 503 — it is a shared secret, not authentication, until block B),
and the optional JSON mirrors that let a local demo survive a restart: `PANTRY_FILE`, `COOK_FILE`,
`PLAN_FILE`, `CART_FILE`. An unreadable mirror refuses to start rather than starting empty.

There are no accounts yet, so `/pantry` and `/sim/fridge` are open to whoever can reach them. The demo fridge page only accepts JSON posts from its own origin carrying the token it was served with, so a foreign website cannot write into the pantry; that is the extent of it until block B. `docs/ROBUSTNESS_REVIEW.md` records what was reviewed, what was found and what is still unverified.

A signed delivery, for reference:

```bash
BODY='{"scan":{"ean":"0000000000017","scanned_at":"2026-09-04T09:30:00Z","packages":2,"location":"fridge"}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac dev-secret | sed 's/^.* //')"
curl -X POST localhost:8080/ingest/scanner -H "X-Mise-Signature: $SIG" -H 'Idempotency-Key: scan-1' -d "$BODY"
```

## Layout

```
src/server.ts                 MCP server (Streamable HTTP), the HTTP routes, and what is wired to what
src/recipes.ts                recipe loading and deterministic search
src/recipe_jsonld.ts          schema.org/Recipe export: how a recipe leaves the building
src/substitutions.ts          the curated table's loader and its (ingredient, role, technique) lookup
src/pantry/                   the pantry ledger: event contract, deterministic fold, shelf life, store, audit
src/cook/                     the cooking state machine, the two-cook scheduler, scaling, the post-mortem
src/open_data.ts              what leaves the building, with its provenance and its reservations
src/plan/                     the weekly planner: deadlines, coverage, cost, the plan hash, and the diff
src/store/                    the demo grocery: catalog arithmetic, the cart, the UCP checkout
src/tools/                    the MCP tool registrations for cooking, the plan and the cart
src/ui/                       the four MCP Apps views and the app-side runtime bundled into them
src/integrations/             adapter contract, signed ingest, name resolution, simulated fridge, barcode
src/pages.ts                  the account web: pantry, simulated fridge, refund policy, receipts
data/recipes/<id>.json        recipes as data, one file each (see the contract below)
data/substitutions.json       the substitution table: 90 curated rows, versioned
data/catalog.json             the demo grocery: 108 SKUs, prices in integer cents, allergens
data/shelf_life.json          how long each food keeps, and where. Advice, labelled as advice
data/scaling.json             what does not multiply when the servings change
data/inventory.md             catalogue of every recipe found in the author's cookbooks
docs/RECIPE_SCHEMA.md         the recipe data contract: provenance, closed vocabularies, honesty flags
docs/SUBSTITUTION_SCHEMA.md   the substitution table's contract, and why the key is a triple
docs/STORE_SCHEMA.md          the catalog's contract and the checkout surface, verified and not
docs/SHELF_LIFE_SCHEMA.md     the shelf-life contract, and the rule that keeps an estimate an estimate
docs/SCALING_SCHEMA.md        what multiplies, what does not, and what the pan decides
scripts/validate_recipes.py   deterministic validator (stdlib); nothing enters data/ without passing it
scripts/validate_substitutions.py  the same for the substitution table, with a coverage report
scripts/validate_catalog.py   the same for the catalog: integer money, real ingredients, known allergens
scripts/validate_shelf_life.py  the same for the shelf-life table, with a coverage report
scripts/validate_scaling.py   the same for the scaling table: no damping above 1, no orphan warnings
scripts/consolidate_recipes.py merges per-book extractions into data/ (dry-run unless --apply)
docs/PLAN.md                  the architecture and work plan (English; Spanish original in PLAN.es.md / .html)
docs/INTEGRATIONS_PLAN.md     IoT, barcode, Instacart and recipe-portal integration plan (block I; Spanish in PLAN_INTEGRACIONES.es.md)
docs/IMPORT_SOURCES.md        what each recipe portal actually gives us, and how to verify one
docs/BLOCKED.md               what cannot be done from here, what to run when it can, what to record
docs/IDEAS.md                 what could come next, and what has been deliberately ruled out
docs/ROBUSTNESS_REVIEW.md     the block I review: findings, fixes, negative controls, blind spots
scripts/import_jsonld.py      import a portal recipe from its JSON-LD into data/imports/ (staging)
data/imports/                 imported recipes awaiting a human's roles, techniques and ids
data/source_aliases.json      external food names -> canonical ingredient ids
test/                         node --test; run with `npm test`
Dockerfile                    one container for App Runner
```

## License

Apache-2.0. See `LICENSE`.
