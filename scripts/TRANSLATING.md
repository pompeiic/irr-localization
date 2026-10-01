# AI first pass — Incursion: Red River

Fills in whatever is still missing after an Unreal sync: languages that are missing, `untranslated` or
`stale`, machine translations whose characters were lost to a wrong-encoding write (`??`,
`Milit?rbasis`), and machine translations that break rule 6 or 7 below. Texts in `Excluded.json` and Lorem-ipsum placeholders are skipped. Human work
(`reviewed` / `approved`) is never touched. Everything written here has `status: machine`, `by: ai`.

## Steps

1. `python scripts/ai_translate.py extract` — writes `.work/todo/t##.json`. If it reports 0 strings, stop.
2. For every `t##.json`, write `.work/done/t##.json` (same name) as described below.
3. `python scripts/ai_translate.py merge` — validates and writes into `Areas/`. It must end with
   `problems: 0` and `missing: 0` (exit code 0); fix the reported ids in `done/` and run it again.
4. Only `Areas/*.json` may change. `.work/` is ignored by git.

**Write the `done` files with a UTF-8 file writer** (an editor's write-file tool, or Python with
`encoding="utf-8"`). Never pipe them through a shell (`echo`, `Out-File`, `Set-Content`, heredocs): a
console code page turns every non-Latin character into `?`, which is how 28 mission texts broke once.

## Input
Each batch is a JSON array of `{id, source, area, context, cultures, maxLength?, note?}`. `cultures` lists
the languages to write for that string. `context` says where the text appears (widget / data asset /
property path) — use it to pick the register (button label vs. dialogue vs. item description). `maxLength`,
if present, is a hard character limit.

## Output
One JSON object mapping every input `id` to an object with exactly the languages in its `cultures`:

```json
{ "s0001": { "de": "...", "zh-Hans": "...", "ru": "...", "ko": "...", "ja": "...", "es-ES": "..." } }
```

Strict JSON: escape `"` as `\"`, backslashes as `\\`, line breaks as `\n` (keep `\r\n` if the source has it).

## Hard rules (the merge rejects violations)
1. **Rich-text tags** such as `<strong>`, `<italic>`, `<redacted>`, `<Red>` and the closer `</>` appear
   exactly as in the source — same names, same count. Move tagged spans where the grammar needs it.
2. **Placeholders** in braces (`{0}`, `{Count}`, `{Name}` …) are copied verbatim.
3. Keep leading/trailing spaces and line breaks of the source.
4. Do not translate: `Incursion`, `Red River`, `IRR`, faction codes `FANG UICS IGC VLF`, map names
   `QUARRY BUNKER DELTA OUTSKIRTS HEARTLANDS`, weapon / brand / model / part names (AK-74M, AUG, MCX …),
   calibers (5.56x45 …), key names (F, Esc, Tab), terminal commands, file names, passwords, code names and
   acronyms. Personal names and Vietnamese / Russian words already in the English stay as written.
5. If the source is ALL CAPS, write de / ru / es-ES in ALL CAPS too.
6. **No dashes as punctuation.** A translation may not contain more em dashes (—), en dashes (–) or
   double hyphens (--) than its source. Use a comma, colon, full stop or brackets, or rephrase (Russian:
   `это` / `является` / a colon instead of `X — Y`). Machine translations that added dashes are queued again.
7. **Words that are not English stay as written.** Vietnamese and Cyrillic words in the source
   (`Quân Liên Lục Địa`, `bọn tây`, `Сволочь`) appear verbatim, accents included, in every language; only
   the English around them (e.g. a `[that means UICS]` explanation) is translated.

## Style
Follow [`GUIDELINES.md`](../GUIDELINES.md): it is the same rule set the community works to (stay close to
the English, tone and register, punctuation, consistency, per-language forms of address). Also match how
existing translations in `Areas/` render recurring game terms (stash, intel, jammer, boss, hideout units).
