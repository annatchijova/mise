#!/usr/bin/env python3
"""Import a recipe from a schema.org/Recipe JSON-LD page into a staging file. Stdlib only.

Cookpad, Allrecipes, ChefSteps, Taste of Home and Samsung Food have no public write API for third
parties. What they all do have is JSON-LD in the page, which is the same thing every recipe app
already reads. So importing a recipe is parsing that block, not calling an API.

    scripts/import_jsonld.py page.html                 # a saved page
    scripts/import_jsonld.py --url https://…/recipe    # fetch it (network permitting)
    scripts/import_jsonld.py page.html --id my-slug -o data/imports

The output goes to data/imports/<id>.json, NEVER to data/recipes/. A staging file is not a recipe:

  * role and technique are null. They are the chef's judgment about what an ingredient must *do*,
    which is the whole basis of safe substitution, and nothing in a JSON-LD block implies them.
  * ingredient id is null. Mapping "all-purpose flour" to `flour-0000` is a decision about the
    corpus, not a string transformation.
  * vegan is null. Our corpus is vegan by construction; an import may not inherit that claim.
  * a quantity is parsed only when the text plainly states one. Anything else keeps the site's own
    wording and stays unspecified.

`scripts/validate_recipes.py --staging` checks this weaker contract. A human fills in the nulls, and
only then does the file move to data/recipes/ where the full contract applies.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import unicodedata
from html.parser import HTMLParser

# --- extracting the JSON-LD block ------------------------------------------------------------

class LdExtractor(HTMLParser):
    """Collect the contents of every <script type="application/ld+json">."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks = []
        self._grab = False

    def handle_starttag(self, tag, attrs):
        if tag == "script":
            a = dict(attrs)
            self._grab = (a.get("type") or "").strip().lower() == "application/ld+json"

    def handle_endtag(self, tag):
        if tag == "script":
            self._grab = False

    def handle_data(self, data):
        if self._grab and data.strip():
            self.blocks.append(data)


def iter_nodes(doc):
    """Walk a JSON-LD document: bare object, array, or @graph."""
    stack = [doc]
    while stack:
        node = stack.pop()
        if isinstance(node, list):
            stack.extend(node)
        elif isinstance(node, dict):
            yield node
            if "@graph" in node:
                stack.append(node["@graph"])


def is_recipe(node):
    t = node.get("@type")
    types = t if isinstance(t, list) else [t]
    return any(isinstance(x, str) and x.rsplit("/", 1)[-1].lower() == "recipe" for x in types)


def find_recipe(text):
    """The first Recipe node in the document. Returns (node, raw_block) or (None, None)."""
    parser = LdExtractor()
    stripped = text.lstrip()
    blocks = [text] if stripped.startswith(("{", "[")) else None
    if blocks is None:
        parser.feed(text)
        blocks = parser.blocks
    for block in blocks:
        try:
            doc = json.loads(block)
        except json.JSONDecodeError:
            continue
        for node in iter_nodes(doc):
            if is_recipe(node):
                return node, block
    return None, None


# --- reading the fields, conservatively -------------------------------------------------------

UNIT_WORDS = {
    "g": "g", "gram": "g", "grams": "g", "gr": "g",
    "kg": "kg", "kilogram": "kg", "kilograms": "kg",
    "ml": "ml", "milliliter": "ml", "milliliters": "ml", "millilitre": "ml", "millilitres": "ml", "cc": "ml",
    "l": "l", "liter": "l", "liters": "l", "litre": "l", "litres": "l",
    "tsp": "tsp", "teaspoon": "tsp", "teaspoons": "tsp",
    "tbsp": "tbsp", "tablespoon": "tbsp", "tablespoons": "tbsp",
    "cup": "cup", "cups": "cup",
    "clove": "clove", "cloves": "clove",
    "pinch": "pinch", "pinches": "pinch",
    "slice": "slice", "slices": "slice",
    "bunch": "bunch", "bunches": "bunch",
    "can": "can", "cans": "can",
    "sachet": "sachet", "sachets": "sachet", "packet": "sachet", "packets": "sachet",
}

# NFKC already decomposes a vulgar fraction into digits joined by U+2044 FRACTION SLASH: "½" becomes
# "1\u20442" and "1½" becomes "11\u20442". Turning that slash into "/" is what lets the ordinary
# fraction branch below read both, which matters because recipe sites publish ½ constantly.
FRACTION_SLASH = "\u2044"

# "2", "1/2", "1 1/2", "0.5" — followed by an optional unit word.
QTY = re.compile(
    r"^\s*(?P<whole>\d+)?\s*(?:(?P<num>\d+)\s*/\s*(?P<den>\d+))?"
    r"(?:\.(?P<dec>\d+))?\s*(?P<unit>[a-zA-Z]+)?\.?\s+(?P<rest>.+)$"
)


def round3(x):
    r = round(x, 3)
    return int(r) if r == int(r) else r


def parse_ingredient(raw):
    """A schema.org recipeIngredient line to (qty, unit, qty_source, note).

    Parses only what is plainly stated. Anything ambiguous — a range, a parenthetical, no number at
    all — keeps the site's wording as the note and stays unspecified. Never invents a number.
    """
    text = unicodedata.normalize("NFKC", raw).replace(FRACTION_SLASH, "/").strip()
    if not text:
        return None, "to_taste", "unspecified", raw
    # A range ("2-3 onions", "1 to 2 cups") is two numbers; picking one would be inventing.
    if re.match(r"^\s*\d+\s*(?:[-–]\s*\d+|to\s+\d+)", text, re.I):
        return None, "to_taste", "unspecified", text

    m = QTY.match(text)
    if not m or not (m.group("whole") or m.group("num")):
        return None, "to_taste", "unspecified", text

    qty = float(m.group("whole")) if m.group("whole") else 0.0
    if m.group("dec"):
        qty = float(f"{m.group('whole') or 0}.{m.group('dec')}")
    if m.group("num") and m.group("den"):
        den = float(m.group("den"))
        if den == 0:
            return None, "to_taste", "unspecified", text
        qty += float(m.group("num")) / den
    if qty <= 0:
        return None, "to_taste", "unspecified", text

    word = (m.group("unit") or "").lower()
    unit = UNIT_WORDS.get(word)
    if word and unit is None:
        # A word we do not recognize may be the ingredient itself ("2 onions"). Count it as pieces
        # and keep the whole line as the note so a human can see what was actually written.
        return round3(qty), "pc", "stated", text
    if not word:
        return round3(qty), "pc", "stated", text
    return round3(qty), unit, "stated", text


ISO_DUR = re.compile(r"^P(?:(?P<d>\d+)D)?(?:T(?:(?P<h>\d+)H)?(?:(?P<m>\d+)M)?(?:(?P<s>\d+)S)?)?$")


def parse_duration_minutes(value):
    """ISO 8601 duration to whole minutes, or None. Only what the page actually stated."""
    if not isinstance(value, str):
        return None
    m = ISO_DUR.match(value.strip())
    if not m or not any(m.group(g) for g in ("d", "h", "m", "s")):
        return None
    total = (int(m.group("d") or 0) * 1440 + int(m.group("h") or 0) * 60
             + int(m.group("m") or 0) + (1 if int(m.group("s") or 0) else 0))
    return total or None


def as_text(value):
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        return (value.get("text") or value.get("name") or "").strip()
    return ""


def flatten_instructions(value):
    """schema.org allows a string, a list of strings, HowToStep objects, or HowToSection groups."""
    out = []
    if isinstance(value, str):
        # One prose blob: split on line breaks only. Splitting sentences would be inventing steps.
        out.extend(p.strip() for p in re.split(r"[\r\n]+", value) if p.strip())
        return out
    for item in value if isinstance(value, list) else [value]:
        if isinstance(item, dict) and item.get("@type", "").endswith("HowToSection"):
            out.extend(flatten_instructions(item.get("itemListElement", [])))
        else:
            text = as_text(item)
            if text:
                out.append(text)
    return out


def parse_yield(value):
    """recipeYield is famously loose: 4, "4", "4 servings", ["4 servings"]."""
    if isinstance(value, list):
        value = value[0] if value else None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        n = int(value)
        return (n, "stated") if n > 0 else (None, "unspecified")
    if isinstance(value, str):
        m = re.search(r"\d+", value)
        if m:
            n = int(m.group())
            return (n, "stated") if n > 0 else (None, "unspecified")
    return None, "unspecified"


def slugify(text):
    s = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return re.sub(r"-{2,}", "-", s)


# --- assembling the staging file ---------------------------------------------------------------

def to_staging(node, raw_block, origin, fetched_at, forced_id=None):
    title = as_text(node.get("name")) or "untitled"
    recipe_id = forced_id or slugify(title) or "untitled"

    raw_ingredients = node.get("recipeIngredient") or node.get("ingredients") or []
    if isinstance(raw_ingredients, str):
        raw_ingredients = [raw_ingredients]

    ingredients, reasons = [], []
    for raw in raw_ingredients:
        text = as_text(raw)
        if not text:
            continue
        qty, unit, qty_source, note = parse_ingredient(text)
        ingredients.append({
            "id": None,              # a human maps this to a canonical ingredient id
            "raw": text,             # exactly what the page said, kept for audit
            "name_es": None,
            "role": None,            # chef's judgment, never inferred from JSON-LD
            "technique": None,
            "qty": qty,
            "unit": unit,
            "qty_source": qty_source,
            "note": note if qty_source == "unspecified" else None,
        })

    steps = []
    for i, text in enumerate(flatten_instructions(node.get("recipeInstructions") or []), start=1):
        steps.append({
            "order": i, "text": text, "text_es": None,
            "dur_s": None, "dur_source": "unspecified", "timer": False, "depends_on": [],
        })

    minutes = (parse_duration_minutes(node.get("totalTime"))
               or parse_duration_minutes(node.get("cookTime"))
               or parse_duration_minutes(node.get("performTime")))
    serves, serves_source = parse_yield(node.get("recipeYield"))

    reasons.append("imported: role and technique unassigned")
    reasons.append("imported: ingredient ids unmapped")
    reasons.append("imported: vegan status not established")
    if minutes is None:
        reasons.append("total time not stated by the source")
    if serves is None:
        reasons.append("yield not stated by the source")
    if any(i["qty_source"] == "unspecified" for i in ingredients):
        reasons.append("some quantities could not be read from the source text")
    if not steps:
        reasons.append("the source page carried no instructions")

    return {
        "id": recipe_id,
        "title": title,
        "title_es": None,
        "source": {
            "kind": "imported",
            "url": origin,
            "site": node.get("publisher", {}).get("name") if isinstance(node.get("publisher"), dict) else None,
            "author": as_text(node.get("author")) or None,
            "fetched_at": fetched_at,
            "jsonld_sha256": hashlib.sha256(raw_block.encode("utf-8")).hexdigest(),
            # The block verbatim, exactly as data/recipes keeps source.original_text verbatim: the
            # hash stays checkable and any drift in this importer stays auditable against it.
            "jsonld": raw_block,
        },
        "category": None,            # closed vocabulary; a human picks
        "diet": {"vegan": None, "gluten_free": None, "notes": []},
        "minutes": minutes,
        "minutes_source": "stated" if minutes is not None else "unspecified",
        "serves": serves,
        "serves_source": serves_source,
        "ingredients": ingredients,
        "steps": steps,
        "review": {"needs_review": True, "reasons": reasons},
    }


def read_source(path_or_url, is_url, timeout):
    if not is_url:
        with open(path_or_url, encoding="utf-8", errors="replace") as f:
            return f.read()
    from urllib.request import Request, urlopen  # imported here: the file path never needs the network
    req = Request(path_or_url, headers={"User-Agent": "mise-recipe-import/0.1 (+https://github.com/annatchijova/mise)"})
    with urlopen(req, timeout=timeout) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"
        return resp.read().decode(charset, errors="replace")


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", help="a saved HTML/JSON file, or a URL with --url")
    ap.add_argument("--url", action="store_true", help="treat the argument as a URL and fetch it")
    ap.add_argument("--id", help="force the staging id (default: a slug of the title)")
    ap.add_argument("-o", "--out-dir", default="data/imports")
    ap.add_argument("--fetched-at", default=None, help="ISO timestamp to record (default: now, UTC)")
    ap.add_argument("--timeout", type=float, default=20.0)
    ap.add_argument("--stdout", action="store_true", help="print instead of writing a file")
    args = ap.parse_args(argv)

    try:
        text = read_source(args.source, args.url, args.timeout)
    except OSError as e:
        print(f"could not read {args.source}: {e}", file=sys.stderr)
        return 2

    node, block = find_recipe(text)
    if node is None:
        print(f"no schema.org/Recipe JSON-LD found in {args.source}", file=sys.stderr)
        print("Record the site in docs/IMPORT_SOURCES.md as 'no JSON-LD' rather than scraping it.", file=sys.stderr)
        return 1

    if args.fetched_at:
        fetched_at = args.fetched_at
    else:
        from datetime import datetime, timezone
        fetched_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    staged = to_staging(node, block, args.source if args.url else f"file:{args.source}", fetched_at, args.id)
    payload = json.dumps(staged, ensure_ascii=False, indent=2, sort_keys=True) + "\n"

    if args.stdout:
        sys.stdout.write(payload)
    else:
        os.makedirs(args.out_dir, exist_ok=True)
        path = os.path.join(args.out_dir, f"{staged['id']}.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write(payload)
        print(f"wrote {path}")

    print(f"  {len(staged['ingredients'])} ingredients, {len(staged['steps'])} steps", file=sys.stderr)
    print(f"  needs_review: {'; '.join(staged['review']['reasons'])}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
