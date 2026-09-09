# Mise

**An MCP add-on for Alexa+ that keeps your pantry by voice, plans the week around what you have and what is about to expire, guides cooking step by step without losing the thread between sessions, substitutes with a chef's judgment, and buys what is missing.**

Amazon Developer Hackathon 2026 — track Alexa+. Mini-challenges: AWS Builder, Open Source.

## What it does

- **Pantry by voice.** "I've got two onions, half a kilo of red lentils, and the tofu expires Friday." The pantry is an append-only ledger, not an inventory: every item carries a confidence level — `confirmed` (you said it), `inferred` (a cooked recipe deducted it), `stale` (unconfirmed for N days). The system never presents an inferred quantity as certainty.
- **Weekly plan from what is there.** A deterministic integer scorer fills each meal slot: use what expires soonest, minimize what is missing, respect the time budget, avoid repeating a protein back to back. Same pantry state, same plan, same plan hash — and every meal comes with its reason ("Thursday: tofu stir-fry because the tofu expires Friday").
- **Cooking as a state machine.** Ordered steps with durations, parallel timers and dependencies. "Pause." — a day later, on another device — "Where was I?" resumes at step 5 with the timer where it stopped. Saying you did something out of order is recorded as a deviation, never an error.
- **Substitutions with a chef's judgment.** A curated, versioned table keyed by (ingredient, role, technique). Alexa+ does not invent substitutions; it chooses among the ones written here, each with a ratio and a warning ("aquafaba does not bind when hot").
- **Buy what is missing.** A demo store exposed through UCP (Universal Commerce Protocol) checkout. Completing a purchase writes back to the pantry, so the next weekly plan already sees it. The loop closes.
- **Zero Waste / Desperdicio Cero.** `zero_waste` turns the pantry into a cooking lesson: existing recipes ranked by urgent ingredients, then by pantry coverage, each paired with a versioned technique lesson (browning, emulsifying, baking, simmering, raw) in English and Spanish — a practice prompt and a plating exercise, only for a technique the matched recipe actually uses. It never invents a recipe, a substitution or a lesson for an unsupported technique, and it does not claim a measured saving: economy means checking what is on hand before buying, ecology means using food before it is discarded, neither is quantified in money or emissions. See `src/zero_waste.ts`.

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

Hackathon scaffold — **block A of the plan** (`docs/PLAN.md`): repository, TypeScript MCP server with a single `recipe_search` tool, Dockerfile. Not yet validated against Alexa+ end to end; the first milestone is a round trip in the Web Simulator.

Started on **block I, integrations** (`docs/INTEGRATIONS_PLAN.md`), the parts that need no external credentials. The pantry ledger has its event contract, deterministic fold and store; connected sources come in through a signed, idempotent `POST /ingest/:source` door; a simulated fridge and a barcode adapter (Open Food Facts) feed it; `pantry_update`, `pantry_list` and `zero_waste` work it over MCP — the video's opening line lands as confirmed events and is read back with every reservation the data carries; and a small account web (`/pantry`, `/sim/fridge`) shows the pantry with confidence badges, a freshness light and locations, and drives the demo fridge. Recipes exchange with the portal ecosystem in both directions: every Mise recipe is served as a page whose `schema.org/Recipe` JSON-LD any recipe app can import (English primary, the book's Spanish beside it), and `scripts/import_jsonld.py` reads such a page back into a reviewable staging file. `npm run check` runs the typecheck, the tests and the data validators.

No smart-fridge, Instacart or portal integration is claimed as verified: outbound access to those services is not available here, so the fridge adapter is honestly named `simulated` and `docs/IMPORT_SOURCES.md` keeps an evidence table that is empty until someone runs it against the real thing.

Recipes, substitutions and the store catalog live as **data** (`data/`), not code. Recipes come from the author's own cookbooks, structured under `docs/RECIPE_SCHEMA.md`: every number carries a `stated | estimated | unspecified` flag, the original Spanish text travels verbatim beside the English, and anything estimated is marked `needs_review`. The data never looks more certain than its source.

## Run locally

```bash
npm install
npm run build
INGEST_SECRET=dev-secret npm start   # http://localhost:8080 — MCP at /mcp
curl localhost:8080/healthz
open http://localhost:8080/pantry                     # the pantry, as the fold sees it
open http://localhost:8080/sim/fridge                 # drive the demo fridge by hand
open http://localhost:8080/recipes                    # importable recipe pages
curl localhost:8080/recipes/vegan-gnocchi.json        # the JSON-LD on its own

npm run check      # typecheck + tests + data validators
```

Environment: `PORT`, `BASE_URL` (the public origin; used for recipe `@id`s and for the same-origin check on `/sim/fridge`, so set it on a deployment), `DEMO_USER` (the account that owns the pantry until linking exists; default `demo`; set it empty to close every account-bound surface), `INGEST_SECRET` (HMAC secret for the two demo sources at `POST /ingest/sim-fridge` and `/ingest/scanner`; unset closes that door), `PANTRY_FILE` (optional JSON mirror of the in-memory ledger; an unreadable one refuses to start rather than starting empty).

There are no accounts yet, so `/pantry` and `/sim/fridge` are open to whoever can reach them. The demo fridge page only accepts JSON posts from its own origin carrying the token it was served with, so a foreign website cannot write into the pantry; that is the extent of it until block B. `docs/ROBUSTNESS_REVIEW.md` records what was reviewed, what was found and what is still unverified.

A signed delivery, for reference:

```bash
BODY='{"scan":{"ean":"0000000000017","scanned_at":"2026-09-04T09:30:00Z","packages":2,"location":"fridge"}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac dev-secret | sed 's/^.* //')"
curl -X POST localhost:8080/ingest/scanner -H "X-Mise-Signature: $SIG" -H 'Idempotency-Key: scan-1' -d "$BODY"
```

## Layout

```
src/server.ts                 MCP server (Streamable HTTP), tools, and the recipe pages
skills/<name>/SKILL.md        Agent Skills: how to use the tools well (open format; see skills/README.md)
src/recipes.ts                recipe loading and deterministic search
src/recipe_jsonld.ts          schema.org/Recipe export: how a recipe leaves the building
src/pantry/                   the pantry ledger: event contract, deterministic fold, store
src/integrations/             adapter contract, signed ingest, name resolution, simulated fridge, barcode
src/pages.ts                  the account web: pantry view and simulated fridge
data/recipes/<id>.json        recipes as data, one file each (see the contract below)
data/inventory.md             catalogue of every recipe found in the author's cookbooks
docs/RECIPE_SCHEMA.md         the recipe data contract: provenance, closed vocabularies, honesty flags
scripts/validate_recipes.py   deterministic validator (stdlib); nothing enters data/ without passing it
scripts/consolidate_recipes.py merges per-book extractions into data/ (dry-run unless --apply)
docs/PLAN.md                  the architecture and work plan (English; Spanish original in PLAN.es.md / .html)
docs/INTEGRATIONS_PLAN.md     IoT, barcode, Instacart and recipe-portal integration plan (block I; Spanish in PLAN_INTEGRACIONES.es.md)
docs/IMPORT_SOURCES.md        what each recipe portal actually gives us, and how to verify one
docs/ROBUSTNESS_REVIEW.md     the block I review: findings, fixes, negative controls, blind spots
scripts/import_jsonld.py      import a portal recipe from its JSON-LD into data/imports/ (staging)
data/imports/                 imported recipes awaiting a human's roles, techniques and ids
data/source_aliases.json      external food names -> canonical ingredient ids
test/                         node --test; run with `npm test`
Dockerfile                    one container for App Runner
```

## License

Apache-2.0. See `LICENSE`.
