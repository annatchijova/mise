# Recipe portals: what each one actually gives us

Cookpad, Allrecipes, ChefSteps, Taste of Home and Samsung Food have **no public write API for third
parties**. What they publish instead is `schema.org/Recipe` JSON-LD in the page — the same block
Google reads for rich results and every recipe app reads for "import from URL". So integrating with
a portal means parsing that block, in both directions:

- **out** — `GET /recipes/:id` serves each Mise recipe as a page whose JSON-LD is the payload
  (`src/recipe_jsonld.ts`). Any app that imports a URL can import ours.
- **in** — `scripts/import_jsonld.py` reads such a page into a staging file under `data/imports/`
  (`docs/RECIPE_SCHEMA.md`, "Imported recipes").

This file is the evidence log for the *in* direction. It is deliberately empty of claims we have not
checked: **a portal is listed as supported only after someone has run the importer against a real
page from it and pasted the result here.**

## Status

**No portal has been verified yet.** Outbound HTTPS to these sites is blocked from the environment
where the importer was written, so the parser was developed and tested against our own exported
pages (`test/roundtrip.test.ts`) and against the ingredient strings these sites are known to publish
(`test/ingredient_parsing.test.ts`). That is enough to trust the parsing rules; it is not enough to
claim a given site works. Filling in the table below is part of block I.0.

## How to verify one portal

Ten minutes per site. Do it from a machine with normal outbound access.

```bash
# 1. Fetch a real recipe page from the portal.
curl -sL -A 'Mozilla/5.0' 'https://<portal>/<some-recipe>' -o /tmp/page.html

# 2. Does it carry JSON-LD at all?
grep -c 'application/ld+json' /tmp/page.html

# 3. Import it and read what came through.
python3 scripts/import_jsonld.py /tmp/page.html --stdout | head -60

# 4. Check the staging file against the staging contract.
python3 scripts/import_jsonld.py /tmp/page.html -o data/imports
python3 scripts/validate_recipes.py --staging data/imports
```

Then fill in a row. Judge it on four things, because these are what break in practice:

| What to check | Why it matters |
|---|---|
| A `Recipe` node exists (possibly inside `@graph`) | No node, no import. Record it as "no JSON-LD" and stop — do not scrape the HTML instead. |
| `recipeIngredient` count matches the page | Some sites split ingredients across groups and publish only one group. |
| `recipeInstructions` shape | String, list of strings, `HowToStep`, or `HowToSection` with `itemListElement`. The importer handles all four; note which one the site uses. |
| Quantities that came through as `unspecified` | Ranges ("2-3 onions") and prose ("a handful") are refused on purpose. A high refusal rate is honest, not a bug — but note it, because it means more manual work per import. |

## Evidence

| Portal | Sample URL | JSON-LD? | Instructions shape | Ingredients read / total | Quantities stated | Checked by / when |
|---|---|---|---|---|---|---|
| Allrecipes | | | | | | |
| Cookpad | | | | | | |
| ChefSteps | | | | | | |
| Taste of Home | | | | | | |
| Samsung Food | | | | | | |

## The other direction: does Samsung Food import *our* pages?

Also block I.0, also ten minutes, and it is the one that matters most for the demo, because it is
the claim "Mise works with the smart-fridge ecosystem" reduced to something checkable:

1. Serve the recipes somewhere public (`BASE_URL=https://… npm start`, or any static host).
2. In the Samsung Food app, use "import recipe from URL" (or the equivalent) on `/recipes/<id>`.
3. Record here what survived: title, ingredient lines, steps, time, yield.

Expect the `mise:` provenance block to be ignored — that is by design, it is a namespaced extension
for other Mise instances. What must survive is the plain schema.org half.

## What we deliberately do not do

- **No HTML scraping.** If a page has no JSON-LD, it is recorded as unsupported. Scraping breaks
  silently and turns a data-quality problem into a maintenance problem.
- **No bulk import.** Each imported recipe needs a human to assign roles, techniques and canonical
  ingredient ids before it can enter `data/recipes/`. Importing a thousand recipes would produce a
  thousand unreviewed staging files and no working substitutions.
- **No import by voice.** `recipe_import` as an MCP tool would put an external fetch on the Alexa+
  response path, which has a 500 ms budget. Importing is an account-web action.
