"""The review record: what a person checked, and whether it still applies.

Shared by review_queue.py and review_sign.py rather than copied into both, because the digest is the
whole mechanism and two copies of it would be two mechanisms.

Every curated table here carries somebody's judgment, and until now a row a cook had read and
confirmed looked exactly like a row nobody had ever opened. A `reviewed` block fixes that, and it
carries one field that makes it worth having:

    "reviewed": {
      "by": "the author's kitchen",
      "on": "2026-09-06",
      "verdict": "confirmed" | "corrected" | "unsure",
      "note": "...",
      "row_digest": "3f2a1b9c8d7e"
    }

`row_digest` is a hash of the row as it stood when it was read. A review that does not say what it
reviewed is worthless: somebody changes 7 days to 14 a year later and the row still claims a cook
signed it off. So the digest is checked, not trusted, and a row whose content has moved since comes
back into the queue with the review marked stale.

`unsure` is not a failed review. It is a cook saying "this needs a second opinion", which is more
information than the row had before, and it ranks a row *up* rather than clearing it.
"""
import hashlib
import json

VERDICTS = ("confirmed", "corrected", "unsure")


def row_digest(row):
    """A stable digest of a row's content, ignoring the review block itself.

    Canonical JSON with sorted keys, so the digest depends on what the row says and not on how the
    file happens to be laid out. Twelve hex characters: enough that a collision is not a thing that
    happens to a 400-row table, short enough to read out.
    """
    body = {k: v for k, v in row.items() if k != "reviewed"}
    canonical = json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:12]


def review_state(row):
    """One of: 'none', 'current', 'stale'.

    'stale' means somebody reviewed this row and then its content changed. That is not a failure and
    not misconduct -- it is the ordinary life of a table -- but the review no longer applies to what
    is there now, and saying otherwise would be the table claiming a sign-off it does not have.
    """
    r = row.get("reviewed")
    if not r:
        return "none"
    return "current" if r.get("row_digest") == row_digest(row) else "stale"


def problems(row, where):
    """Hard errors in a review block. Returned rather than printed, for the validators."""
    r = row.get("reviewed")
    if r is None:
        return []
    out = []
    if not isinstance(r, dict):
        return [f"{where}: 'reviewed' must be an object"]
    for field in ("by", "on", "verdict", "row_digest"):
        if not str(r.get(field) or "").strip():
            out.append(f"{where}: the review has no {field}")
    if r.get("verdict") and r["verdict"] not in VERDICTS:
        out.append(f"{where}: verdict {r['verdict']!r} is not one of {', '.join(VERDICTS)}")
    if r.get("verdict") == "unsure" and not str(r.get("note") or "").strip():
        out.append(f"{where}: an 'unsure' verdict must say what the doubt is, or nobody can act on it")
    on = str(r.get("on") or "")
    if on and (len(on) != 10 or on[4] != "-" or on[7] != "-"):
        out.append(f"{where}: 'on' should be a YYYY-MM-DD date, got {on!r}")
    return out
