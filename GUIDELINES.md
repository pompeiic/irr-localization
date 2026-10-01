# Translation guidelines

How we translate Incursion: Red River. These apply to everyone: community translators, reviewers voting on suggestions, and the AI first pass.

## Stay close to the English

- Translate the meaning, not word for word, but do not add, drop or change information. No extra jokes, no softening or sharpening, no explaining what the English leaves open.
- Keep the tone: terse, military, grounded. Players are private military operators; briefings sound like a handler talking to an operator.
- Match the register of where the text appears (see **About this text**): buttons and labels short, objectives as instructions, briefings and item descriptions natural and fluent.
- If the English is unclear, read the context, add a context note or ask before guessing. If the English itself looks wrong, say so in your suggestion note instead of fixing it in the translation.
- Keep the length close to the English. UI text has little room; when two wordings are equally good, take the shorter one.

## Text that is not English stays as written

- Some lines, mostly in Observer briefings and faction messages, mix in Vietnamese or Russian: `Quân Liên Lục Địa`, `bọn tây`, `Châu thổ`, `Сволочь`, `Жук`. Copy these exactly, with every accent, in every language. Do not translate, transliterate or "correct" them.
- The English explanation next to them, usually in square brackets (`[that means UICS]`), is translated as normal.
- A text with no English in it at all is copied unchanged.
- Personal names, call signs, faction codes (`FANG`, `UICS`, `IGC`, `VLF`), map names, weapon, brand and model names, calibers, key names and terminal commands stay as written. `Glossary.json` lists them.

## Punctuation

- **No dashes as punctuation.** Do not use the em dash (—), the en dash (–) or a double hyphen (--) to join or break sentences. Use a comma, colon, full stop or brackets, or rephrase. In Russian, write `это`, `является` or a colon instead of `X — Y`.
- Exception: dashes that are part of a document layout the English already has, such as separator lines (`-----`), document titles (`Quarry – Weather Data`) and command lists (`read – Open a file`). Copy those as they are.
- Hyphens inside words and names are fine (`AK-74M`, `5.56x45`, `semi-automatic`).
- Use your language's own quotation marks and punctuation: „…" in German, «…» in Russian and Spanish, 「…」 in Japanese, “…” in Chinese and Korean, ¿ and ¡ in Spanish.
- If the English is ALL CAPS, write German, Russian and Spanish in ALL CAPS too.

## Formatting the game needs

The editor and the checks enforce these; a translation that breaks them cannot be submitted.

- Keep every `{Placeholder}` (use the buttons in the editor). Move it where your grammar needs it.
- Keep the in-game formatting (red, bold, italic, redacted) on the matching words.
- Keep line breaks and leading or trailing spaces.
- Respect the character limit when a text shows one.
- Numbers are filled in by the game: phrase texts with `{Count}` so they read right for 1 and for many, e.g. "Items: {Count}" instead of a plural that only fits one case.

## Consistency

- Use the terms in `Glossary.json`. For anything else, search the editor and use the word the existing translations already use for the same thing (stash, intel, hideout, contract).
- For menus and settings, use the standard wording players know from other games in your language.
- Address the player informally and avoid gendered forms for them where your language allows; the operator can be anyone.
- German: informal "du". Spanish (Spain): Castilian, "tú". Russian: "ты" in dialogue. Korean: UI as short nouns, objectives as imperatives (…하라), briefings in formal 합쇼체. Japanese: concise UI, objectives as …しろ. Chinese (Simplified): concise.

## Voting and suggesting

- Vote on whether a text reads right in the game, not on personal taste. If you vote a translation down, suggest a better one or say what is wrong in a note.
- Add a short note to a suggestion: which term, which grammar rule, what context.
- Do not paste unchecked machine translation. The AI drafts are already there; a suggestion should be better than them.
- One person, one account. Do not vote on behalf of others or organise votes.
- Vote **Shouldn't be translated** only for text that is not meant for players (debug, placeholder, internal ids) or must stay identical in every language (a name, a code). Not for text that is simply hard to translate.
- No personal information or spoilers outside the text's own mission in screenshots.
- Be kind. Disagree in notes, not in votes against people; an admin makes the final call.
