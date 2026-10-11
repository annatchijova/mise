#!/usr/bin/env python3
"""Extract recipes from the 'Dulces' book PDF text into raw per-recipe JSON. Stdlib only.

    pdftotext -layout Libro_1_Dulces.pdf libro1.txt
    scripts/extract_dulces.py libro1.txt -o work/dulces/raw

This reads ONE book's layout: a recipe opens on a page carrying 'ESPACIO PARA TU FOTO',
its ingredient groups are ALL-CAPS headers ('PARA LA MASA', 'INGREDIENTES'), and its method
lives on a later page titled '<Title> - Procedimiento' as numbered steps.

What comes out is NOT a recipe under docs/RECIPE_SCHEMA.md. It carries only what the page
plainly states: the Spanish title, the verbatim ingredient lines with a quantity parsed when
one is written, the verbatim steps, and whatever the footer states about oven, time and yield.
Everything that is the cook's judgment - canonical ingredient ids, role, technique, category,
tags, the vegan claim, the English translation - is left absent for a human, exactly as the
JSON-LD importer leaves them.
"""
import argparse, json, os, re, sys, unicodedata

FOTO = "ESPACIO PARA TU FOTO"
# The method marker follows the title, which may wrap, so the dash and the word can be split
# across a line break.
PROC = re.compile(r"[—-]\s*Procedimiento")
SECTIONS = {"TORTAS Y BUDINES", "TORTAS, BUDINES Y PANES DULCES", "TARTAS Y PASTELERÍA FRÍA",
            "GALLETAS, MASAS CHICAS Y CLÁSICOS", "POSTRES, DESAYUNOS Y CONSERVAS DULCES",
            "TARTAS Y PASTELERIA FRIA", "GALLETAS Y MASAS CHICAS"}

# Written amounts the book uses. A fraction is exact; a word like "pizca" is not a number.
FRACTIONS = {"1/2": 0.5, "1/3": 1/3, "1/4": 0.25, "2/3": 2/3, "3/4": 0.75, "1/8": 0.125}
UNITS = {
    "g": "g", "gr": "g", "gramos": "g", "kg": "kg", "kilo": "kg", "kilos": "kg",
    "ml": "ml", "cc": "ml", "l": "l", "litro": "l", "litros": "l",
    "taza": "cup", "tazas": "cup", "cucharada": "tbsp", "cucharadas": "tbsp",
    "cucharadita": "tsp", "cucharaditas": "tsp", "diente": "clove", "dientes": "clove",
    "pizca": "pinch", "rodaja": "slice", "rodajas": "slice", "lata": "can", "latas": "can",
    "sobre": "sachet", "sobres": "sachet",
}


def slug(s):
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s)).strip("-")


def parse_amount(line):
    """Return (qty, unit, source). Only what the line plainly states; never a guess."""
    t = line.strip()
    m = re.match(r"^(\d+\s*/\s*\d+|\d+(?:[.,]\d+)?)\s+(?:de\s+)?([a-záéíóúñ]+)\b", t, re.I)
    if not m:
        return None, "to_taste", "unspecified"
    raw_n, raw_u = m.group(1).replace(" ", ""), m.group(2).lower()
    qty = FRACTIONS.get(raw_n)
    if qty is None:
        try:
            qty = float(raw_n.replace(",", "."))
        except ValueError:
            return None, "to_taste", "unspecified"
    unit = UNITS.get(raw_u)
    if unit is None:
        # "2 manzanas", "2 estrellas de anís" - a count of a thing, not a unit.
        return (int(qty) if qty == int(qty) else qty), "pc", "stated"
    return (int(qty) if qty == int(qty) else qty), unit, "stated"


def parse_footer(text):
    """Oven, time and yield as the footer states them. Absent stays absent."""
    out = {"oven_c": None, "minutes": None, "serves_text": None, "mould": None}
    m = re.search(r"(\d{2,3})\s*°C", text)
    if m: out["oven_c"] = int(m.group(1))
    m = re.search(r"(\d+)\s*min", text)
    if m: out["minutes"] = int(m.group(1))
    m = re.search(r"(\d+(?:\s*-\s*\d+)?)\s*porciones", text)
    if m: out["serves_text"] = m.group(1).replace(" ", "")
    m = re.search(r"Molde[^\n·]*", text)
    if m: out["mould"] = m.group(0).strip()
    return out


def split_pages(text):
    return text.split("\f")


def is_running_head(line):
    """A page's own furniture: the book's name, or a section head set in capitals."""
    t = line.strip()
    if not t: return False
    if "VEGAN DELICIOUS" in t.upper() or "LIBRO 1" in t.upper(): return True
    return t == t.upper() and len(t) > 3


def title_from_page(page):
    """The recipe title: the lines above ESPACIO PARA TU FOTO that are not page furniture.

    The title may wrap over two lines, so what survives is joined rather than taken first."""
    head = page.split(FOTO)[0]
    lines = [l.strip() for l in head.splitlines() if l.strip() and not is_running_head(l)]
    return " ".join(lines).strip() if lines else None


def is_group_header(line):
    """An ingredient group head. Scanned only after ESPACIO PARA TU FOTO, where the page's own
    running heads can no longer be confused with one, so any short capitalised line qualifies -
    the book uses 'PARA LA MASA' but also bare 'MASA MADRE' and 'AMASIJO'."""
    t = line.strip()
    if not t or len(t) > 40: return False
    if not re.search(r"[A-ZÁÉÍÓÚÑ]", t): return False
    if "VEGAN DELICIOUS" in t.upper() or t.upper() in SECTIONS: return False
    return t == t.upper()


def extract(text):
    pages = split_pages(text)
    starts = [i for i, p in enumerate(pages) if FOTO in p]
    recipes = []
    for n, start in enumerate(starts):
        end = starts[n + 1] if n + 1 < len(starts) else len(pages)
        block_pages = pages[start:end]
        block = "\f".join(block_pages)
        title = title_from_page(block_pages[0])
        if not title:
            continue

        # Ingredients: lines following an ALL-CAPS group header, until the method starts.
        groups, current = [], None
        before_method = PROC.split(block)[0]
        after_photo = before_method.split(FOTO, 1)[1] if FOTO in before_method else before_method
        for raw in after_photo.splitlines():
            line = raw.strip()
            if is_group_header(raw):
                current = {"group": line, "items": []}
                groups.append(current)
                continue
            if current is None or not line:
                continue
            if line.upper() in SECTIONS or FOTO in line or line.startswith("💡"):
                continue
            # The method page opens with the recipe's own title; splitting on the marker leaves
            # that title at the tail of the ingredient text. It is not an ingredient.
            if title and line and (line in title or title.startswith(line)):
                continue
            # Page furniture that is not a group head is not an ingredient either.
            if is_running_head(line):
                continue
            qty, unit, src = parse_amount(line)
            current["items"].append({"raw": line, "qty": qty, "unit": unit, "qty_source": src})

        # Method: numbered steps on the '— Procedimiento' page.
        steps, tail = [], ""
        parts = PROC.split(block, maxsplit=1)
        if len(parts) > 1:
            tail = parts[1]
            cur = None
            steps_text = tail.split("💡", 1)[0]
            for raw in steps_text.splitlines():
                line = raw.rstrip()
                m = re.match(r"^\s*(\d{1,2})\s{2,}(.*)$", line)
                if m:
                    if cur: steps.append(cur)
                    cur = {"order": int(m.group(1)), "text_es": m.group(2).strip()}
                elif cur is not None and line.strip() and not line.strip().startswith("💡"):
                    if re.search(r"°C|porciones|Molde|^\s*$", line): continue
                    cur["text_es"] += " " + line.strip()
            if cur: steps.append(cur)

        groups = [g for g in groups if g["items"]]
        tips = []
        for chunk in block.split("💡")[1:]:
            # A tip runs until the page ends or the footer line begins.
            lines = []
            for raw in chunk.splitlines():
                t = raw.strip()
                if not t:
                    if lines: break
                    continue
                if re.search(r"°C|porciones|Molde|^[A-ZÁÉÍÓÚÑ ,]{6,}$", t): break
                lines.append(t)
            if lines: tips.append(" ".join(lines))
        recipes.append({
            "id": slug(title),
            "title_es": title,
            "ingredient_groups": groups,
            "steps": steps,
            "footer": parse_footer(tail or block),
            "tips": tips,
            "source": {"book": "dulces-libro-1", "kind": "book", "page_index": start},
            "original_text": block.strip(),
            "review": {"needs_review": True, "reasons": [
                "extracted: canonical ingredient ids unmapped",
                "extracted: role and technique unassigned",
                "extracted: vegan status not established",
                "extracted: category, tags and English text absent",
            ]},
        })
    return recipes


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", help="the pdftotext -layout output")
    ap.add_argument("-o", "--out-dir", help="write one JSON per recipe here")
    ap.add_argument("--summary", action="store_true", help="print a table instead of JSON")
    args = ap.parse_args(argv)

    text = open(args.source, encoding="utf-8").read()
    recipes = extract(text)

    if args.summary:
        print(f"{'id':45s} {'ingr':>5s} {'stated':>7s} {'steps':>6s} {'oven':>5s} {'min':>4s}")
        for r in recipes:
            items = [i for g in r["ingredient_groups"] for i in g["items"]]
            stated = sum(1 for i in items if i["qty_source"] == "stated")
            f = r["footer"]
            print(f"{r['id'][:45]:45s} {len(items):5d} {stated:7d} {len(r['steps']):6d} "
                  f"{(f['oven_c'] or ''):>5} {(f['minutes'] or ''):>4}")
        tot = len(recipes)
        allit = [i for r in recipes for g in r["ingredient_groups"] for i in g["items"]]
        st = sum(1 for i in allit if i["qty_source"] == "stated")
        print(f"\n{tot} recipes, {len(allit)} ingredient lines, {st} with a stated quantity "
              f"({0 if not allit else round(100*st/len(allit))}%), "
              f"{sum(len(r['steps']) for r in recipes)} steps")
        return 0

    if args.out_dir:
        os.makedirs(args.out_dir, exist_ok=True)
        for r in recipes:
            with open(os.path.join(args.out_dir, f"{r['id']}.json"), "w", encoding="utf-8") as fh:
                json.dump(r, fh, ensure_ascii=False, indent=2, sort_keys=True)
        print(f"wrote {len(recipes)} files to {args.out_dir}")
    else:
        json.dump(recipes, sys.stdout, ensure_ascii=False, indent=2, sort_keys=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
