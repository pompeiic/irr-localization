"""AI first pass for missing translations.

  python scripts/ai_translate.py extract   -> .work/todo/t##.json: every string some language still needs
  (translate each batch into .work/done/t##.json, see scripts/TRANSLATING.md)
  python scripts/ai_translate.py merge     -> validates the results and writes them into Areas/ as "machine"

A language needs work when it is missing, untranslated, stale, its text was mangled into "??" by a
wrong-encoding write, or a machine text breaks a style rule (em/en dashes, lost non-English words). Excluded ("don't localize") texts and Lorem-ipsum placeholders are skipped.
"""
import datetime
import glob
import json
import os
import re
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import uejson  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(ROOT, ".work")
TODO, DONE = os.path.join(WORK, "todo"), os.path.join(WORK, "done")
CULTURES = ["de", "zh-Hans", "ru", "ko", "ja", "es-ES"]
BATCH_CHARS = 9000


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def area_files():
    return sorted(glob.glob(os.path.join(ROOT, "Areas", "*.json")))


def excluded_ids():
    path = os.path.join(ROOT, "Excluded.json")
    return {(e.get("ns", ""), e["key"]) for e in load(path).get("entries", [])} if os.path.exists(path) else set()


def has_words(src):
    return re.search(r"[A-Za-z]{2,}", re.sub(r"<[^>]*>|\{[^}]*\}", "", src)) is not None


def is_placeholder(src):
    return "lorem ipsum" in src.lower()


def mangled(text, src):
    # Lost characters show up as "??" runs, or as a "?" inside a word ("Milit?rbasis").
    if "\ufffd" in text:
        return True
    if re.search(r"\?{2,}", text) and not re.search(r"\?{2,}", src):
        return True
    return "?" not in src and re.search(r"\w\?\w", text) is not None


VIET = re.compile(r"[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]", re.I)
CYRILLIC = re.compile(r"[\u0400-\u04FF]")
LATIN = re.compile(r"[A-Za-z]")


def double_hyphens(s):
    return len(re.findall(r"(?<!-)--(?!-)", s))


def foreign_words(src):
    # Vietnamese (accented Latin) or all-Cyrillic words; mixed-script typos like a Cyrillic "АK" are skipped.
    words = re.findall(r"[^\s\[\](){}<>.,!?;:\"“”«»„'’]+", re.sub(r"<[^>]*>", " ", src))
    return sorted({w for w in words if VIET.search(w) or (CYRILLIC.search(w) and not LATIN.search(w))})


def style_problem(src, text):
    if re.search(r"[\u2013\u2014]", text):
        return "contains an em/en dash (— –); use a regular hyphen (-), comma, colon or full stop"
    if double_hyphens(text) > double_hyphens(src):
        return "adds a double hyphen (--); use a regular hyphen (-), comma, colon or full stop"
    lost = [w for w in foreign_words(src) if w not in text]
    if lost:
        return f"non-English words must stay as written: {', '.join(lost[:5])}"
    return None


def cultures_needing_work(entry):
    out = []
    for c in CULTURES:
        t = (entry.get("t") or {}).get(c) or {}
        status, text = t.get("status"), t.get("text", "")
        if status in (None, "untranslated", "stale") or not text or (
                status == "machine" and (mangled(text, entry["source"]) or style_problem(entry["source"], text))):
            out.append(c)
    return out


def short_origin(o):
    o = re.sub(r"\(\d+\)$", "", o or "")
    m = re.match(r"/Game/(?:Blueprints/)?(.*?)\.[^.:]+(?:_C)?[.:](.*)$", o)
    return m.group(1) + " :: " + m.group(2)[-60:] if m else o[-90:]


def args(s):
    return sorted(set(re.findall(r"\{([^{}]*)\}", s)))


def tag_names(s):
    return sorted(t.lower() for t in re.findall(r"<([A-Za-z]\w*)[^>]*>", s))


def check(src, text):
    if not isinstance(text, str) or not text.strip():
        return "empty"
    if mangled(text, src):
        return "contains ?? or U+FFFD (written with the wrong encoding)"
    if args(text) != args(src):
        return f"placeholders {args(text)} vs {args(src)}"
    if text.count("</>") != src.count("</>") or tag_names(text) != tag_names(src):
        return "rich-text tags differ"
    return style_problem(src, text)


def extract():
    skip = excluded_ids()
    items, placeholders = {}, 0
    for path in area_files():
        doc = load(path)
        for e in doc["entries"]:
            if (e.get("ns", ""), e["key"]) in skip:
                continue
            need = cultures_needing_work(e)
            if not need or not has_words(e["source"]):
                continue
            if is_placeholder(e["source"]):
                placeholders += 1
                continue
            it = items.setdefault(e["source"], {"source": e["source"], "area": doc["area"], "context": [], "cultures": set()})
            it["cultures"].update(need)
            if len(it["context"]) < 2:
                it["context"].append(short_origin(e.get("origin")))
            if e.get("maxLength"):
                it["maxLength"] = min(it.get("maxLength") or 10**9, e["maxLength"])
            if e.get("note") and not it.get("note"):
                it["note"] = e["note"]

    for d in (TODO, DONE):
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
    batches, cur, size = [], [], 0
    for n, it in enumerate(sorted(items.values(), key=lambda i: (i["area"], i["context"][:1]))):
        row = {"id": "s%04d" % n, **{k: v for k, v in it.items() if k != "cultures"}, "cultures": [c for c in CULTURES if c in it["cultures"]]}
        if cur and size + len(row["source"]) > BATCH_CHARS:
            batches.append(cur)
            cur, size = [], 0
        cur.append(row)
        size += len(row["source"])
    if cur:
        batches.append(cur)
    for b, rows in enumerate(batches):
        with open(os.path.join(TODO, "t%02d.json" % b), "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False, indent=1)
    print(f"{len(items)} string(s) to translate in {len(batches)} batch(es); {placeholders} Lorem-ipsum placeholder(s) skipped")
    for b, rows in enumerate(batches):
        print(f"  t{b:02d}: {len(rows)} strings, {sum(len(r['source']) for r in rows)} chars")


def merge():
    rows = {}
    for path in sorted(glob.glob(os.path.join(TODO, "*.json"))):
        rows.update({r["id"]: r for r in load(path)})
    results, problems = {}, []
    for path in sorted(glob.glob(os.path.join(DONE, "*.json"))):
        try:
            data = load(path)
        except Exception as ex:  # noqa: BLE001
            problems.append(f"{os.path.basename(path)}: invalid JSON ({ex})")
            continue
        for sid, per in data.items():
            row = rows.get(sid)
            if not row:
                problems.append(f"{sid}: unknown id")
                continue
            for c in row["cultures"]:
                text = per.get(c) if isinstance(per, dict) else None
                why = check(row["source"], text)
                if why:
                    problems.append(f"{sid} [{c}]: {why}")
                    continue
                src = row["source"]
                if src.startswith(" ") and not text.startswith(" "):
                    text = " " + text.lstrip()
                if src.endswith(" ") and not text.endswith(" "):
                    text = text.rstrip() + " "
                results.setdefault(src, {})[c] = text
    missing = [f"{sid} [{c}]" for sid, r in rows.items() for c in r["cultures"] if c not in results.get(r["source"], {})]

    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    skip, filled, files = excluded_ids(), 0, 0
    for path in area_files():
        doc = load(path)
        dirty = False
        for e in doc["entries"]:
            if (e.get("ns", ""), e["key"]) in skip:
                continue
            for c in cultures_needing_work(e):
                text = results.get(e["source"], {}).get(c)
                if text is None and not has_words(e["source"]):
                    text = e["source"]
                if text is None:
                    continue
                e.setdefault("t", {})[c] = {"text": text, "status": "machine", "by": "ai", "at": now}
                filled += 1
                dirty = True
        if dirty and "--dry" not in sys.argv:
            uejson.write(path, doc)
            files += 1
    print(f"filled {filled} translation(s) in {files} file(s)")
    print(f"problems: {len(problems)}")
    for p in problems:
        print("  " + p)
    print(f"missing: {len(missing)}")
    for m in missing:
        print("  " + m)
    return 1 if problems or missing else 0


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "extract":
        extract()
    elif cmd == "merge":
        sys.exit(merge())
    else:
        print(__doc__)
        sys.exit(2)
