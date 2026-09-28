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

Anyone can browse. To vote (▲/▼) on the current translation and on suggestions, or to suggest a better
translation with an optional note, people sign in with **Discord** — one account, one vote, and the
Discord name is shown on their suggestions (set by the database, not the browser). AI translations
(`status: machine`) are labelled as such. Suggestions and votes live in Supabase; nothing reaches the game
until an admin applies it.

- Strings are grouped by game **theme** (`community/themes.json`: first matching regex on
  `area|origin` wins; `hidden` = dev-only text, also excluded from the Unreal gather). Asset paths and
  keys are shown to admins only.
- In-game formatting is shown rendered, never as raw `<Tag>…</>` markup. Tags that wrap a whole text are
  applied automatically; inner formatting is set by selecting words and clicking e.g. **Red** / **Bold**.
  `{Placeholders}` are locked chips with insert buttons. An opener nothing closes (`cd <directory>`) is
  literal text.
- A suggestion enters the **review queue** once its net score (up − down) reaches the threshold for its
  language (`community/settings.json`: `defaultThreshold`, per-language `cultures` overrides) and — with
  `requireBeatCurrent` — beats the current translation's net score.
- Admins (`public.admins`) see the Admin views after signing in; nobody else sees them. The admin
  bulk-applies from the queue with their own GitHub token (kept in their browser only). One commit
  rewrites the touched area files in Unreal's JSON layout, setting `status: reviewed`,
  `by: community:<name>`. Unreal imports it on its next sync.
- A suggestion made for older English text is shown as **Outdated** and cannot be applied.
- Spam guard: 30 suggestions per hour per person, no duplicates; admins can reject and ban.

### One-time setup (admin)

1. Create a free project on [supabase.com](https://supabase.com). SQL Editor → paste
   `community/schema.sql` → Run (re-run it after it changes; it is safe to run repeatedly).
2. Discord: [discord.com/developers/applications](https://discord.com/developers/applications) → **New
   Application** → OAuth2 → add the redirect `https://<project>.supabase.co/auth/v1/callback` → copy
   Client ID + Client Secret.
3. Supabase → Authentication → Sign In / Providers → **Discord**: enable, paste Client ID + Secret. Turn
   **Anonymous sign-ins** off. Authentication → URL Configuration: Site URL
   `https://pompeiic.github.io/irr-localization/editor.html`, redirect URLs
   `https://pompeiic.github.io/irr-localization/**`.
4. Project Settings → API: put the Project URL and the **publishable** key into `community/config.json`
   (both are meant to be public — the access rules in `schema.sql` protect the data).
5. Sign in on the editor with Discord, account menu → **Copy user id**, then in the SQL Editor:
   `insert into public.admins (user_id) values ('<user id>');` — reload, the Admin views appear.
6. Admin → Settings: paste a fine-grained GitHub token for this repo with Contents: read/write.

`keepalive.yml` pings the backend daily so the free project is never paused for inactivity.

## Access

Branch protection on `main`: require a pull request and the `validate` check. Translators fork (or get
collaborator access) and create a fine-grained token limited to this repo with **Contents: read/write**
and **Pull requests: read/write**. Never share one token between people.
