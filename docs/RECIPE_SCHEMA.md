# Recipe data contract

Recipes are **data, not code**. This document is the contract every structured recipe must satisfy; `scripts/validate_recipes.py` enforces it deterministically (stdlib only). Anything that fails validation does not enter `data/`.

Guiding rule (the project's root principle): **a value must never look more certain than its source.** Every number carries a `*_source` flag. Nothing is invented silently.

## Files

- `work/recipes/<book>/inventory.json` — every recipe found in the book (structured or not).
- `work/recipes/<book>/recipes.json` — the structured recipes selected from that book.
- Final curated set: `data/recipes/<id>.json` (one file per recipe) + `data/inventory.md` (full catalogue).

Book slugs: `vegan-delicious`, `solidario-50`, `abc-vegan-ideas`, `recetario-diferente`, `aplv`.

## inventory.json

```json
[
  { "title_es": "Ñoquis veganos", "category": "main", "vegan": "yes",
    "structurable": true, "selected": true, "reason": "clear ingredient list and method; shares potato/onion with others" }
]
```
- `vegan`: `"yes" | "no" | "unsure"` — when unsure, say why in `reason`. Non-vegan is never selected.
- `structurable`: has an ingredient list and a method (not a one-line prose note).

## recipes.json — one object per recipe

```json
{
  "id": "vegan-gnocchi",
  "title": "Vegan gnocchi",
  "title_es": "Ñoquis veganos",
  "source": {
    "book": "vegan-delicious",
    "locator": "section 'Escabechados y fermentos', after 'Chucrut'",
    "original_text": "Ñoquis veganos\n2 tazas de harina 0000\n..."
  },
  "category": "main",
  "diet": { "vegan": true, "gluten_free": false, "notes": [] },
  "minutes": 40,  "minutes_source": "estimated",
  "serves": 4,    "serves_source": "unspecified",
  "ingredients": [
    { "id": "flour-0000", "name_es": "harina 0000", "role": "starch", "technique": "bind-cold",
      "qty": 2, "unit": "cup", "qty_source": "stated", "note": null }
  ],
  "steps": [
    { "order": 1, "text": "Mix the ingredients into a workable dough; add water if needed.",
      "text_es": "Mezclar los ingredientes hasta obtener una masa manipulable e incorporar agua si hace falta.",
      "dur_s": 600, "dur_source": "estimated", "timer": false, "depends_on": [] }
  ],
  "tags": ["quick"],
  "review": { "needs_review": true, "reasons": ["serves unspecified", "all step durations estimated"] }
}
```

### Rules

- `id`: kebab-case English, unique across all books.
- `title`: English (the add-on locale is en-US). `title_es`: the book's title verbatim.
- `source.original_text`: the recipe **verbatim** from the book (provenance; translation drift stays auditable). Never paraphrase it.
- `text` (English) is a faithful translation of `text_es` (verbatim). Do not embellish, do not add steps the book does not have. You may **split** one long paragraph into ordered steps — that is structuring, not invention.
- Quantities: if the book gives none, `qty: null`, `qty_source: "unspecified"`, and put the book's wording in `note` ("a gusto", "cantidad necesaria"). **Never invent a quantity.**
- Durations: books rarely state them. `dur_source: "stated"` only when the text says so ("20 minutos"); otherwise `"estimated"`. Same for `minutes` and `serves`.
- `timer: true` when a step is a wait or a timed cook (simmer 20 min, rest 1 h, bake).
- `depends_on`: earlier step numbers this step needs finished (parallel prep has none).
- `review.needs_review` is `true` whenever anything is estimated/unspecified or the vegan status needed judgment. List the reasons. Honesty here is the feature.
- Non-vegan ingredients (honey, egg, dairy, meat, fish, gelatin) disqualify the recipe. Plant compounds that contain a dairy word are fine and should use their canonical id (`oat-milk`, `soy-milk`, `coconut-cream`, `peanut-butter`, `cashew-cheese`); the validator recognizes the plant qualifier. The hard check is on the `id`; an animal word inside a verbatim `name_es` (e.g. the book's vegan `caldo "carne"`) only raises a review warning, because source text is never edited to satisfy a check. When the book offers a vegan variant, structure the vegan variant and say so in `diet.notes`.

### Closed vocabularies (validator-enforced)

**category**: `main | side | soup | breakfast | dessert | bread | sauce | preserve | drink | snack`

**role** (what the ingredient *is* in the dish): `protein | fat | acid | binder | umami | aromatic | vegetable | fruit | grain | starch | sweetener | liquid | leavening | spice | herb | garnish | thickener`

**technique** (what the ingredient must *do* — this is what makes substitution safe): `emulsify | brown | bind-cold | bind-hot | leaven | thicken | ferment | marinate | simmer | fry | bake | raw | whip | sweeten | season | dissolve | none`

**unit**: `g | kg | ml | l | tsp | tbsp | cup | pc | clove | pinch | slice | bunch | can | sachet | to_taste`

Argentine → unit map: `taza→cup`, `cda/cucharada→tbsp`, `cdta/cucharadita→tsp`, `gr→g`, `cc→ml`, `sobre→sachet`, `pizca→pinch`, `diente→clove`, `a gusto / cantidad necesaria→to_taste (qty null)`, `unidad/u→pc`.

**Ingredient ids**: kebab-case English, canonical across books (`onion`, `garlic`, `red-lentil`, `chickpea`, `tofu`, `flour-0000`, `olive-oil`, `soy-sauce`, `tahini`, `nutritional-yeast`, `aquafaba`, `coconut-milk`, `oat-milk`, `cornstarch`, `baking-powder`, `yeast`, `sugar`, `salt`, `lemon`, `tomato`, `potato`, `carrot`, `bell-pepper`, `spinach`, `rice`, `pasta`, `bread-crumbs`, `walnut`, `cashew`, `peanut`, `chia`, `flax`, `oats`, `banana`, `apple`, `orange`, `cocoa`, `vanilla`, `cinnamon`, `cumin`, `paprika`, `oregano`, `parsley`, `basil`, `mustard`, `vinegar`, `water`). Add new ids freely when needed; keep them generic (the *thing*, not the brand) and reuse across recipes.

### Selection criteria (about 10 per book, about 50 total)

1. Vegan, no exceptions.
2. Structurable (ingredient list + method).
3. About 70% savory meals the weekly planner can schedule (mains, sides, soups); about 30% breads, desserts, preserves, sauces for variety.
4. Favor recipes that **share ingredients** with each other (the planner needs overlap) and that **exercise substitutions** (binders, emulsifiers, fats, umami).
5. Spread of cooking times: quick (< 30 min), medium, long.
6. Keep the author's voice: `text_es` and `original_text` verbatim.

## Imported recipes (staging)

Recipes from the author's cookbooks are the corpus. Recipes imported from a portal's
`schema.org/Recipe` JSON-LD (`scripts/import_jsonld.py`) land in `data/imports/` and satisfy a
**weaker contract**, checked by `validate_recipes.py --staging`. The server does not load them.

The weakening is the point: a web page cannot carry the judgment this schema is built on, so the
import is required to say so in the data rather than fill the gaps.

| Field | In a staging file | Why |
|---|---|---|
| `ingredients[].role`, `.technique` | `null` | What an ingredient must *do* is the chef's call, and the basis of every substitution. Nothing in JSON-LD implies it. |
| `ingredients[].id` | `null` | Mapping "all-purpose flour" to `flour-0000` is a decision about the corpus, not a string transformation. |
| `ingredients[].raw` | required | The source line verbatim, so the mapping stays auditable. |
| `diet.vegan` | `null` | The corpus is vegan by construction; an import may not inherit that claim. |
| `category` | `null` or in the vocabulary | Closed vocabulary, so a human picks. |
| `minutes`, `serves` | integer or `null` | `null` whenever the page stated none, with `*_source: unspecified`. |
| `steps[].dur_s` | `null` unless stated | Step timings are almost never published. |
| `source.kind` | `"imported"` | Alongside `url`, `site`, `author`, `fetched_at`. |
| `source.jsonld` | the block verbatim, as text | Same discipline as `source.original_text` for books. |
| `source.jsonld_sha256` | must match `source.jsonld` | The validator recomputes it; edited provenance is an error, not a warning. |
| `review.needs_review` | always `true` | A staging file is unreviewed by definition. |

Quantities are parsed only when the text plainly states one. A range ("2-3 onions"), prose ("a
handful"), or no number at all yields `qty: null`, `qty_source: "unspecified"`, and the site's own
wording kept in `note` — the same rule the cookbooks get, applied to a different kind of source.

**Promotion** means a human assigns the nulls, adds `title_es` and the verbatim source, and moves the
file to `data/recipes/`, where the full contract above applies. There is no automatic promotion.
