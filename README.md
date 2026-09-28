# IRR Localization

Translations for Incursion. The English text lives in Unreal; this repo holds one JSON file per game
area with every language's translation, and the community editor at
[`editor.html`](https://pompeiic.github.io/irr-localization/editor.html).

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
| `community/config.json` | Admin | Supabase URL + public anon key, captcha site key |
| `community/settings.json` | Admin (via the editor) | Acceptance thresholds |
| `community/schema.sql` | Admin | Supabase tables and access rules |

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

## Community editor

Anyone can browse, vote (▲/▼) on the current translation and on suggestions, and suggest a better
translation with an optional note — no account, an anonymous session is created on the first vote.
AI translations (`status: machine`) are labelled as such. Suggestions and votes live in Supabase; nothing
reaches the game until an admin applies it.

- A suggestion enters the **admin queue** once its net score (up − down) reaches the threshold for its
  language (`community/settings.json`: `defaultThreshold`, per-language `cultures` overrides) and — with
  `requireBeatCurrent` — beats the current translation's net score.
- The admin bulk-applies from the queue with their own GitHub token (kept in their browser only). One
  commit rewrites the touched area files in Unreal's JSON layout, setting
  `status: reviewed`, `by: community:<name>`. Unreal imports it on its next sync.
- A suggestion made for older English text is shown as **Outdated** and cannot be applied.
- Spam guard: 30 suggestions per hour per person, no duplicates; admins can reject and ban.

### One-time setup (admin)

1. Create a free project on [supabase.com](https://supabase.com). SQL Editor → paste
   `community/schema.sql` → Run.
2. Authentication → Sign In / Providers → enable **Anonymous sign-ins**. Optional but recommended:
   Authentication → Attack Protection → enable **Captcha** (Cloudflare Turnstile) and put the Turnstile
   *site* key into `community/config.json` → `turnstileSiteKey`.
3. Authentication → Users → **Add user** (email + password) for yourself, copy its user id, then in the
   SQL Editor: `insert into public.admins (user_id) values ('<user id>');`
4. Project Settings → API: put the Project URL and the **anon public** key into `community/config.json`
   (both are meant to be public — the access rules in `schema.sql` are what protect the data).
5. On the editor page: **Admin** → sign in → paste a fine-grained GitHub token for this repo with
   Contents: read/write.

`keepalive.yml` pings the backend daily so the free project is never paused for inactivity.

## Access

Branch protection on `main`: require a pull request and the `validate` check. Translators fork (or get
collaborator access) and create a fine-grained token limited to this repo with **Contents: read/write**
and **Pull requests: read/write**. Never share one token between people.
