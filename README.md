# IRR Localization

Translations for Incursion. The English text lives in Unreal; this repo holds one JSON file per game
area with every language's translation, and (soon) the web editor that edits them.

## How the round trip works

1. Unreal (`IRR -> Sync Translations (Full)`) downloads this repo, imports approved translations,
   gathers all game text, compiles, and uploads the refreshed area files.
2. Translators edit on the web page and open a **pull request**; the `Validate translations` check
   must pass and a maintainer merges it.
3. The next Unreal sync pulls the merged translations into the game.

Unreal refuses to upload over a file that changed on GitHub since its last download, so a merged pull
request is never overwritten by a stale export.

## Files

| File | Owner | What |
|---|---|---|
| `Project.json` | Unreal | Languages, export time, area index with progress counts |
| `Areas/<Area>.json` | Unreal (English) + translators (`t`, `note`, `maxLength`, `areaOverride`) | Every string of one game area |
| `Glossary.json` | Translators | Do-not-translate words and fixed terms |

An entry:

```json
{
  "ns": "IRRInventory", "key": "DropItem",
  "source": "Drop {Count} items", "sourceHash": "1a2b3c4d",
  "origin": "/Game/UI/Inventory/WBP_Item.WBP_Item_C:WidgetTree.DropText.Text",
  "note": "Button label", "maxLength": 24,
  "t": { "de": { "text": "{Count} Gegenstände ablegen", "status": "reviewed", "by": "name", "at": "2026-09-24" } }
}
```

Status: `untranslated` → `machine` (AI first pass) → `reviewed` → `approved`. `stale` = the English text
changed after this was translated; it stays out of the game until someone re-reviews it.

Rules the check enforces (and Unreal re-checks on import):

- Keep every `{Argument}` from the English text, and the same number of `</>` rich-text closers.
- Never edit `ns`, `key`, `source`, `sourceHash`, `origin`, add or remove entries, or touch `Project.json`.
- Respect `maxLength` when it is set.

## Access

Branch protection on `main`: require a pull request and the `validate` check. Translators fork (or get
collaborator access) and create a fine-grained token limited to this repo with **Contents: read/write**
and **Pull requests: read/write**. Never share one token between people.
