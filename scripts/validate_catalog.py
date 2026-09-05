#!/usr/bin/env python3
"""Deterministic validator for the demo store's catalog (docs/STORE_SCHEMA.md). Stdlib only.

Usage: validate_catalog.py [data/catalog.json] [data/recipes] [data/substitutions.json]

Exit 0 = the catalog is valid. Exit 1 = hard errors (listed). Warnings never fail the run.

The catalog is the only source of prices the checkout consults, so the checks here are the ones that
would otherwise become a wrong charge: money that is not an integer number of cents, a SKU pointing
at an ingredient nothing cooks with, a pack size of zero, an allergen spelled in a way the
disclosure will not group. Coverage — which of the corpus's ingredients cannot be bought here — is a
warning, because a shop that does not stock everything is a shop, not a bug; the cart reports the
gap to the customer either way.
"""
import json, os, re, sys

UNIT = {"g","kg","ml","l","tsp","tbsp","cup","pc","clove","pinch","slice","bunch","can","sachet","to_taste","portion"}
ALLERGEN = {"gluten","soy","sesame","nuts","peanut","mustard","sulphites","celery"}
# Units a pack can be sold in. "to_taste" is not one of them, and neither is a pinch.
SELLABLE = {"g","kg","ml","l","pc","clove","bunch","can","sachet","slice"}
KEBAB = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
SKU_ID = re.compile(r"^sku-[a-z0-9]+(-[a-z0-9]+)*$")


def known_ingredients(recipes_dir, substitutions_path):
    ids = set()
    if os.path.isdir(recipes_dir):
        for name in sorted(os.listdir(recipes_dir)):
            if not name.endswith(".json"):
                continue
            with open(os.path.join(recipes_dir, name), encoding="utf-8") as f:
                data = json.load(f)
            for r in (data if isinstance(data, list) else [data]):
                if isinstance(r, dict) and isinstance(r.get("ingredients"), list):
                    for ing in r["ingredients"]:
                        if isinstance(ing.get("id"), str):
                            ids.add(ing["id"])
    if os.path.exists(substitutions_path):
        with open(substitutions_path, encoding="utf-8") as f:
            table = json.load(f)
        ids |= set(table.get("extra_ingredients", {}))
        for e in table.get("entries", []):
            if e.get("ingredient"):
                ids.add(e["ingredient"])
            for a in e.get("alternatives", []):
                if a.get("ingredient"):
                    ids.add(a["ingredient"])
    return ids


def positive_int(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def main(argv):
    catalog_path = argv[0] if len(argv) > 0 else "data/catalog.json"
    recipes_dir = argv[1] if len(argv) > 1 else "data/recipes"
    subs_path = argv[2] if len(argv) > 2 else "data/substitutions.json"
    errors, warnings = [], []

    try:
        with open(catalog_path, encoding="utf-8") as f:
            catalog = json.load(f)
    except Exception as e:
        print(f"ERROR {catalog_path}: invalid JSON ({e})")
        return 1

    for k in ("version", "updated_on", "currency", "store", "skus"):
        if k not in catalog:
            errors.append(f"missing top-level field '{k}'")
    if errors:
        for e in errors: print("ERROR", e)
        return 1

    store = catalog["store"]
    for k in ("name", "merchant_of_record", "refund_policy_url", "tax_rate_bps", "shipping_cents", "free_shipping_over_cents"):
        if k not in store:
            errors.append(f"store: missing '{k}'")
    if isinstance(store.get("tax_rate_bps"), int):
        if not 0 <= store["tax_rate_bps"] <= 10_000:
            errors.append("store.tax_rate_bps must be between 0 and 10000 basis points")
    else:
        errors.append("store.tax_rate_bps must be an integer number of basis points, not a percentage as a float")
    for k in ("shipping_cents", "free_shipping_over_cents"):
        v = store.get(k)
        if not isinstance(v, int) or isinstance(v, bool) or v < 0:
            errors.append(f"store.{k} must be a non-negative integer number of cents")

    known = known_ingredients(recipes_dir, subs_path)
    seen_ids, stocked = set(), set()
    for n, sku in enumerate(catalog["skus"]):
        tag = sku.get("id", f"skus[{n}]")
        for k in ("id", "title", "ingredient_id", "pack", "price_cents", "stock", "allergens"):
            if k not in sku:
                errors.append(f"{tag}: missing '{k}'")
        if any(k not in sku for k in ("id", "title", "ingredient_id", "pack", "price_cents", "stock", "allergens")):
            continue
        if not SKU_ID.match(sku["id"]):
            errors.append(f"{tag}: id must look like sku-<kebab-case>")
        if sku["id"] in seen_ids:
            errors.append(f"{tag}: duplicate SKU id")
        seen_ids.add(sku["id"])
        if not sku["title"].strip():
            errors.append(f"{tag}: empty title")
        if not KEBAB.match(sku["ingredient_id"]):
            errors.append(f"{tag}: ingredient_id is not kebab-case")
        elif sku["ingredient_id"] not in known:
            errors.append(f"{tag}: ingredient '{sku['ingredient_id']}' appears in no recipe and in no substitution row")
        stocked.add(sku["ingredient_id"])

        pack = sku["pack"]
        if not isinstance(pack, dict) or "qty" not in pack or "unit" not in pack:
            errors.append(f"{tag}: pack must be {{qty, unit}}")
        else:
            if not isinstance(pack["qty"], (int, float)) or isinstance(pack["qty"], bool) or pack["qty"] <= 0:
                errors.append(f"{tag}: pack.qty must be a positive number")
            if pack["unit"] not in UNIT:
                errors.append(f"{tag}: pack.unit '{pack['unit']}' is not a unit the ledger keeps")
            elif pack["unit"] not in SELLABLE:
                errors.append(f"{tag}: pack.unit '{pack['unit']}' is not something a shop can sell by")

        if not positive_int(sku["price_cents"]):
            errors.append(f"{tag}: price_cents must be a positive integer — money is never a float here")
        if not isinstance(sku["stock"], int) or isinstance(sku["stock"], bool) or sku["stock"] < 0:
            errors.append(f"{tag}: stock must be a non-negative integer")
        if not isinstance(sku["allergens"], list):
            errors.append(f"{tag}: allergens must be a list (empty when there are none)")
        else:
            for a in sku["allergens"]:
                if a not in ALLERGEN:
                    errors.append(f"{tag}: allergen '{a}' is not in the vocabulary; the disclosure groups on exact names")
            if len(set(sku["allergens"])) != len(sku["allergens"]):
                errors.append(f"{tag}: an allergen is listed twice")

    corpus = known_ingredients(recipes_dir, "/nonexistent")
    uncovered = sorted(corpus - stocked)
    for i in uncovered:
        warnings.append(f"no SKU for {i} — the cart will report it as something the shop does not stock")

    covered = len(corpus) - len(uncovered)
    pct = 0 if not corpus else (covered * 100) // len(corpus)
    print(f"catalog: {len(catalog['skus'])} SKUs  recipe ingredients stocked: {covered}/{len(corpus)} ({pct}%)  "
          f"errors: {len(errors)}  warnings: {len(warnings)}")
    for w in warnings: print("WARN ", w)
    for e in errors: print("ERROR", e)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
