# Translation guidelines

How we translate Incursion: Red River. These apply to everyone: community translators, reviewers voting on suggestions, and the AI first pass.

## Stay close to the English

- Translate as close to the original as you can, almost word for word, unless that reads silly in your language or changes the meaning. A close translation is the easiest way to keep what the English intends.
- Do not add, drop or change information. No extra jokes, no softening or sharpening, no explaining what the English leaves open.
- Keep the tone: terse, military, grounded. Players are private military operators; briefings sound like a handler talking to an operator.
- Match the register of where the text appears (see **About this text**): buttons and labels short, objectives as instructions, briefings and item descriptions natural and fluent.
- If the English is unclear, read the context, add a context note or ask before guessing.

## Don't fix mistakes in the English

- If the English has a typo, a wrong word or an inconsistency, report it on Discord or add it as a context note on that text. Translate what the English means, but do not quietly fix it only in your language.
- When the English is fixed, every language and every English-speaking player gets the fix. A fix in one translation reaches only that language.

## Keep the length

- Some texts have little room (buttons, labels, tabs, column headers). Keep your translation close to the English length there; when two wordings are equally good, take the shorter one.
- If a text shows a character limit, it is a hard limit.
- Longer texts (briefings, descriptions) can run a little longer or shorter, but a translation much longer than the English may not fit on screen.

## Text that is not English stays as written

- Some lines, mostly in Observer briefings and faction messages, mix in Vietnamese or Russian: `Quân Liên Lục Địa`, `bọn tây`, `Châu thổ`, `Сволочь`, `Жук`. Copy these exactly, with every accent, in every language. Do not translate, transliterate or "correct" them.
- The English explanation next to them, usually in square brackets (`[that means UICS]`), is translated as normal.
- A text with no English in it at all is copied unchanged.
- Personal names, call signs, faction codes (`FANG`, `UICS`, `IGC`, `VLF`), map names, weapon, brand and model names, calibers, key names and terminal commands stay as written. `Glossary.json` lists them.

## Letter case

- Keep the case of the English. If the English is ALL CAPS, write yours in ALL CAPS; if Every Word Is Capitalized, capitalize every word; if it is a normal sentence, write a normal sentence.
- Languages without capital letters (Chinese, Japanese, Korean) skip this, but Latin words and codes inside them keep their case.

## Punctuation

- **No em dashes (—) or en dashes (–).** Replace them with a regular hyphen (`-`), or use a comma, colon or full stop where that reads better. This includes dashes the English itself uses. Never use a double hyphen (`--`) as a dash.
- Separator lines made of hyphens (`-----`) are layout; copy them as they are.
- Hyphens inside words and names are fine (`AK-74M`, `5.56x45`, `semi-automatic`).
- Use your language's own quotation marks and punctuation: „…" in German, «…» in Russian and Spanish, 「…」 in Japanese, “…” in Chinese and Korean, ¿ and ¡ in Spanish.

## Formatting the game needs

The editor and the checks enforce these; a translation that breaks them cannot be submitted.

- Keep every `{Placeholder}` (use the buttons in the editor). Move it where your grammar needs it.
- Keep the in-game formatting (red, bold, italic, redacted) on the matching words.
- Keep line breaks and leading or trailing spaces.
- Respect the character limit when a text shows one.
- Numbers are filled in by the game: phrase texts with `{Count}` so they read right for 1 and for many, e.g. "Items: {Count}" instead of a plural that only fits one case.

## Consistency

- The same term often appears in several categories. Before suggesting a change to a term, search the editor for it and make sure your wording matches everywhere it appears, or suggest the change everywhere.
- Use the terms in `Glossary.json`. For anything else, use the word the existing translations already use for the same thing (stash, intel, hideout, contract).
- Texts in the same group should feel the same: for example, all hideout unit names are nouns, all objectives are written the same way, all buttons use the same verb form.
- For menus and settings, use the standard wording players know from other games in your language.
- Address the player informally and avoid gendered forms for them where your language allows; the operator can be anyone.
- German: informal "du". Spanish (Spain): Castilian, "tú". Russian: "ты" in dialogue. Korean: UI as short nouns, objectives as imperatives (…하라), briefings in formal 합쇼체. Japanese: concise UI, objectives as …しろ. Chinese (Simplified): concise.

## Notes and context

- Give a reason for a change in your suggestion note: which term, which grammar rule, what context. Not every suggestion needs one, but a reason helps voters understand it or suggest something better.
- Not sure about your own suggestion? Say so in the note and ask for a better alternative.
- Write notes and context in English where you can, so the developers can read them too.

## Voting and suggesting

- Vote on whether a text reads right in the game, not on personal taste. If you vote a translation down, suggest a better one or say what is wrong in a note.
- Do not paste unchecked machine translation. The AI drafts are already there; a suggestion should be better than them.
- One person, one account. Do not vote on behalf of others or organise votes.
- Vote **Shouldn't be translated** only for text that is not meant for players (debug, placeholder, internal ids) or must stay identical in every language (a name, a code). Not for text that is simply hard to translate.
- No personal information or spoilers outside the text's own mission in screenshots.
- Be kind. Disagree in notes, not in votes against people; an admin makes the final call.
