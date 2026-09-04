# Staging area for imported recipes

Files here were produced by `scripts/import_jsonld.py` from a portal's `schema.org/Recipe` JSON-LD.
They are **not recipes yet**, and the server does not load them.

An imported file has `role`, `technique`, `ingredients[].id` and `diet.vegan` set to `null`, because
none of those can be read off a web page: they are the chef's judgment, and they are exactly what
makes substitution safe. A human fills them in, confirms the recipe is vegan, writes `title_es` and
the verbatim `source`, and only then does the file move to `data/recipes/`.

    python3 scripts/validate_recipes.py --staging data/imports    # the weaker staging contract
    python3 scripts/validate_recipes.py data/recipes              # the full contract, after promotion

See `docs/RECIPE_SCHEMA.md` ("Imported recipes") and `docs/IMPORT_SOURCES.md`.
