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

Hackathon scaffold — **block A of the plan** (`docs/PLAN.es.md`): repository, TypeScript MCP server with a single `recipe_search` tool over in-memory recipe data, Dockerfile. Not yet validated against Alexa+ end to end; the first milestone is a round trip in the Web Simulator.

Recipes, substitutions and the store catalog live as **data** (`data/`), not code.

## Run locally

```bash
npm install
npm run build
npm start          # MCP server on http://localhost:8080/mcp
curl localhost:8080/healthz
```

## Layout

```
src/server.ts      MCP server (Streamable HTTP) and tools
data/recipes.json  recipes as data: steps with durations, ingredients with role
docs/PLAN.es.md    the architecture and work plan (author's planning document, Spanish)
docs/PLAN.es.html  same plan, original formatted version
Dockerfile         one container for App Runner
```

## License

Apache-2.0. See `LICENSE`.
