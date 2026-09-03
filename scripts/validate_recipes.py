#!/usr/bin/env python3
"""Deterministic validator for the recipe data contract (docs/RECIPE_SCHEMA.md). Stdlib only.

Usage: validate_recipes.py <recipes.json | dir of *.json> [more...]
Exit 0 = all recipes valid. Exit 1 = hard errors (listed). Warnings never fail the run.
"""
import json, re, sys, os

CATEGORY = {"main","side","soup","breakfast","dessert","bread","sauce","preserve","drink","snack"}
ROLE = {"protein","fat","acid","binder","umami","aromatic","vegetable","fruit","grain","starch","sweetener","liquid","leavening","spice","herb","garnish","thickener"}
TECHNIQUE = {"emulsify","brown","bind-cold","bind-hot","leaven","thicken","ferment","marinate","simmer","fry","bake","raw","whip","sweeten","season","dissolve","none"}
UNIT = {"g","kg","ml","l","tsp","tbsp","cup","pc","clove","pinch","slice","bunch","can","sachet","to_taste"}
SOURCE = {"stated","estimated","unspecified"}
NON_VEGAN = re.compile(r"\b(honey|egg|eggs|milk|butter|cheese|cream|yogurt|whey|meat|beef|pork|chicken|fish|tuna|shrimp|gelatin|lard|"
                       r"miel|huevos?|leche|manteca|queso|crema|yogur|suero|carne|vaca|cerdo|pollo|pescado|at[uú]n|camar[oó]n|gelatina|grasa)\b")
# plant-based compounds are vegan even when they contain a dairy word: oat-milk, peanut-butter, coconut-cream, cashew-cheese
PLANT = re.compile(r"(oat|soy|soya|coconut|almond|cashew|rice|plant|peanut|cocoa|vegan|sunflower|hemp|pea|walnut|hazelnut|sesame|tahini|"
                   r"avena|soja|coco|almendra|casta[nñ]a|caj[uú]|anacardo|arroz|vegetal|vegan[oa]|man[ií]|cacao|girasol|nuez|s[eé]samo)")
def looks_non_vegan(token):
    return bool(NON_VEGAN.search(token)) and not PLANT.search(token)
KEBAB = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")

def load(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, list) else [data]

def check(r, errors, warnings, ids):
    tag = r.get("id", "<no id>")
    def err(m): errors.append(f"{tag}: {m}")
    def warn(m): warnings.append(f"{tag}: {m}")
    for k in ("id","title","title_es","source","category","diet","minutes","minutes_source","serves","serves_source","ingredients","steps","review"):
        if k not in r: err(f"missing field '{k}'")
    if errors and errors[-1].startswith(tag + ": missing"): return
    if not KEBAB.match(r["id"]): err("id is not kebab-case")
    if r["id"] in ids: err("duplicate id")
    ids.add(r["id"])
    if r["category"] not in CATEGORY: err(f"category '{r['category']}' not in vocabulary")
    src = r["source"]
    for k in ("book","locator","original_text"):
        if not src.get(k): err(f"source.{k} empty")
    if r["diet"].get("vegan") is not True: err("diet.vegan must be true")
    for k in ("minutes","serves"):
        if not isinstance(r[k], int) or r[k] <= 0: err(f"{k} must be a positive integer")
        if r[f"{k}_source"] not in SOURCE: err(f"{k}_source invalid")
    if not r["ingredients"]: err("no ingredients")
    for i, ing in enumerate(r["ingredients"]):
        p = f"ingredient[{i}]"
        if not KEBAB.match(ing.get("id","")): err(f"{p} id not kebab-case")
        if ing.get("role") not in ROLE: err(f"{p} role '{ing.get('role')}' not in vocabulary")
        if ing.get("technique") not in TECHNIQUE: err(f"{p} technique '{ing.get('technique')}' not in vocabulary")
        if ing.get("unit") not in UNIT: err(f"{p} unit '{ing.get('unit')}' not in vocabulary")
        if ing.get("qty_source") not in SOURCE: err(f"{p} qty_source invalid")
        q = ing.get("qty")
        if ing.get("qty_source") == "unspecified":
            if q is not None: err(f"{p} qty must be null when unspecified")
        else:
            if not isinstance(q, (int, float)) or isinstance(q, bool) or q <= 0: err(f"{p} qty must be a positive number when {ing.get('qty_source')}")
        if looks_non_vegan(ing.get("id","")): err(f"{p} looks non-vegan: {ing.get('id')}")
        # name_es is verbatim source text and must not be edited to satisfy the validator; the canonical
        # vegan judgment lives in the id. A dairy/meat word here is a review signal, not a rejection.
        elif looks_non_vegan((ing.get("name_es") or "").lower()): warn(f"{p} name_es mentions an animal word, confirm vegan: {ing.get('name_es')!r}")
        if not ing.get("name_es"): warn(f"{p} name_es missing")
    n = len(r["steps"])
    if n == 0: err("no steps")
    for i, st in enumerate(r["steps"], start=1):
        p = f"step[{i}]"
        if st.get("order") != i: err(f"{p} order must be {i}")
        for k in ("text","text_es"):
            if not st.get(k): err(f"{p} {k} empty")
        if not isinstance(st.get("dur_s"), int) or st["dur_s"] <= 0: err(f"{p} dur_s must be a positive integer")
        if st.get("dur_source") not in SOURCE: err(f"{p} dur_source invalid")
        if not isinstance(st.get("timer"), bool): err(f"{p} timer must be boolean")
        deps = st.get("depends_on", [])
        if any((not isinstance(d, int)) or d >= i or d < 1 for d in deps): err(f"{p} depends_on must reference earlier steps")
    rv = r["review"]
    est = (r["minutes_source"] != "stated" or r["serves_source"] != "stated"
           or any(x.get("qty_source") != "stated" for x in r["ingredients"])
           or any(s.get("dur_source") != "stated" for s in r["steps"]))
    if est and rv.get("needs_review") is not True: err("something is estimated/unspecified but review.needs_review is not true")
    if rv.get("needs_review") and not rv.get("reasons"): warn("needs_review without reasons")

def main(paths):
    files = []
    for p in paths:
        if os.path.isdir(p): files += sorted(os.path.join(p, f) for f in os.listdir(p) if f.endswith(".json") and f != "inventory.json")
        else: files.append(p)
    errors, warnings, ids, total = [], [], set(), 0
    for f in files:
        try: recs = load(f)
        except Exception as e:
            errors.append(f"{f}: invalid JSON ({e})"); continue
        for r in recs:
            total += 1; check(r, errors, warnings, ids)
    review = 0
    for f in files:
        try:
            for r in load(f):
                if r.get("review", {}).get("needs_review"): review += 1
        except Exception: pass
    print(f"recipes: {total}  valid: {total - len({e.split(':')[0] for e in errors})}  needs_review: {review}  errors: {len(errors)}  warnings: {len(warnings)}")
    for w in warnings: print("WARN ", w)
    for e in errors: print("ERROR", e)
    return 1 if errors else 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] or ["data/recipes"]))
