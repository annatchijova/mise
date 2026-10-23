# MISE — Even a Chef Runs Out of Ideas

**A cooking companion for Alexa+, built by a professional chef who believes that creativity and reliability belong together.**

## The story: Even a chef runs out of ideas

I'm a professional vegan chef.

I've spent years working with ingredients, techniques, timing, food safety, and the peculiar kind of creativity that comes from looking at what is available and imagining what it could become.

And sometimes, even I open the refrigerator and have absolutely no idea what to cook.

Not because there's nothing to eat. Sometimes there are plenty of ingredients, but no obvious way to bring them together. Sometimes something needs to be used before it goes bad. Sometimes you're tired, short on time, or simply out of inspiration.

Professional kitchens taught me that cooking isn't just following recipes. It's managing resources, understanding ingredients, coordinating processes, adapting to constraints, and making decisions under pressure.

Most importantly, it's knowing when **not** to improvise.

That's where MISE began.

I wanted to build something that could help people discover possibilities in the food they already have, learn something while cooking, and make better use of their ingredients.

But I didn't want another AI that confidently invents substitutions, guesses quantities, or presents incomplete nutritional information as fact.

**I wanted culinary creativity without fabricated certainty.**

## Meet MISE

MISE is an open-source cooking and pantry companion designed for the Alexa+ ecosystem.

Imagine coming home, opening your refrigerator, and asking:

*“What can I cook this week with what I already have?”*

MISE can help plan meals around your pantry, prioritize ingredients approaching their use-by dates, and explain why a particular recipe was selected.

Then imagine starting dinner and realizing you're missing an ingredient.

MISE looks for a chef-curated substitution appropriate to that ingredient's role and cooking technique. When one exists, it can explain the ratio, limitations, and warnings.

And when it doesn't have a supported substitution?

**It says so.**

That refusal is intentional. In a kitchen, a plausible answer isn't necessarily a useful one.

### What MISE does

**A pantry that remembers.** MISE maintains an event history of ingredients added, consumed, corrected, or removed. It distinguishes information confirmed by a person from inferred or stale information.

**Meal planning that explains itself.** Its deterministic weekly planner considers available ingredients, time constraints, spending limits, leftovers, and ingredients that need attention. It explains its choices and produces a reproducible plan hash.

**Plans that can explain changes.** When the pantry or constraints change, MISE can compare plans and identify what changed and why.

**Cooking guidance that follows the process.** Cooking sessions maintain ordered steps, dependencies, timers, notes, and resumable state. MISE can also coordinate two cooks when the recipe's dependency structure permits independent work.

**Substitutions grounded in culinary knowledge.** Ingredient substitutions come from curated tables organized by ingredient, role, and technique. Unsupported substitutions remain unsupported rather than becoming invented recommendations.

**Nutrition without false precision.** MISE distinguishes complete nutritional calculations from partial lower bounds. Missing quantities and missing data remain visible.

**Zero-waste cooking suggestions.** MISE searches its curated recipe corpus for ways to use ingredients approaching their dates and provides relevant technique lessons. It does not claim measured savings or environmental benefits that have not been demonstrated.

**Shopping with explicit confirmation.** MISE can identify missing ingredients, prepare a demonstration grocery cart, and calculate totals. Checkout requires explicit confirmation.

**Knowledge that grows through review.** Observed substitutions can enter a human curation queue, but they do not automatically become trusted advice.

MISE also supports pantry information from manual reports, simulated refrigerator events, and receipt text. These sources have different evidentiary value: a receipt may indicate a purchase, but it does not prove that the item is still in the kitchen.

That distinction matters.

## How it works: The model talks. The system decides.

MISE uses a deterministic MCP server built with TypeScript, Node.js 22, and the official `@modelcontextprotocol/sdk`, communicating through Streamable HTTP.

Alexa+ is the intended conversational interface: it interprets requests, selects tools, and communicates results.

The MISE server owns the consequential decisions.

It validates inputs, maintains pantry state, executes meal planning, controls cooking transitions, performs curated substitutions and nutritional lookups, and calculates shopping totals.

There is no additional language model inside the server's decision engine.

This is not an incidental implementation detail. It is a deliberate trust boundary.

A conversational model can help someone express what they need. It should not silently invent an ingredient quantity, alter a checkout total, or fabricate a food-safety recommendation.

The system therefore enforces several principles:

- Unknown quantities remain unknown.
- Pantry corrections are recorded as events instead of silently rewriting history.
- Estimated shelf life remains distinct from dates supplied by a person.
- Ingredient matching uses curated aliases rather than uncontrolled fuzzy matching.
- Substitutions and cooking advice come from curated data.
- Money is calculated using integer cents and basis points.
- Planning uses fixed scoring, ordering, and tie-breaking rules.
- The plan hash makes the documented planning output reproducible under the relevant inputs; it does not prove culinary correctness.
- Checkout requires explicit confirmation.
- Unsupported requests return explicit gaps rather than plausible inventions.

MISE also publishes versioned culinary data with provenance and caveats, allowing others to inspect and reuse the underlying knowledge.

### Technical implementation

The project includes:

- 19 MCP tools covering recipes, pantry management, planning, cooking, substitutions, nutrition, zero-waste suggestions, and shopping.
- Four MCP Apps views for pantry information, weekly planning, cooking steps, and checkout.
- Ten project-specific Agent Skills guiding conversational tool use without transferring decision authority to the model.
- Versioned JSON recipe and culinary knowledge tables.
- An event-based pantry model with explicit confidence states.
- A deterministic meal planner with explainable results and reproducible hashes.
- A cooking state machine with ordered dependencies and resumable sessions.
- Curated ingredient substitution, scaling, shelf-life, and nutrition rules.
- Automated regression tests and data validators.
- A local conversational simulator connected to the actual MCP server.

The server exposes a real MCP endpoint using Streamable HTTP. Its integration has been verified with an actual MCP client, including tool discovery, tool calls, account-gated behavior, resource access, and the four interactive MCP Apps views.

The local simulator uses Gemini to play the conversational host role. It makes real MCP calls and renders live server-provided structured content through the MCP Apps bridge.

This demonstrates the MCP integration, not a completed deployment inside Amazon's hosted Alexa+ environment.

**Source code:** https://github.com/annatchijova/mise

**Project presentation:** https://annatchijova.github.io/mise/

**Technical README:** https://github.com/annatchijova/mise/blob/main/README_TECHNICAL.md

**Demonstration instructions:** https://github.com/annatchijova/mise/blob/main/docs/DEMO_SCRIPT.md

**Video:** TODO — replace with the final video's public URL once it is recorded and uploaded.

### Built with

TypeScript · Node.js 22 · `@modelcontextprotocol/sdk` (Streamable HTTP) · `@modelcontextprotocol/ext-apps`
(MCP Apps) · Zod · esbuild · Python 3 (data validators) · Google Gemini API (`gemini-flash-lite-latest`,
powering the local conversational simulator) · vanilla HTML/CSS/JS (the four MCP Apps views and the
simulator's UI) · GitHub Pages

## Product feedback

### `@modelcontextprotocol/sdk`

**Used for:** the entire MCP tool surface — all 19 tools, the Streamable HTTP server, and the client
side of `scripts/verify_mcp_roundtrip.mjs` and the local simulator.

**Worked well:** the stateless Streamable HTTP pattern is genuinely simple to get right — one
`McpServer` and one `StreamableHTTPServerTransport` per POST request, with
`sessionIdGenerator: undefined` and no session state to manage (`src/server.ts`). Registering 19
tools with typed Zod schemas and getting real input validation for free was the main thing that made
a server this size tractable to keep correct. Tool metadata (`_meta.ui.resourceUri`, used for the MCP
Apps hint) composed cleanly with the rest of a tool's registration — nothing felt bolted on.

**Needs work:** `npm audit` caught a high-severity vulnerability in the pinned SDK version this
project started on; fixed by updating to 1.32.1. Not a design flaw, but worth saying: a project
building against a fast-moving SDK should audit on a schedule, not once at the start.

**Onboarding:** straightforward for a server built from the SDK's own types — `Implementation`,
`CallToolResult`, and the Streamable HTTP transport classes are self-explanatory enough that the
official docs were rarely needed once the first tool was registered.

**Would build with it again:** yes — the architecture this project argues for (decisions made before
the model ever sees them) depended on the SDK getting out of the way, and it did.

### `@modelcontextprotocol/ext-apps` (MCP Apps)

**Used for:** the four interactive views (pantry card, weekly grid, step card with timer, checkout),
and, in the local simulator, the host side of the same protocol — a real `AppBridge`, not a
hand-rolled postMessage guess, so the simulator exercises the exact handshake a production host would.

**Worked well:** having both halves of the protocol as real library code (the view's `App` class and
the host's `AppBridge`) rather than a one-sided SDK meant the one part that genuinely can't be
checked by reading code — the handshake — could still be checked, by running the real counterpart
against it. `_meta.ui.resourceUri` on a tool's own registration, rather than on each call's result, is
a sensible design: a host can know ahead of time which tools have a view instead of inspecting every
response.

**Needs work (a real bug, not a complaint):** the view's `App.connect()` sends its first
`ui/initialize` message the instant its inline script runs, during iframe document parsing — well
before an iframe `"load"` event ever fires. A host that attaches its message listener after `onload`
(a natural-looking place to put it) silently loses that first message: the view sits there with no
data and no error, which is a hard failure mode to diagnose from the outside. The fix was to attach
the host's `PostMessageTransport` listener before assigning the iframe's `srcdoc`, not after — this
cost real debugging time and would be a good addition to the lifecycle documentation or the reference
host example.

Separately, each view's bundled runtime is a measured 301 KB minified (`npm run build:ui`), close to
the ~300 KB this project had estimated before measuring it precisely. Not a defect — a known,
accepted cost of shipping the real protocol inline into a sandboxed iframe with no network of its
own — but worth knowing up front rather than discovering per view.

**Onboarding:** good once the initialization-timing behavior above was understood; the two-sided
design (app + bridge) is the main reason it was possible to debug at all, since both sides could be
inspected instead of guessing at an opaque host's behavior.

**Would build with it again:** yes.

## What we verified — and what we did not

MISE is a working hackathon implementation with documented tests, data validation, and real MCP protocol interactions.

Its MCP server has been exercised through the official MCP SDK client over Streamable HTTP. The local conversational simulator also renders real MCP Apps resources with live structured content.

However, the hosted Alexa+ Web Simulator and Alexa+ Preview partner tools were not available for end-to-end verification in the development environment.

That means Alexa+'s own language understanding, hosted interface behavior, and account-linking flow remain unverified.

The refrigerator integration is simulated, not connected to a physical appliance. The checkout implementation is a demonstration rather than a verified production commerce integration. The current stores have in-memory persistence limitations, and production AWS deployment and multi-user authentication remain open.

These are documented boundaries, not hidden assumptions.

**A verified MCP integration is evidence of an MCP integration. It is not evidence of a production deployment that has never been tested.**

The detailed verification ledger is available here:

https://github.com/annatchijova/mise/blob/main/docs/BLOCKED.md

## Open Source mini-challenge: Contributing to the tools we depend on

Building MISE also led me to contribute to the open-source ecosystem it uses.

**Pull request:** https://github.com/modelcontextprotocol/ext-apps/pull/807

**Repository:** https://github.com/modelcontextprotocol/ext-apps (the PR target; the fork it was
opened from is https://github.com/annatchijova/ext-apps, branch `fix/quickstart-host-qualified-tool-names`
— CHECK which one the Devpost field actually asks for before pasting)

**GitHub username:** annatchijova

While examining `@modelcontextprotocol/ext-apps`, one of MISE's direct dependencies, I investigated a problem in its quickstart example.

The example's `callServerTool` invocation hardcoded the tool name `get-time`.

That works when a host exposes the tool under its original name. But hosts that aggregate multiple MCP servers may qualify tool names, producing identifiers such as `pdf-server-get-time`.

In those environments, an interface can render successfully while subsequent tool calls fail because the hardcoded name cannot be resolved.

The correction retrieves the host-qualified tool name through `getHostContext().toolInfo` instead of assuming a fixed identifier.

The underlying issue and solution pattern had already been identified by contributor `@jcollas` in issue #753 for another example. My PR applies that pattern to the quickstart example and explicitly credits the earlier diagnosis.

I chose the quickstart because it is an important entry point for developers learning to build MCP Apps.

Before opening the contribution, I checked for overlapping PRs, worked from a fresh clone, and ran TypeScript validation, the example build, and formatting checks.

This contribution was made separately from MISE for the **Open Source mini-challenge**.

It also reflects something I value in engineering: when you discover a problem in a dependency, improving the shared tool can be more useful than building a private workaround.

## AWS Builder mini-challenge: A deliberate decision not to participate

I also evaluated the AWS Builder mini-challenge.

The published qualifying services included Amazon Bedrock, AgentCore, Strands SDK, Kiro Crew, and SageMaker.

MISE does not use those services.

Its architecture deliberately keeps consequential decisions outside language models. Adding a Bedrock call solely to qualify for an additional prize would introduce a dependency without a genuine responsibility.

I decided not to do that.

Not every additional challenge is worth pursuing if it contradicts the system's design.

## Developer experience: The friction behind the build

Building for an emerging conversational ecosystem involves more than implementing an API. It also means finding out which development paths are actually accessible, how protocols behave in real clients, and where documentation leaves important questions unanswered.

The following observations come from the project's documented development and verification work.

### 1. Alexa+ developer access and regional availability

**Task:** Determine whether the Alexa+ Web Simulator and developer tooling could be used from Argentina.

**Expected:** Clear information about supported regions, account prerequisites, and the path from local development to hosted testing.

**Observed:** Regional and access requirements were initially unclear. Subsequent investigation identified limitations involving Alexa+ Preview access and the AWS-side trust flow. The hosted Alexa+ environment could not be verified.

**Impact:** High. It affected the demonstration strategy and prevented end-to-end claims about Amazon's hosted client.

**Workaround:** Verify the actual MCP server using the official MCP client and implement a local conversational host capable of exercising real tool calls and MCP Apps resources.

**Suggested improvement:** Publish an explicit developer-access matrix covering general availability, preview or partner restrictions, supported regions, and recommended alternatives for hackathon participants.

### 2. MCP Apps initialization timing

**Task:** Connect interactive MCP Apps views to a host and render live data.

**Expected:** The embedded app connects and receives its initial host data.

**Observed:** The app could send its first connection message while the iframe was still parsing, before the iframe `load` event fired. Attaching the host message listener only after `onload` caused that message to be missed, leaving the view without data or an obvious error.

**Impact:** The interface could appear to load while the host connection had silently failed.

**Workaround:** Attach the host's message listener before assigning the iframe's `srcdoc`.

**Suggested improvement:** Provide clearer lifecycle documentation and reference implementations for host initialization and connection timing.

### 3. MCP Apps runtime size

Each of MISE's four views bundles the MCP Apps runtime, adding approximately 300 KB per view in the documented implementation.

This is a known implementation cost, not a demonstrated SDK defect.

A shared runtime could reduce duplication if real client measurements justify the change. I prioritized verified functionality over optimizing an unmeasured bottleneck.

### 4. Long-running cooking and reminders

Some culinary processes take hours or days.

MISE can record when a preparation needs checking, but an MCP server cannot independently wake up Alexa+ and create a reminder simply because its internal state contains a due time.

The implementation therefore distinguishes between:

*“The next check is due in approximately 24 hours.”*

and:

*“I'll remind you in 24 hours.”*

MISE does not make the second promise without a verified reminder integration.

This is a practical limitation, but also an example of the project's central principle: knowing that something should happen is not the same as having the authority or capability to make it happen.

## What building MISE taught me

Cooking and software engineering might seem like different disciplines.

To me, they share more than people expect.

In a professional kitchen, everything depends on everything else. Timing matters. Ingredients have roles. A substitution can change the structure of a dish. A process must be coordinated. A measurement is different from an estimate. And a small mistake can have consequences beyond the plate.

Building MISE meant translating some of that knowledge into explicit rules, data contracts, state transitions, tests, and interfaces.

It also meant accepting that a useful system must sometimes say:

*“I don't know.”*

I don't want technology to replace the person cooking.

I want it to help people understand ingredients, discover combinations, make use of what they have, and develop confidence in their own decisions.

A good cooking companion shouldn't take away the pleasure of figuring something out.

It should make that pleasure more accessible.

**MISE — The food you already have can become something wonderful.**
