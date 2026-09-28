"""Writes JSON the way Unreal's pretty printer does, so files it round-trips stay byte-identical."""
import json


def _s(v):
    return json.dumps(v, ensure_ascii=False)


def _value(v, depth, nl):
    pad = "\t" * depth
    if isinstance(v, dict):
        if not v:
            return "{}"
        items = [f'{pad}\t{_s(k)}:{_after_key(x, depth + 1, nl)}' for k, x in v.items()]
        return "{" + nl + ("," + nl).join(items) + nl + pad + "}"
    if isinstance(v, list):
        if not v:
            return "[]"
        items = [f"{pad}\t{_value(x, depth + 1, nl)}" for x in v]
        return "[" + nl + ("," + nl).join(items) + nl + pad + "]"
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return "null"
    return _s(v)


def _after_key(v, depth, nl):
    # Unreal puts a non-empty object on the line after its key; arrays and scalars stay on the key's line.
    if isinstance(v, dict) and v:
        return nl + "\t" * depth + _value(v, depth, nl)
    return " " + _value(v, depth, nl)


def dumps(doc, nl="\r\n"):
    return _value(doc, 0, nl) + "\n"


def write(path, doc):
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(dumps(doc))
