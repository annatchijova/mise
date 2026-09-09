#!/usr/bin/env python3
"""Deterministic validator for the recipe data contract (docs/RECIPE_SCHEMA.md). Stdlib only.

Usage: validate_recipes.py <recipes.json | dir of *.json> [more...]
       validate_recipes.py --staging data/imports

Exit 0 = all recipes valid. Exit 1 = hard errors (listed). Warnings never fail the run.

--staging checks the weaker contract that files in data/imports/ satisfy (see scripts/import_jsonld.py):
a recipe imported from a portal's JSON-LD has no role, no technique, no canonical ingredient id and
no established vegan status, because none of those can be read off a web page. The staging check
insists those fields are explicitly null rather than guessed, that the verbatim JSON-LD is present
and matches its hash, and that the file admits it needs review. Promotion to data/recipes/ means a
human filled the nulls in; the full contract applies there and nowhere else.
"""
import hashlib
import json, re, sys, os

CATEGORY = {"main","side","soup","breakfast","dessert","bread","sauce","preserve","drink","snack"}
ROLE = {"protein","fat","acid","binder","umami","aromatic","vegetable","fruit","grain","starch","sweetener","liquid","leavening","spice","herb","garnish","thickener"}
TECHNIQUE = {"emulsify","brown","bind-cold","bind-hot","leaven","thicken","ferment","marinate","simmer","fry","bake","raw","whip","sweeten","season","dissolve","none"}
UNIT = {"g","kg","ml","l","tsp","tbsp","cup","pc","clove","pinch","slice","bunch","can","sachet","to_taste","portion"}
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

def check_staging(r, errors, warnings, ids):
    """The imported-recipe contract. Weaker than the curated one, and strict about being honest
    that it is weaker: every field a machine cannot know must be null, not filled in."""
    tag = r.get("id", "<no id>")
    def err(m): errors.append(f"{tag}: {m}")
    def warn(m): warnings.append(f"{tag}: {m}")
    for k in ("id","title","title_es","source","category","diet","minutes","minutes_source",
              "serves","serves_source","ingredients","steps","review"):
        if k not in r: err(f"missing field '{k}'")
    if errors and errors[-1].startswith(tag + ": missing"): return
    if not KEBAB.match(r["id"]): err("id is not kebab-case")
    if r["id"] in ids: err("duplicate id")
    ids.add(r["id"])
    if not r["title"]: err("title empty")

    src = r["source"]
    if src.get("kind") != "imported": err("source.kind must be 'imported' in a staging file")
    if not src.get("url"): err("source.url empty")
    raw = src.get("jsonld")
    if not isinstance(raw, str) or not raw.strip():
        err("source.jsonld must be the verbatim JSON-LD block as text")
    else:
        digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        if digest != src.get("jsonld_sha256"):
            err("source.jsonld_sha256 does not match source.jsonld — the provenance was edited")
        try: json.loads(raw)
        except Exception as e: err(f"source.jsonld is not parseable JSON ({e})")

    # Judgment the import may not make for itself.
    if r["category"] is not None and r["category"] not in CATEGORY: err(f"category '{r['category']}' not in vocabulary")
    if r["diet"].get("vegan") is not None: err("diet.vegan must be null until a human establishes it")
    for k in ("minutes","serves"):
        v = r[k]
        if v is not None and (not isinstance(v, int) or v <= 0): err(f"{k} must be a positive integer or null")
        if r[f"{k}_source"] not in SOURCE: err(f"{k}_source invalid")
        if v is None and r[f"{k}_source"] != "unspecified": err(f"{k} is null but {k}_source says {r[f'{k}_source']}")

    if not r["ingredients"]: err("no ingredients")
    for i, ing in enumerate(r["ingredients"]):
        p = f"ingredient[{i}]"
        if not ing.get("raw"): err(f"{p} raw text missing — the source line must be kept verbatim")
        if ing.get("id") is not None and not KEBAB.match(ing["id"]): err(f"{p} id not kebab-case")
        if ing.get("role") is not None and ing["role"] not in ROLE: err(f"{p} role '{ing.get('role')}' not in vocabulary")
        if ing.get("technique") is not None and ing["technique"] not in TECHNIQUE: err(f"{p} technique not in vocabulary")
        if ing.get("unit") not in UNIT: err(f"{p} unit '{ing.get('unit')}' not in vocabulary")
        if ing.get("qty_source") not in SOURCE: err(f"{p} qty_source invalid")
        q = ing.get("qty")
        if ing.get("qty_source") == "unspecified":
            if q is not None: err(f"{p} qty must be null when unspecified")
        elif not isinstance(q, (int, float)) or isinstance(q, bool) or q <= 0:
            err(f"{p} qty must be a positive number when {ing.get('qty_source')}")
        if looks_non_vegan(ing.get("raw","").lower()): warn(f"{p} looks non-vegan, this recipe may not belong in the corpus: {ing.get('raw')!r}")

    if not r["steps"]: warn("no steps — the source page carried no instructions")
    for i, st in enumerate(r["steps"], start=1):
        p = f"step[{i}]"
        if st.get("order") != i: err(f"{p} order must be {i}")
        if not st.get("text"): err(f"{p} text empty")
        d = st.get("dur_s")
        if d is not None and (not isinstance(d, int) or d <= 0): err(f"{p} dur_s must be a positive integer or null")
        if st.get("dur_source") not in SOURCE: err(f"{p} dur_source invalid")
        if d is None and st.get("dur_source") != "unspecified": err(f"{p} dur_s is null but dur_source says {st.get('dur_source')}")

    rv = r["review"]
    if rv.get("needs_review") is not True: err("a staging file always needs review")
    if not rv.get("reasons"): err("needs_review without reasons")
    unresolved = [i for i in r["ingredients"] if i.get("role") is None or i.get("id") is None]
    if unresolved and not any("role and technique" in x or "ingredient ids" in x for x in rv.get("reasons", [])):
        warn("ingredients are unresolved but the review reasons do not say so")


def main(paths):
    staging = "--staging" in paths
    paths = [p for p in paths if p != "--staging"]
    if not paths: paths = ["data/imports"] if staging else ["data/recipes"]
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
            total += 1
            (check_staging if staging else check)(r, errors, warnings, ids)
    review = 0
    for f in files:
        try:
            for r in load(f):
                if r.get("review", {}).get("needs_review"): review += 1
        except Exception: pass
    label = "staging" if staging else "recipes"
    print(f"{label}: {total}  valid: {total - len({e.split(':')[0] for e in errors})}  needs_review: {review}  errors: {len(errors)}  warnings: {len(warnings)}")
    for w in warnings: print("WARN ", w)
    for e in errors: print("ERROR", e)
    return 1 if errors else 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
