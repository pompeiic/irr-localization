// Community translation editor. Repo files are the truth; Supabase holds suggestions and votes until an
// admin applies them to Areas/*.json with their own GitHub token (never stored anywhere but this browser).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const $ = (id) => document.getElementById(id);
const PAGE = 40;
const LS = { culture: "irrLoc.culture", token: "irrLoc.githubToken", guide: "irrLoc.guide" };
// Web-owned, like Glossary.json: Unreal's Full Sync makes each listed text culture-invariant so the gather drops it.
const EXCLUDED_FILE = "Excluded.json";

const VIEWS = [
  { id: "all", name: "All strings" },
  { id: "ai", name: "AI translated" },
  { id: "missing", name: "Untranslated" },
  { id: "human", name: "Human translated" },
  { id: "open", name: "Has suggestions" },
  { id: "review", name: "In review queue" },
  { id: "mine", name: "My suggestions" },
];
const ADMIN_VIEWS = [
  { id: "admin-queue", name: "Review queue" },
  { id: "admin-excluded", name: "Not localized" },
  { id: "admin-settings", name: "Settings" },
];

const state = {
  config: {}, sb: null, user: null, isAdmin: false,
  project: null, cultures: [], entries: [], bySlot: new Map(), categories: [],
  settings: { defaultThreshold: 3, requireBeatCurrent: true, cultures: {} },
  culture: "", view: "all", category: "", shown: PAGE,
  openForms: new Set(), picked: new Set(), excluded: new Map(), excludedPicked: new Set(),
  suggestions: new Map(), currentScores: new Map(), myVotes: new Map(), myCurrentVotes: new Map(),
  queueRows: [], queueSelected: new Set(), queueShowAll: false,
};

// ---------- helpers ----------

const slotOf = (e) => `${e.ns}\u001f${e.key}`;
const net = (o) => (o?.ups || 0) - (o?.downs || 0);
const signed = (n) => (n > 0 ? `+${n}` : String(n));

function fnv(text) {
  let hash = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) { hash ^= b; hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, "0");
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
// Native append/replaceChildren print null as text; h() already skips it.
const kids = (...c) => c.flat().filter((x) => x != null && x !== false);

let noticeTimer = 0;
function notice(message, kind = "", sticky = false) {
  const n = $("notice");
  n.textContent = message;
  n.className = kind;
  n.hidden = !message;
  clearTimeout(noticeTimer);
  if (message && !sticky) noticeTimer = setTimeout(() => (n.hidden = true), 7000);
}

const guarded = (fn) => async (...args) => {
  try { await fn(...args); } catch (e) { notice(e.message || String(e), "err"); }
};

const cultureName = (() => {
  const en = new Intl.DisplayNames(["en"], { type: "language" });
  return (c, native = true) => {
    try {
      const english = en.of(c);
      const own = native ? new Intl.DisplayNames([c], { type: "language" }).of(c) : "";
      return joinMeta(english || c, own && own !== english ? own : null);
    } catch { return c; }
  };
})();

const fmtDate = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d) ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
};
const joinMeta = (...parts) => parts.filter((p) => p != null && String(p).trim() !== "").join(" · ");

// ---------- rich text (Unreal <Tag>…</> markup, {Arguments}) ----------

const TAG_LABELS = {
  red: "Red", strong: "Bold", italic: "Italic", strongitalic: "Bold italic", italicstrong: "Bold italic",
  redacted: "Redacted", file_id: "File id", directory: "Path", fguid: "Id",
};
const tagLabel = (name) => TAG_LABELS[name.toLowerCase()] || name;

function parseRich(text) {
  const root = [];
  const stack = [root];
  let buf = "";
  const flush = () => { if (buf) { stack.at(-1).push({ t: "text", v: buf }); buf = ""; } };
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === "`" && i + 1 < text.length) { buf += text.slice(i, i + 2); i += 2; continue; }
    if (ch === "{") {
      const end = text.indexOf("}", i + 1);
      if (end > i) { flush(); stack.at(-1).push({ t: "arg", v: text.slice(i + 1, end) }); i = end + 1; continue; }
    }
    if (ch === "<") {
      if (text.startsWith("</>", i) && stack.length > 1) { flush(); stack.pop(); i += 3; continue; }
      const m = /^<([A-Za-z][\w-]*)((?:\s[^<>]*?)?)(\/?)>/.exec(text.slice(i));
      // An opener nothing closes is literal text, e.g. "cd <directory>" in the terminal help.
      if (m && (m[3] || text.slice(i + m[0].length).split("</>").length - 1 >= stack.length)) {
        flush();
        if (m[3]) stack.at(-1).push({ t: "atom", v: m[0] });
        else {
          const node = { t: "tag", name: m[1], attrs: m[2], c: [] };
          stack.at(-1).push(node);
          stack.push(node.c);
        }
        i += m[0].length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return root;
}

// Tags wrapping the whole text are applied automatically, so translators never see them.
function frameOf(text) {
  let nodes = parseRich(text);
  const wraps = [];
  while (nodes.length === 1 && nodes[0].t === "tag") { wraps.push(nodes[0]); nodes = nodes[0].c; }
  return { wraps, nodes };
}
const wrapWith = (inner, wraps) => wraps.reduceRight((s, w) => `<${w.name}${w.attrs}>${s}</>`, inner);

function renderRich(nodes) {
  const frag = document.createDocumentFragment();
  for (const n of nodes) {
    if (n.t === "text") frag.append(document.createTextNode(n.v));
    else if (n.t === "arg") frag.append(h("span", { class: "arg", contenteditable: "false", "data-arg": n.v, title: "Placeholder — the game fills this in" }, n.v || "{}"));
    else if (n.t === "atom") frag.append(h("span", { class: "arg", contenteditable: "false", "data-atom": n.v, title: n.v }, "◆"));
    else {
      const known = TAG_LABELS[n.name.toLowerCase()];
      const span = h("span", { class: `rt-${known ? n.name.toLowerCase() : "unknown"}`, "data-tag": n.name, "data-attrs": n.attrs || "", title: tagLabel(n.name) });
      span.append(renderRich(n.c));
      frag.append(span);
    }
  }
  return frag;
}

const richBlock = (text, cls = "rt") => { const el = h("span", { class: cls }); el.append(renderRich(parseRich(text))); return el; };

// Nested formatting does not exist in-game, so the innermost tag wins when serializing.
function serializeRich(root) {
  const runs = [];
  const walk = (node, tag) => {
    for (const n of node.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) runs.push({ v: n.nodeValue, tag });
      else if (n.nodeType === Node.ELEMENT_NODE) {
        if (n.dataset.arg != null) runs.push({ v: `{${n.dataset.arg}}`, tag });
        else if (n.dataset.atom != null) runs.push({ v: n.dataset.atom, tag });
        else if (n.tagName === "BR") runs.push({ v: "\n", tag });
        else {
          if ((n.tagName === "DIV" || n.tagName === "P") && runs.length) runs.push({ v: "\n", tag });
          walk(n, n.dataset.tag ? { name: n.dataset.tag, attrs: n.dataset.attrs || "" } : tag);
        }
      }
    }
  };
  walk(root, null);
  let out = "";
  let open = null;
  for (const r of runs) {
    if (!r.v) continue;
    const key = r.tag ? `<${r.tag.name}${r.tag.attrs}>` : null;
    if (key !== open) { if (open) out += "</>"; if (key) out += key; open = key; }
    out += r.v;
  }
  if (open) out += "</>";
  return out;
}

function collectTags(nodes, out = new Map()) {
  for (const n of nodes) if (n.t === "tag") { if (!out.has(n.name)) out.set(n.name, n.attrs); collectTags(n.c, out); }
  return out;
}
function collectArgs(nodes, out = new Set()) {
  for (const n of nodes) { if (n.t === "arg") out.add(n.v); if (n.t === "tag") collectArgs(n.c, out); }
  return out;
}

function createRichEditor(entry, initialText, onChange) {
  const src = frameOf(entry.source);
  const cur = initialText ? frameOf(initialText) : null;
  const sameWraps = cur && cur.wraps.map((w) => w.name).join() === src.wraps.map((w) => w.name).join();
  const startNodes = !cur ? [] : sameWraps ? cur.nodes : parseRich(initialText);

  const box = h("div", { class: "rich", contenteditable: "true", spellcheck: "true", lang: state.culture, "data-placeholder": `Type the ${cultureName(state.culture, false)} text…` });
  box.append(renderRich(startNodes));

  const getText = () => {
    let inner = serializeRich(box);
    if (!entry.source.endsWith("\n")) inner = inner.replace(/\n+$/, "");
    return wrapWith(inner, src.wraps);
  };
  const normalize = () => { const text = serializeRich(box); box.replaceChildren(renderRich(parseRich(text))); onChange(); };
  const selectionRange = () => {
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    return box.contains(range.commonAncestorContainer) ? range : null;
  };
  const unwrapAll = (frag) => frag.querySelectorAll("[data-tag]").forEach((el) => el.replaceWith(...el.childNodes));

  const bar = h("div", { class: "fmtbar" });
  for (const [name, attrs] of collectTags(src.nodes)) {
    bar.append(h("button", { class: "ghost small", title: `Select words, then click to mark them ${tagLabel(name)}`, onmousedown: (e) => e.preventDefault(), onclick: () => {
      const range = selectionRange();
      if (!range || range.collapsed) return notice(`Select the words that should be ${tagLabel(name)} first.`);
      const frag = range.extractContents();
      unwrapAll(frag);
      const span = h("span", { "data-tag": name, "data-attrs": attrs || "" });
      span.append(frag);
      range.insertNode(span);
      normalize();
    } }, tagLabel(name)));
  }
  if (bar.childNodes.length) {
    bar.append(h("button", { class: "ghost small", title: "Remove formatting from the selected words", onmousedown: (e) => e.preventDefault(), onclick: () => {
      const range = selectionRange();
      if (!range || range.collapsed) return notice("Select the words to clear first.");
      const frag = range.extractContents();
      unwrapAll(frag);
      range.insertNode(frag);
      normalize();
    } }, "Clear"));
  }
  const args = [...collectArgs(src.nodes)];
  if (args.length) {
    if (bar.childNodes.length) bar.append(h("span", { class: "sep" }));
    for (const a of args) {
      bar.append(h("button", { class: "ghost small", title: "Insert this placeholder at the cursor", onmousedown: (e) => e.preventDefault(), onclick: () => {
        const range = selectionRange();
        const chip = renderRich([{ t: "arg", v: a }]).firstChild;
        if (range) { range.deleteContents(); range.insertNode(chip); range.setStartAfter(chip); range.collapse(true); }
        else box.append(chip);
        onChange();
      } }, `+ ${a}`));
    }
  }

  box.addEventListener("input", onChange);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); document.execCommand("insertText", false, "\n"); }
  });
  box.addEventListener("paste", (e) => {
    e.preventDefault();
    document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
  });
  return { el: h("div", {}, bar.childNodes.length ? bar : null, box), getText };
}

// ---------- structure checks (same rules as scripts/validate.mjs + Unreal import) ----------

function formatArgs(text) {
  const args = new Set();
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "`") { i++; continue; }
    if (text[i] !== "{") continue;
    const end = text.indexOf("}", i + 1);
    if (end < 0) break;
    args.add(text.slice(i + 1, end));
    i = end;
  }
  return [...args].sort().join(",");
}
const closers = (text) => text.split("</>").length - 1;
function tagCounts(text, nodes = parseRich(text), c = new Map()) {
  for (const n of nodes) if (n.t === "tag") { c.set(n.name, (c.get(n.name) || 0) + 1); tagCounts(null, n.c, c); }
  return c;
}

function checkText(entry, text) {
  const inner = frameOf(text);
  if (!serializeText(inner.nodes).trim()) return ["Enter a translation."];
  const problems = [];
  const want = formatArgs(entry.source);
  if (formatArgs(text) !== want) problems.push(want ? `Keep every placeholder (use the buttons above): ${want.split(",").join(", ")}.` : "Remove the placeholders — the English text has none.");
  const a = tagCounts(entry.source);
  const b = tagCounts(text);
  const wraps = frameOf(entry.source).wraps;
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const auto = wraps.filter((w) => w.name === name).length;
    const need = (a.get(name) || 0) - auto;
    const have = (b.get(name) || 0) - auto;
    if (need !== have) problems.push(need ? `Mark ${need} part${need > 1 ? "s" : ""} as ${tagLabel(name)} (currently ${have}).` : `Remove the ${tagLabel(name)} formatting — the English text has none there.`);
  }
  if (!problems.length && closers(text) !== closers(entry.source)) problems.push("The formatting doesn't match the English text.");
  if (entry.maxLength > 0 && text.length > entry.maxLength) problems.push(`${text.length}/${entry.maxLength} characters — too long for this spot.`);
  return problems;
}
function serializeText(nodes) {
  return nodes.map((n) => (n.t === "text" ? n.v : n.t === "tag" ? serializeText(n.c) : "x")).join("");
}

// ---------- status ----------

function currentOf(entry, culture = state.culture) {
  const t = entry.t?.[culture];
  return t && t.text && t.status !== "untranslated" ? t : null;
}

const STATUS_TIPS = {
  none: "No translation yet — the game shows the English text here.",
  stale: "The English text changed after this was translated, so the game shows English until it is updated.",
  ai: "Machine translation. No person has checked it — vote on it or suggest a better one.",
  community: "A community suggestion an admin accepted after it passed the vote threshold.",
  human: "Entered by a person in the game's own localization files, or accepted by an admin.",
};

function describe(t) {
  if (!t) return { cls: "none", label: "Untranslated", tip: STATUS_TIPS.none };
  if (t.status === "stale") return { cls: "stale", label: "Outdated", tip: STATUS_TIPS.stale };
  if (t.status === "machine") return { cls: "ai", label: "AI · not human-checked", tip: STATUS_TIPS.ai };
  const by = t.by || "";
  if (by.startsWith("community:")) return { cls: "community", label: joinMeta("Community", by.slice(10).trim()), tip: STATUS_TIPS.community };
  return { cls: "human", label: t.status === "approved" ? "Approved" : "Human reviewed", tip: STATUS_TIPS.human };
}

// "Used as" label, derived from the property path in the origin; no label rather than a guess.
const USAGE = [
  [/Subtitles/, "Spoken subtitle"],
  [/Tool ?Tip/i, "Tooltip"],
  [/\bDebriefing\b/, "Mission debriefing"],
  [/\bBriefing\b/, "Mission briefing"],
  [/IRRMissionObjective[^.]*\.Description/, "Objective"],
  [/ItemAppearance\.Description|ItemDescription/, "Item description"],
  [/ItemAppearance\.(Name|Abbreviation)|ItemName/, "Item name"],
  [/InteractionText/, "Interaction prompt"],
  [/BP_TerminalSequence_Text|SystemArt/, "Terminal screen"],
  [/Commands\(\d+\)\.Commands\.Command/, "Terminal command"],
  [/\.Subject$/, "Message subject"],
  [/MessageText|NofityMessage|NotifyMessage|OnFailText/, "Notification"],
  [/Warning/, "Warning"],
  [/Hint/, "Hint"],
  [/TabText/, "Tab label"],
  [/Button/, "Button label"],
  [/Headline|OverrideTitle|(^|\.)Title$/, "Heading"],
  [/LabelSettings|LabelText/, "Label"],
  [/DisplayName|StatName|SlotName|ContextName/, "Name"],
  [/Description/, "Description"],
];
function usageOf(e) {
  const o = e.origin || "";
  if (!o.startsWith("/") || o.includes("[Script Bytecode]")) return null;
  const path = o.includes(":") ? o.slice(o.indexOf(":") + 1) : o.split(".").slice(2).join(".");
  return USAGE.find(([rx]) => rx.test(path))?.[1] ?? null;
}

const thresholdFor = (culture) => state.settings.cultures?.[culture] ?? state.settings.defaultThreshold;
const currentVoteKey = (entry, culture, text) => `${culture}|${slotOf(entry)}|${fnv(text)}`;

function currentScore(entry, culture = state.culture, scores = state.currentScores) {
  const t = currentOf(entry, culture);
  return t ? scores.get(currentVoteKey(entry, culture, t.text)) : null;
}

function passes(s, entry, curScore) {
  if (!entry || s.source_hash !== entry.sourceHash) return false;
  if (net(s) < thresholdFor(s.culture)) return false;
  return !state.settings.requireBeatCurrent || net(s) > net(curScore);
}

// ---------- categories ----------

function compileCategories(doc) {
  const rx = (list) => (list || []).map((p) => new RegExp(p, "i"));
  return { hidden: rx(doc.hidden), categories: (doc.categories || []).map((t) => ({ name: t.name, match: rx(t.match) })), fallback: doc.fallback || "Other" };
}
function categoryOf(compiled, entry) {
  const s = `${entry.area}|${entry.origin}`;
  if (compiled.hidden.some((r) => r.test(s))) return null;
  return compiled.categories.find((t) => t.match.some((r) => r.test(s)))?.name ?? compiled.fallback;
}

// ---------- Supabase ----------

async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

function displayNameOf(user) {
  const m = user?.user_metadata || {};
  return m.custom_claims?.global_name || m.full_name || m.name || m.user_name || user?.email || "Unknown";
}

async function applySession(session) {
  let user = session?.user ?? null;
  if (user?.is_anonymous) { await state.sb.auth.signOut(); user = null; }
  state.user = user;
  state.isAdmin = false;
  if (user) {
    const { data, error } = await state.sb.from("admins").select("user_id").eq("user_id", user.id);
    if (error) notice(`Could not check admin rights: ${error.message}`, "err", true);
    state.isAdmin = !!data?.length;
  }
  if (!state.isAdmin && state.view.startsWith("admin")) state.view = "all";
  renderAccount();
}

function requireMember() {
  if (!state.sb) throw new Error("Community features are not configured yet.");
  if (!state.user) throw new Error("Sign in with Discord to vote or suggest — one account, one vote.");
}

async function signIn() {
  if (!state.sb) throw new Error("Community features are not configured yet.");
  const { error } = await state.sb.auth.signInWithOAuth({ provider: "discord", options: { redirectTo: location.origin + location.pathname } });
  if (error) throw error;
}

async function loadCommunity() {
  state.suggestions = new Map();
  state.currentScores = new Map();
  state.myVotes = new Map();
  state.myCurrentVotes = new Map();
  if (!state.sb) return;
  const c = state.culture;
  const [sugg, scores] = await Promise.all([
    fetchAll(() => state.sb.from("open_suggestions").select("*").eq("culture", c).order("id")),
    fetchAll(() => state.sb.from("current_scores").select("*").eq("culture", c)),
  ]);
  for (const s of sugg) {
    const id = `${s.ns}\u001f${s.key}`;
    if (!state.suggestions.has(id)) state.suggestions.set(id, []);
    state.suggestions.get(id).push(s);
  }
  for (const r of scores) state.currentScores.set(`${c}|${r.ns}\u001f${r.key}|${r.text_hash}`, r);
  if (state.user) {
    const [mine, mineCurrent] = await Promise.all([
      fetchAll(() => state.sb.from("votes").select("suggestion_id,value").eq("voter", state.user.id)),
      fetchAll(() => state.sb.from("current_votes").select("ns,key,text_hash,value").eq("voter", state.user.id).eq("culture", c)),
    ]);
    for (const v of mine) state.myVotes.set(v.suggestion_id, v.value);
    for (const v of mineCurrent) state.myCurrentVotes.set(`${c}|${v.ns}\u001f${v.key}|${v.text_hash}`, v.value);
  }
}

function applyVoteDelta(target, before, after) {
  if (before > 0) target.ups--; else if (before < 0) target.downs--;
  if (after > 0) target.ups++; else if (after < 0) target.downs++;
}

async function voteSuggestion(s, value) {
  requireMember();
  const before = state.myVotes.get(s.id) || 0;
  const after = before === value ? 0 : value;
  const { error } = after
    ? await state.sb.from("votes").upsert({ suggestion_id: s.id, voter: state.user.id, value: after })
    : await state.sb.from("votes").delete().eq("suggestion_id", s.id).eq("voter", state.user.id);
  if (error) throw error;
  if (after) state.myVotes.set(s.id, after); else state.myVotes.delete(s.id);
  applyVoteDelta(s, before, after);
}

async function voteCurrent(entry, value) {
  requireMember();
  const c = state.culture;
  const text = currentOf(entry, c).text;
  const id = currentVoteKey(entry, c, text);
  const before = state.myCurrentVotes.get(id) || 0;
  const after = before === value ? 0 : value;
  const row = { ns: entry.ns, key: entry.key, culture: c, text_hash: fnv(text), voter: state.user.id };
  const { error } = after
    ? await state.sb.from("current_votes").upsert({ ...row, value: after })
    : await state.sb.from("current_votes").delete().match(row);
  if (error) throw error;
  if (after) state.myCurrentVotes.set(id, after); else state.myCurrentVotes.delete(id);
  if (!state.currentScores.has(id)) state.currentScores.set(id, { ups: 0, downs: 0 });
  applyVoteDelta(state.currentScores.get(id), before, after);
}

async function submitSuggestion(entry, text, note) {
  requireMember();
  const { data, error } = await state.sb.from("suggestions")
    .insert({ ns: entry.ns, key: entry.key, culture: state.culture, source_hash: entry.sourceHash, text, note })
    .select().single();
  if (error) throw error;
  const id = slotOf(entry);
  if (!state.suggestions.has(id)) state.suggestions.set(id, []);
  state.suggestions.get(id).push({ ...data, ups: 0, downs: 0 });
}

async function withdrawSuggestion(s) {
  const { error } = await state.sb.from("suggestions").delete().eq("id", s.id);
  if (error) throw error;
  dropSuggestionLocally(s);
}

function dropSuggestionLocally(s) {
  if (s.culture !== state.culture) return;
  const id = `${s.ns}\u001f${s.key}`;
  const list = (state.suggestions.get(id) || []).filter((x) => x.id !== s.id);
  if (list.length) state.suggestions.set(id, list); else state.suggestions.delete(id);
}

// ---------- header / sidebar ----------

function renderAccount() {
  const signedIn = !!state.user;
  $("signInBtn").hidden = signedIn || !state.sb;
  $("accountBtn").hidden = !signedIn;
  $("accountMenu").hidden = true;
  $("adminBtn").hidden = !state.isAdmin;
  $("adminNav").hidden = !state.isAdmin;
  if (signedIn) {
    $("accountBtn").textContent = `${displayNameOf(state.user)} ▾`;
    $("accountWho").textContent = `Signed in with Discord as ${displayNameOf(state.user)}${state.isAdmin ? " · admin" : ""}. User id: ${state.user.id}`;
  }
}

function matchesView(e, view) {
  const t = e.t?.[state.culture];
  const cur = currentOf(e);
  const sugg = state.suggestions.get(slotOf(e));
  switch (view) {
    case "ai": return t?.status === "machine";
    case "missing": return !cur || cur.status === "stale";
    case "human": return !!cur && (cur.status === "reviewed" || cur.status === "approved");
    case "open": return !!sugg?.length;
    case "review": return !!sugg?.some((s) => passes(s, e, currentScore(e)));
    case "mine": return !!state.user && !!sugg?.some((s) => s.author === state.user.id);
    default: return true;
  }
}

const isLive = (e) => !state.excluded.has(slotOf(e));

function renderSidebar() {
  const item = (name, count, active, onclick, attn) => h("button", { type: "button", class: `side-item${active ? " active" : ""}`, "aria-pressed": String(!!active), onclick },
    h("span", { class: "nm" }, name), count != null ? h("span", { class: `ct${attn ? " attn" : ""}` }, count.toLocaleString()) : null);
  const live = state.entries.filter(isLive);
  const toList = (fn) => () => { fn(); state.shown = PAGE; if (state.view.startsWith("admin")) state.view = "all"; renderAll(); };
  const inCategory = live.filter((e) => !state.category || e.category === state.category);
  $("views").replaceChildren(...VIEWS.filter((v) => v.id !== "mine" || state.user).map((v) =>
    item(v.name, inCategory.filter((e) => matchesView(e, v.id)).length, state.view === v.id, () => { state.view = v.id; state.shown = PAGE; renderAll(); })));
  const inView = live.filter((e) => matchesView(e, state.view.startsWith("admin") ? "all" : state.view));
  $("categoryList").replaceChildren(
    item("All categories", inView.length, !state.category && !state.view.startsWith("admin"), toList(() => (state.category = ""))),
    ...state.categories.map((t) => item(t, inView.filter((e) => e.category === t).length, state.category === t && !state.view.startsWith("admin"), toList(() => (state.category = t)))));
  const pending = [...state.excluded.keys()].filter((id) => state.bySlot.has(id)).length;
  $("adminViews").replaceChildren(...ADMIN_VIEWS.map((v) =>
    item(v.name, v.id === "admin-queue" ? state.queueRows.filter((r) => r.pass).length || null : v.id === "admin-excluded" ? pending || null : null, state.view === v.id, guarded(async () => {
      state.view = v.id;
      renderAll();
      if (v.id === "admin-queue") await loadQueue();
    }), true)));
}

// ---------- list ----------

function visibleEntries() {
  const q = $("search").value.trim().toLowerCase();
  return state.entries.filter((e) => {
    if (!isLive(e)) return false;
    if (state.category && e.category !== state.category) return false;
    if (!matchesView(e, state.view)) return false;
    if (!q) return true;
    const t = e.t?.[state.culture]?.text || "";
    return e.source.toLowerCase().includes(q) || t.toLowerCase().includes(q) || (state.isAdmin && `${e.key} ${e.origin}`.toLowerCase().includes(q));
  });
}

// Active filters, each removable; the language is always shown because every count depends on it.
function activeFilters() {
  const q = $("search").value.trim();
  const view = VIEWS.find((v) => v.id === state.view);
  return [
    view && view.id !== "all" ? { label: view.name, clear: () => (state.view = "all") } : null,
    state.category ? { label: `Category: ${state.category}`, clear: () => (state.category = "") } : null,
    q ? { label: `Search: “${q}”`, clear: () => ($("search").value = "") } : null,
  ].filter(Boolean);
}

function renderCountline(list) {
  const filters = activeFilters();
  const reset = (clear) => () => { clear(); state.shown = PAGE; renderAll(); };
  $("countline").replaceChildren(...kids(
    h("strong", {}, `${list.length.toLocaleString()} string${list.length === 1 ? "" : "s"}`),
    h("span", {}, "in"),
    h("span", { class: "flt lang", title: "Change the language at the top right" }, cultureName(state.culture)),
    ...filters.map((f) => h("button", { type: "button", class: "flt", title: "Remove this filter", "aria-label": `Remove filter ${f.label}`, onclick: reset(f.clear) }, f.label, h("span", { "aria-hidden": "true" }, " ✕"))),
    filters.length > 1 ? h("button", { type: "button", class: "linkbtn", onclick: reset(() => filters.forEach((f) => f.clear())) }, "Clear all") : null,
    state.sb ? null : h("span", { class: "hint" }, "Voting and suggestions are not enabled yet.")));
}

function renderList() {
  const list = visibleEntries();
  renderCountline(list);
  renderSelectionBar(list);
  const wrap = $("listWrap");
  if (!list.length) {
    const filters = activeFilters();
    wrap.replaceChildren(h("div", { class: "empty-state" },
      h("div", {}, filters.length ? "No strings match these filters." : "No strings here."),
      filters.length ? h("button", { type: "button", class: "ghost small", onclick: () => { filters.forEach((f) => f.clear()); state.shown = PAGE; renderAll(); } }, "Clear filters") : null));
    return;
  }
  const more = list.length > state.shown
    ? h("div", { class: "more" }, h("button", { type: "button", class: "ghost", onclick: () => { state.shown += PAGE; renderList(); } }, `Show more (${(list.length - state.shown).toLocaleString()} left)`))
    : null;
  wrap.replaceChildren(...kids(list.slice(0, state.shown).map(renderEntry), more));
}

function renderSelectionBar(list = visibleEntries()) {
  const bar = $("selbar");
  bar.hidden = !state.isAdmin || state.view.startsWith("admin");
  if (bar.hidden) return;
  const n = state.picked.size;
  const allOn = list.length > 0 && list.every((e) => state.picked.has(slotOf(e)));
  bar.replaceChildren(...kids(
    h("span", { class: "grow" }, n ? `${n} selected` : "Admin — tick texts, or search (asset paths work, e.g. InputActions/) and select everything matching."),
    list.length ? h("button", { class: "ghost small", onclick: () => { for (const e of list) allOn ? state.picked.delete(slotOf(e)) : state.picked.add(slotOf(e)); renderList(); } },
      allOn ? `Unselect ${list.length} matching` : `Select ${list.length} matching`) : null,
    n ? h("button", { class: "ghost small", onclick: () => { state.picked.clear(); renderList(); } }, "Clear") : null,
    h("button", { class: "danger small", disabled: !n, title: "Not a player-facing text — Unreal stops gathering it on its next Full Sync", onclick: guarded(async (ev) => {
      const entries = [...state.picked].map((id) => state.bySlot.get(id)).filter(Boolean);
      if (!confirm(`Stop localizing ${entries.length} text(s)? They disappear from the editor, and Unreal marks them not localizable on its next Full Sync.`)) return;
      ev.target.disabled = true;
      try { await setExcluded(entries, true); state.picked.clear(); } finally { ev.target.disabled = false; }
      renderAll();
    }) }, `Don't localize (${n})`)));
}

const VOTE_HELP = "Votes are community opinion, not a review. A suggestion goes to an admin once its score passes the threshold (and beats the current translation); the admin decides what ships.";

function voteBox(score, mine, onVote, disabledReason, what = "translation") {
  const ups = score?.ups || 0;
  const downs = score?.downs || 0;
  const dis = !state.sb || !!disabledReason;
  const why = disabledReason || (!state.sb ? "Community features are not configured yet." : !state.user ? "Sign in with Discord to vote." : "");
  const title = joinMeta(why, VOTE_HELP);
  return h("span", { class: "votes", role: "group", "aria-label": `Votes on this ${what}: ${ups} up, ${downs} down`, title },
    h("button", { type: "button", class: `up${mine === 1 ? " active" : ""}`, disabled: dis, "aria-pressed": String(mine === 1), "aria-label": `Vote up: this ${what} reads right (${ups})`, title: joinMeta(why, "Reads right in-game.", VOTE_HELP), onclick: guarded(() => onVote(1)) }, `▲ ${ups}`),
    h("span", { class: "net", title: "Score = up − down" }, signed(ups - downs)),
    h("button", { type: "button", class: `down${mine === -1 ? " active" : ""}`, disabled: dis, "aria-pressed": String(mine === -1), "aria-label": `Vote down: this ${what} has a problem (${downs})`, title: joinMeta(why, "Wrong, unnatural or broken.", VOTE_HELP), onclick: guarded(() => onVote(-1)) }, `▼ ${downs}`));
}

function renderEntry(e) {
  const c = state.culture;
  const id = slotOf(e);
  const cur = currentOf(e);
  const info = describe(cur);
  const curScore = currentScore(e);
  const sugg = [...(state.suggestions.get(id) || [])].sort((a, b) => net(b) - net(a) || a.id - b.id);
  const card = h("div", { class: `entry${state.picked.has(id) ? " picked" : ""}` });
  const refresh = () => { card.replaceWith(renderEntry(e)); renderSidebar(); };

  let pick = null;
  if (state.isAdmin) {
    pick = h("input", { type: "checkbox", class: "pick", checked: state.picked.has(id), title: "Select for bulk actions" });
    pick.addEventListener("change", () => {
      pick.checked ? state.picked.add(id) : state.picked.delete(id);
      card.classList.toggle("picked", pick.checked);
      renderSelectionBar();
    });
  }
  const usage = usageOf(e);
  const args = [...collectArgs(frameOf(e.source).nodes)];
  const adminWhere = state.isAdmin ? joinMeta(e.area, e.ns ? `${e.ns},${e.key}` : e.key) : "";
  card.append(
    h("div", { class: "head" }, pick,
      e.category ? h("span", { class: "cat" }, e.category) : null,
      usage ? h("span", { class: "ctx", title: "Where this text is used, read from the game data" }, usage) : null,
      e.maxLength > 0 ? h("span", { class: "ctx limit", title: "Longer text will not fit where the game shows it" }, `Max ${e.maxLength} chars`) : null,
      state.isAdmin && e.origin ? h("span", { class: "origin", title: joinMeta(adminWhere, e.origin) }, e.origin) : null),
    h("div", { class: "pair" },
      h("section", { class: "src", "aria-label": "English source" },
        h("div", { class: "lbl" }, "English · source"),
        h("div", { class: "source", lang: "en" }, richBlock(e.source))),
      h("section", { class: `tgt ${info.cls}`, "aria-label": `Current ${cultureName(c, false)} translation` },
        h("div", { class: "lbl" }, h("span", { class: "grow" }, cultureName(c, false)),
          h("span", { class: `sb ${info.cls}`, title: info.tip, tabindex: "0", role: "note", "aria-label": `${info.label}: ${info.tip}` }, info.label)),
        h("div", { class: `text${cur ? "" : " empty"}`, lang: cur ? c : null }, cur ? richBlock(cur.text) : "No translation yet — the game shows the English text."),
        cur ? h("div", { class: "rowline" }, voteBox(curScore, state.myCurrentVotes.get(currentVoteKey(e, c, cur.text)), async (v) => { await voteCurrent(e, v); refresh(); })) : null)));
  const context = [
    args.length ? h("span", { class: "keep", title: "Placeholders the game fills in. Keep each one — the editor offers them as buttons." }, "Keep unchanged:", ...args.map((a) => renderRich([{ t: "arg", v: a }]))) : null,
    e.note ? h("span", { class: "devnote" }, e.note) : null,
  ].filter(Boolean);
  if (context.length) card.append(h("div", { class: "context" }, ...context));
  if (sugg.length) card.append(h("div", { class: "suggestions" }, h("div", { class: "lbl" }, `Suggestions (${sugg.length})`), ...sugg.map((s) => renderSuggestion(e, s, curScore, refresh))));
  if (state.openForms.has(id)) {
    card.append(renderForm(e, cur, () => { state.openForms.delete(id); refresh(); }));
  } else {
    card.append(h("div", { class: "actions" }, h("button", { type: "button", class: "suggest", "aria-expanded": "false", onclick: () => { state.openForms.add(id); refresh(); } },
      sugg.length ? "Suggest another translation" : cur ? "Suggest translation" : "Add translation")));
  }
  return card;
}

function renderSuggestion(entry, s, curScore, refresh) {
  const outdated = s.source_hash !== entry.sourceHash;
  const mine = state.user && s.author === state.user.id;
  return h("div", { class: `sugg${outdated ? " outdated" : ""}` },
    h("div", { class: "stext", lang: s.culture }, richBlock(s.text)),
    s.note ? h("div", { class: "note" }, s.note) : null,
    h("div", { class: "rowline" },
      voteBox(s, state.myVotes.get(s.id), async (v) => { await voteSuggestion(s, v); refresh(); }, mine ? "You can't vote on your own suggestion." : null, "suggestion"),
      h("span", { class: "grow" }, joinMeta(s.author_name, fmtDate(s.created_at))),
      outdated ? h("span", { class: "sb outdated", title: "The English text changed after this was suggested." }, "Outdated") : null,
      passes(s, entry, curScore) ? h("span", { class: "sb pass" }, "In review") : null,
      mine ? h("button", { class: "linkbtn", onclick: guarded(async () => { await withdrawSuggestion(s); refresh(); }) }, "Withdraw") : null,
      state.isAdmin ? h("button", { class: "linkbtn", onclick: guarded(async () => { await applySuggestions([s]); }) }, "Apply") : null,
      state.isAdmin ? h("button", { class: "linkbtn", onclick: guarded(async () => { await rejectSuggestions([s]); }) }, "Reject") : null,
      state.isAdmin && !mine ? h("button", { class: "linkbtn danger", onclick: guarded(async () => { await banAuthor(s); }) }, "Ban") : null));
}

function renderForm(entry, cur, close) {
  const cancel = h("button", { class: "ghost small", onclick: close }, "Cancel");
  if (!state.sb) return h("div", { class: "form signin-box" }, "Suggestions open once the community backend is configured.", h("br"), cancel);
  if (!state.user) {
    return h("div", { class: "form signin-box" }, "Sign in with Discord to vote and suggest translations. One account, one vote — your Discord name is shown on your suggestions.",
      h("div", { class: "rowline" }, h("button", { class: "discord", onclick: guarded(signIn) }, "Sign in with Discord"), cancel));
  }
  const problems = h("div", { class: "problems" });
  const submit = h("button", { class: "primary small" }, "Submit");
  const editor = createRichEditor(entry, cur?.text || "", () => check());
  const note = h("input", { type: "text", maxlength: "1000", placeholder: "Note (optional) — why this is better, context, terminology…" });
  function check() {
    const text = editor.getText();
    const p = checkText(entry, text);
    if (!p.length && cur && text === cur.text) p.push("Change the text to suggest something new.");
    problems.replaceChildren(...p.map((x) => h("div", {}, x)));
    submit.disabled = p.length > 0;
  }
  submit.addEventListener("click", guarded(async () => {
    submit.disabled = true;
    try { await submitSuggestion(entry, editor.getText(), note.value.trim()); notice("Thanks — your suggestion is up for votes.", "ok"); close(); }
    finally { submit.disabled = false; }
  }));
  queueMicrotask(check);
  return h("div", { class: "form" }, editor.el, h("div", { style: "margin-top:6px" }, note), problems,
    h("div", { class: "formfoot" }, h("span", { class: "hint grow" }, `Suggesting as ${displayNameOf(state.user)}`), cancel, submit));
}

// ---------- GitHub (admin) ----------

async function gh(path, init = {}) {
  const token = localStorage.getItem(LS.token);
  if (!token) throw new Error("Add your GitHub token under Admin → Settings first.");
  const r = await fetch(`https://api.github.com/repos/${state.config.repo}${path ? `/${path}` : ""}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (!r.ok) {
    const err = new Error(`GitHub ${r.status}: ${(await r.json().catch(() => ({}))).message || r.statusText}`);
    err.status = r.status;
    throw err;
  }
  return r.status === 204 ? null : r.json();
}

const b64ToUtf8 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (ch) => ch.charCodeAt(0)));
function utf8ToB64(text) {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Unreal's pretty-printer layout (tabs, object values on their own line) so an apply diff stays small.
function ueJson(value, eol, depth = 0) {
  const ind = (n) => "\t".repeat(n);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[${eol}${value.map((v) => ind(depth + 1) + ueJson(v, eol, depth + 1)).join(`,${eol}`)}${eol}${ind(depth)}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (!keys.length) return "{}";
    const parts = keys.map((k) => {
      const v = value[k];
      const head = `${ind(depth + 1)}${JSON.stringify(k)}:`;
      return v && typeof v === "object" && !Array.isArray(v) ? `${head}${eol}${ind(depth + 1)}${ueJson(v, eol, depth + 1)}` : `${head} ${ueJson(v, eol, depth + 1)}`;
    });
    return `{${eol}${parts.join(`,${eol}`)}${eol}${ind(depth)}}`;
  }
  return JSON.stringify(value);
}

async function commitFiles(buildChanges, message) {
  const branch = state.config.branch || "main";
  for (let attempt = 0; attempt < 2; attempt++) {
    const ref = await gh(`git/ref/heads/${branch}`);
    const head = await gh(`git/commits/${ref.object.sha}`);
    const tree = await gh(`git/trees/${head.tree.sha}?recursive=1`);
    const readFile = async (path) => {
      const node = tree.tree.find((n) => n.path === path && n.type === "blob");
      return node ? b64ToUtf8((await gh(`git/blobs/${node.sha}`)).content) : null;
    };
    const changes = await buildChanges(readFile);
    if (!changes.length) return false;
    const blobs = [];
    for (const { path, content } of changes) {
      const blob = await gh("git/blobs", { method: "POST", body: JSON.stringify({ content: utf8ToB64(content), encoding: "base64" }) });
      blobs.push({ path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const newTree = await gh("git/trees", { method: "POST", body: JSON.stringify({ base_tree: head.tree.sha, tree: blobs }) });
    const commit = await gh("git/commits", { method: "POST", body: JSON.stringify({ message, tree: newTree.sha, parents: [ref.object.sha] }) });
    try {
      await gh(`git/refs/heads/${branch}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }) });
      return true;
    } catch (e) {
      if (e.status !== 422 || attempt) throw e;
    }
  }
  return false;
}

// Picks the best selected suggestion per slot, re-checks it against the live file, commits once.
async function applySuggestions(list) {
  if (!state.isAdmin) throw new Error("Admin only.");
  const best = new Map();
  for (const s of list) {
    const id = `${s.culture}|${s.ns}\u001f${s.key}`;
    if (!best.has(id) || net(s) > net(best.get(id))) best.set(id, s);
  }
  const chosen = [...best.values()];
  const byFile = new Map();
  for (const s of chosen) {
    const entry = state.bySlot.get(`${s.ns}\u001f${s.key}`);
    if (!entry) continue;
    if (!byFile.has(entry.file)) byFile.set(entry.file, []);
    byFile.get(entry.file).push(s);
  }
  let applied = [];
  const skipped = [];
  const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const cultures = [...new Set(chosen.map((s) => s.culture))].join(", ");
  const done = await commitFiles(async (readFile) => {
    applied = [];
    skipped.length = 0;
    const changes = [];
    for (const [file, items] of byFile) {
      const raw = await readFile(file);
      if (raw == null) { skipped.push(...items.map((s) => [s, "area file no longer exists"])); continue; }
      const doc = JSON.parse(raw);
      const index = new Map(doc.entries.map((e) => [slotOf(e), e]));
      let touched = false;
      for (const s of items) {
        const e = index.get(`${s.ns}\u001f${s.key}`);
        if (!e || e.sourceHash !== s.source_hash) { skipped.push([s, "English text changed"]); continue; }
        const problems = checkText(e, s.text);
        if (problems.length) { skipped.push([s, problems[0]]); continue; }
        e.t = e.t || {};
        e.t[s.culture] = { text: s.text, status: "reviewed", by: `community:${s.author_name}`, at };
        applied.push(s);
        touched = true;
      }
      if (!touched) continue;
      const eol = raw.includes("\r\n") ? "\r\n" : "\n";
      changes.push({ path: file, content: ueJson(doc, eol) + raw.match(/\s*$/)[0] });
    }
    return changes;
  }, `Apply community suggestions from the web editor (${cultures})`);

  if (done && applied.length) {
    const { error } = await state.sb.from("suggestions").update({ status: "applied", resolved_at: new Date().toISOString() }).in("id", applied.map((s) => s.id));
    if (error) notice(`Committed, but marking suggestions as applied failed: ${error.message}`, "err", true);
    for (const s of applied) {
      const entry = state.bySlot.get(`${s.ns}\u001f${s.key}`);
      entry.t = entry.t || {};
      entry.t[s.culture] = { text: s.text, status: "reviewed", by: `community:${s.author_name}`, at };
      dropSuggestionLocally(s);
    }
  }
  const why = skipped.map(([s, reason]) => `${s.culture} "${s.text.slice(0, 30)}": ${reason}`).join("; ");
  notice(`${applied.length} applied${skipped.length ? `, ${skipped.length} skipped (${why})` : ""}.` + (applied.length ? " The site updates in about a minute; Unreal picks it up on its next sync." : ""),
    skipped.length && !applied.length ? "err" : "ok", skipped.length > 0);
  if (state.view === "admin-queue") await loadQueue();
  renderAll();
}

async function rejectSuggestions(list) {
  if (!state.isAdmin) throw new Error("Admin only.");
  const { error } = await state.sb.from("suggestions").update({ status: "rejected", resolved_at: new Date().toISOString() }).in("id", list.map((s) => s.id));
  if (error) throw error;
  list.forEach(dropSuggestionLocally);
  notice(`${list.length} rejected.`, "ok");
  if (state.view === "admin-queue") await loadQueue();
  renderAll();
}

async function banAuthor(s) {
  if (!confirm(`Ban "${s.author_name}" and reject all their open suggestions?`)) return;
  const { error } = await state.sb.from("bans").upsert({ user_id: s.author, reason: `via suggestion ${s.id}` });
  if (error) throw error;
  const { data, error: e2 } = await state.sb.from("suggestions").update({ status: "rejected", resolved_at: new Date().toISOString() })
    .eq("author", s.author).eq("status", "open").select("id,ns,key,culture");
  if (e2) throw e2;
  (data || []).forEach(dropSuggestionLocally);
  notice(`Banned ${s.author_name}; ${data?.length || 0} suggestion(s) rejected.`, "ok");
  renderAll();
}

// Adds (or removes) texts on the don't-localize list in one commit; records carry ns/key.
async function setExcluded(records, exclude) {
  if (!state.isAdmin) throw new Error("Admin only.");
  const by = displayNameOf(state.user);
  const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const changed = await commitFiles(async (readFile) => {
    const raw = await readFile(EXCLUDED_FILE);
    const doc = raw ? JSON.parse(raw) : {};
    const index = new Map((doc.entries || []).map((x) => [slotOf(x), x]));
    for (const r of records) {
      if (!exclude) index.delete(slotOf(r));
      else if (!index.has(slotOf(r))) index.set(slotOf(r), { ns: r.ns, key: r.key, source: r.source, origin: r.origin, by, at });
    }
    const entries = [...index.values()].sort((a, b) => a.origin.localeCompare(b.origin) || a.key.localeCompare(b.key));
    const content = `${ueJson({ entries }, "\r\n")}\r\n`;
    return content === raw ? [] : [{ path: EXCLUDED_FILE, content }];
  }, exclude ? `Don't localize ${records.length} text(s) (web editor)` : `Localize ${records.length} text(s) again (web editor)`);
  for (const r of records) {
    if (exclude) state.excluded.set(slotOf(r), state.excluded.get(slotOf(r)) || { ns: r.ns, key: r.key, source: r.source, origin: r.origin, by, at });
    else state.excluded.delete(slotOf(r));
  }
  notice(!changed ? "Nothing changed." : exclude
    ? `${records.length} text(s) marked "don't localize". Unreal makes them not localizable on its next Full Sync.`
    : `${records.length} text(s) are localized again.`, "ok");
}

function renderExcludedView() {
  const rows = [...state.excluded.values()].map((r) => ({ r, pending: state.bySlot.has(slotOf(r)) }));
  const picked = state.excludedPicked;
  for (const id of [...picked]) if (!rows.some((x) => x.pending && slotOf(x.r) === id)) picked.delete(id);
  const pendingRows = rows.filter((x) => x.pending);
  const bar = h("div", { class: "rowline" },
    h("span", { class: "hint grow" }, "Texts the web editor hides. Until Unreal's next Full Sync they can still be localized again; after it, the asset itself is changed — re-tick Localize on the text in Unreal to undo."),
    h("button", { class: "ghost small", disabled: !pendingRows.length, onclick: () => {
      const allOn = pendingRows.every((x) => picked.has(slotOf(x.r)));
      state.excludedPicked = new Set(allOn ? [] : pendingRows.map((x) => slotOf(x.r)));
      renderAdminView();
    } }, "Select all waiting"),
    h("button", { class: "primary small", disabled: !picked.size, onclick: guarded(async (ev) => {
      const records = [...picked].map((id) => state.excluded.get(id)).filter(Boolean);
      ev.target.disabled = true;
      try { await setExcluded(records, false); picked.clear(); } finally { ev.target.disabled = false; }
      renderAll();
    }) }, `Localize again (${picked.size})`));
  const card = h("div", { class: "card" }, h("h3", {}, "Not localized"), bar);
  if (!rows.length) card.append(h("div", { class: "empty-state" }, "Nothing excluded. Select texts in the list and use \"Don't localize\"."));
  else {
    const table = h("table", { class: "queue" }, h("tr", {}, h("th", {}, ""), h("th", {}, "English"), h("th", {}, "Asset"), h("th", {}, "By"), h("th", {}, "State")));
    for (const { r, pending } of rows.sort((a, b) => b.pending - a.pending || a.r.origin.localeCompare(b.r.origin))) {
      const id = slotOf(r);
      const check = h("input", { type: "checkbox", checked: picked.has(id), disabled: !pending });
      check.addEventListener("change", () => { check.checked ? picked.add(id) : picked.delete(id); renderAdminView(); });
      table.append(h("tr", { class: pending ? "" : "outdated" },
        h("td", {}, check),
        h("td", { class: "t" }, richBlock(r.source || "")),
        h("td", {}, h("div", { class: "sub" }, r.origin)),
        h("td", {}, h("div", { class: "sub" }, joinMeta(r.by, fmtDate(r.at)) || "—")),
        h("td", { class: "num" }, pending ? "Waiting for Unreal sync" : "Done in Unreal")));
    }
    card.append(table);
  }
  return card;
}

// ---------- admin views ----------

async function loadQueue() {
  if (!state.isAdmin) return;
  const [sugg, scores] = await Promise.all([
    fetchAll(() => state.sb.from("open_suggestions").select("*").order("id")),
    fetchAll(() => state.sb.from("current_scores").select("*")),
  ]);
  const scoreMap = new Map(scores.map((r) => [`${r.culture}|${r.ns}\u001f${r.key}|${r.text_hash}`, r]));
  let rows = [];
  for (const s of sugg) {
    const entry = state.bySlot.get(`${s.ns}\u001f${s.key}`);
    const cur = entry ? currentScore(entry, s.culture, scoreMap) : null;
    rows.push({ s, entry, cur, pass: passes(s, entry, cur), outdated: !entry || entry.sourceHash !== s.source_hash });
  }
  if (!state.queueShowAll) {
    const best = new Map();
    for (const r of rows.filter((x) => x.pass)) {
      const id = `${r.s.culture}|${r.s.ns}\u001f${r.s.key}`;
      if (!best.has(id) || net(r.s) > net(best.get(id).s)) best.set(id, r);
    }
    rows = [...best.values()];
  }
  rows.sort((a, b) => a.s.culture.localeCompare(b.s.culture) || net(b.s) - net(a.s));
  state.queueRows = rows;
  state.queueSelected = new Set([...state.queueSelected].filter((id) => rows.some((r) => r.s.id === id)));
  if (state.view === "admin-queue") renderAdminView();
  renderSidebar();
}

const selectedQueue = () => state.queueRows.filter((r) => state.queueSelected.has(r.s.id)).map((r) => r.s);

function renderAdminView() {
  const box = $("adminView");
  if (state.view === "admin-settings") { box.replaceChildren(renderSettingsView()); return; }
  if (state.view === "admin-excluded") { box.replaceChildren(renderExcludedView()); return; }
  const rows = state.queueRows;
  const showAll = h("input", { type: "checkbox", checked: state.queueShowAll });
  showAll.addEventListener("change", guarded(async () => { state.queueShowAll = showAll.checked; await loadQueue(); }));
  const bar = h("div", { class: "rowline" },
    h("span", { class: "hint grow" }, state.queueShowAll ? "Every open suggestion." : "Best suggestion per text that reached its threshold and beats the current translation."),
    h("label", { class: "hint" }, showAll, " Show all open"),
    h("button", { class: "ghost small", onclick: guarded(loadQueue) }, "Refresh"),
    h("button", { class: "ghost small", onclick: () => {
      const eligible = rows.filter((r) => !r.outdated);
      const allOn = eligible.length && eligible.every((r) => state.queueSelected.has(r.s.id));
      state.queueSelected = new Set(allOn ? [] : eligible.map((r) => r.s.id));
      renderAdminView();
    } }, "Select all"),
    h("button", { class: "danger small", onclick: guarded(async () => {
      const list = selectedQueue();
      if (!list.length) throw new Error("Select suggestions first.");
      if (!confirm(`Reject ${list.length} suggestion(s)?`)) return;
      await rejectSuggestions(list);
      state.queueSelected.clear();
    }) }, "Reject selected"),
    h("button", { class: "primary small", onclick: guarded(async (ev) => {
      const list = selectedQueue();
      if (!list.length) throw new Error("Select suggestions first.");
      if (!confirm(`Apply ${list.length} suggestion(s) to the repo?`)) return;
      ev.target.disabled = true;
      try { await applySuggestions(list); state.queueSelected.clear(); } finally { ev.target.disabled = false; }
    }) }, `Apply selected (${state.queueSelected.size})`));

  const card = h("div", { class: "card" }, h("h3", {}, "Review queue"), bar);
  if (!rows.length) card.append(h("div", { class: "empty-state" }, state.queueShowAll ? "No open suggestions." : "Nothing has reached the threshold yet."));
  else {
    const table = h("table", { class: "queue" }, h("tr", {}, h("th", {}, ""), h("th", {}, "Lang"), h("th", {}, "English"), h("th", {}, "Current"), h("th", {}, "Suggestion"), h("th", {}, "Score"), h("th", {}, "Needs")));
    for (const r of rows) {
      const { s, entry, cur } = r;
      const t = entry ? currentOf(entry, s.culture) : null;
      const check = h("input", { type: "checkbox", checked: state.queueSelected.has(s.id), disabled: r.outdated });
      check.addEventListener("change", () => { check.checked ? state.queueSelected.add(s.id) : state.queueSelected.delete(s.id); renderAdminView(); });
      const need = Math.max(thresholdFor(s.culture), state.settings.requireBeatCurrent ? net(cur) + 1 : 0);
      table.append(h("tr", { class: r.outdated ? "outdated" : "" },
        h("td", {}, check),
        h("td", {}, s.culture),
        h("td", { class: "t" }, entry ? richBlock(entry.source) : "(string removed)", entry ? h("div", { class: "sub" }, entry.origin) : null),
        h("td", { class: "t" }, t ? [h("span", { class: `sb ${describe(t).cls}` }, describe(t).label), h("br"), richBlock(t.text)] : h("span", { class: "hint" }, "untranslated")),
        h("td", { class: "t" }, richBlock(s.text), s.note ? h("div", { class: "sub" }, s.note) : null, h("div", { class: "sub" }, joinMeta(s.author_name, fmtDate(s.created_at), r.outdated ? "outdated" : null))),
        h("td", { class: "num" }, `${signed(net(s))} (${s.ups}/${s.downs})`, cur ? h("div", { class: "sub" }, `current ${signed(net(cur))}`) : null),
        h("td", { class: "num" }, r.pass ? "✓" : `≥ ${need}`)));
    }
    card.append(table);
  }
  box.replaceChildren(card);
}

function renderSettingsView() {
  const tokenIn = h("input", { type: "password", placeholder: "github_pat_…", autocomplete: "off" });
  const tokenState = h("div", { class: "hint" }, localStorage.getItem(LS.token) ? "Checking token…" : "No token saved.");
  const checkToken = async () => {
    if (!localStorage.getItem(LS.token)) { tokenState.textContent = "No token saved."; return; }
    try {
      const repo = await gh("");
      tokenState.textContent = repo.permissions?.push ? `Token can write to ${repo.full_name} ✓` : `Token can read ${repo.full_name} but not write.`;
    } catch (e) { tokenState.textContent = e.message; }
  };
  checkToken();
  const tokenCard = h("div", { class: "card" }, h("h3", {}, "GitHub token"),
    h("div", { class: "hint" }, "Fine-grained token for this repo with Contents: read/write. Used to apply suggestions and save thresholds; kept only in this browser."),
    h("div", { class: "rowline", style: "margin-top:8px" }, tokenIn,
      h("button", { class: "small", onclick: guarded(async () => { const v = tokenIn.value.trim(); if (v) localStorage.setItem(LS.token, v); tokenIn.value = ""; await checkToken(); }) }, "Save"),
      h("button", { class: "ghost small", onclick: guarded(async () => { localStorage.removeItem(LS.token); await checkToken(); }) }, "Forget")),
    tokenState);

  const s = state.settings;
  const saved = h("span", { class: "hint grow" });
  const dirty = () => (saved.textContent = "Unsaved changes");
  const def = h("input", { type: "number", min: "1", step: "1", value: s.defaultThreshold });
  def.addEventListener("input", () => { s.defaultThreshold = Math.max(1, parseInt(def.value, 10) || 1); dirty(); });
  const beat = h("input", { type: "checkbox", checked: s.requireBeatCurrent });
  beat.addEventListener("change", () => { s.requireBeatCurrent = beat.checked; dirty(); });
  const grid = h("div", { id: "thresholds" }, h("span", {}, "Default net score"), def, h("span", {}, "Must outscore the current translation"), beat);
  for (const c of state.cultures) {
    const input = h("input", { type: "number", min: "1", step: "1", placeholder: String(s.defaultThreshold), value: s.cultures?.[c] ?? "" });
    input.addEventListener("input", () => {
      const v = parseInt(input.value, 10);
      s.cultures = s.cultures || {};
      if (v > 0) s.cultures[c] = v; else delete s.cultures[c];
      dirty();
    });
    grid.append(h("span", {}, cultureName(c)), input);
  }
  const thresholdCard = h("div", { class: "card" }, h("h3", {}, "Acceptance threshold"),
    h("div", { class: "hint" }, "A suggestion enters the review queue at net score (up − down) ≥ threshold. Leave a language empty to use the default."),
    grid,
    h("div", { class: "rowline", style: "margin-top:10px" }, saved, h("button", { class: "primary small", onclick: guarded(async () => {
      const clean = { defaultThreshold: s.defaultThreshold, requireBeatCurrent: !!s.requireBeatCurrent, cultures: s.cultures || {} };
      const ok = await commitFiles(async () => [{ path: "community/settings.json", content: `${JSON.stringify(clean, null, "\t")}\n` }], "Update community acceptance thresholds");
      saved.textContent = ok ? "Saved to the repo." : "No change.";
      await loadQueue();
    }) }, "Save to repo")));
  return h("div", { class: "grid2" }, tokenCard, thresholdCard);
}

// ---------- render ----------

function renderGuide() {
  const chip = (cls, label) => h("span", { class: `sb ${cls}` }, label);
  const need = thresholdFor(state.culture);
  $("guideBody").replaceChildren(
    h("dl", {},
      h("dt", {}, chip("ai", describe({ status: "machine", by: "ai" }).label)), h("dd", {}, STATUS_TIPS.ai),
      h("dt", {}, chip("human", "Human reviewed")), h("dd", {}, STATUS_TIPS.human),
      h("dt", {}, chip("community", "Community")), h("dd", {}, STATUS_TIPS.community),
      h("dt", {}, chip("none", "Untranslated")), h("dd", {}, STATUS_TIPS.none),
      h("dt", {}, h("span", { class: "votes" }, h("span", { class: "net" }, "▲ ▼"))),
      h("dd", {}, `Votes are community opinion, not a review. A suggestion needs a score of ${signed(need)} for ${cultureName(state.culture, false)}${state.settings.requireBeatCurrent ? " and must beat the current translation's score" : ""} to reach the admin queue; an admin makes the final call. Voting on a translation does not change its status.`)));
}

// Language, view and category live in the URL so a filtered list can be linked.
function writeUrl() {
  const p = new URLSearchParams(location.search);
  const set = (k, v) => (v ? p.set(k, v) : p.delete(k));
  set("lang", state.culture);
  set("view", state.view !== "all" && !state.view.startsWith("admin") ? state.view : "");
  set("cat", state.category);
  const qs = p.toString();
  history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
}

function renderAll() {
  const admin = state.view.startsWith("admin");
  $("listWrap").hidden = admin;
  $("toolbar").querySelector(".trow").hidden = admin;
  $("countline").hidden = admin;
  $("guide").hidden = admin;
  renderGuide();
  writeUrl();
  $("adminView").hidden = !admin;
  $("search").placeholder = state.isAdmin ? "Search English, translation, key or asset path…" : "Search English or translation…";
  renderSidebar();
  if (admin) { $("selbar").hidden = true; renderAdminView(); } else renderList();
}

// ---------- boot ----------

async function fetchJson(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`Could not load ${path} (${r.status}).`);
  return r.json();
}

async function boot() {
  const [config, settings, categories, excluded, project] = await Promise.all([
    fetchJson("community/config.json").catch(() => ({})),
    fetchJson("community/settings.json").catch(() => ({})),
    fetchJson("community/categories.json").catch(() => ({})),
    fetchJson(EXCLUDED_FILE).catch(() => ({})),
    fetchJson("Project.json"),
  ]);
  state.config = config;
  state.settings = { ...state.settings, ...settings };
  state.project = project;
  state.cultures = project.cultures;
  state.excluded = new Map((excluded.entries || []).map((x) => [slotOf(x), x]));
  const compiled = compileCategories(categories);

  const docs = await Promise.all(project.areas.map((a) => fetchJson(a.file).then((d) => ({ a, d }))));
  const seen = new Set();
  for (const { a, d } of docs) {
    for (const e of d.entries) {
      e.area = a.area;
      e.file = a.file;
      e.category = categoryOf(compiled, e);
      if (!e.category) continue;
      seen.add(e.category);
      state.entries.push(e);
      state.bySlot.set(slotOf(e), e);
    }
  }
  state.categories = [...compiled.categories.map((t) => t.name), compiled.fallback].filter((t) => seen.has(t));

  const params = new URLSearchParams(location.search);
  const urlLang = params.get("lang");
  if (VIEWS.some((v) => v.id === params.get("view"))) state.view = params.get("view");
  if (state.categories.includes(params.get("cat"))) state.category = params.get("cat");
  const saved = localStorage.getItem(LS.culture);
  const browser = state.cultures.find((c) => navigator.language?.toLowerCase().startsWith(c.split("-")[0].toLowerCase()));
  state.culture = [urlLang, saved, browser, state.cultures[0]].find((c) => c && state.cultures.includes(c));
  const sel = $("culture");
  sel.replaceChildren(...state.cultures.map((c) => h("option", { value: c, selected: c === state.culture }, cultureName(c))));

  if (config.supabaseUrl && config.supabaseAnonKey) {
    state.sb = createClient(config.supabaseUrl, config.supabaseAnonKey, { auth: { persistSession: true, detectSessionInUrl: true, flowType: "pkce" } });
    const { data } = await state.sb.auth.getSession();
    await applySession(data.session);
    state.sb.auth.onAuthStateChange((event, session) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT") return;
      setTimeout(guarded(async () => { await applySession(session); await loadCommunity(); await loadQueue(); renderAll(); }), 0);
    });
    try { await loadCommunity(); await loadQueue(); } catch (e) { notice(`Could not load suggestions: ${e.message}`, "err", true); }
  } else {
    notice("Browsing only — voting and suggestions are not switched on yet.", "", true);
  }
  renderAccount();

  sel.addEventListener("change", guarded(async () => {
    state.culture = sel.value;
    localStorage.setItem(LS.culture, state.culture);
    state.shown = PAGE;
    await loadCommunity();
    renderAll();
  }));
  let searchTimer = 0;
  $("search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.shown = PAGE; renderList(); }, 150); });
  $("signInBtn").addEventListener("click", guarded(signIn));
  $("accountBtn").addEventListener("click", (e) => { e.stopPropagation(); $("accountMenu").hidden = !$("accountMenu").hidden; });
  document.addEventListener("click", (e) => { if (!$("account").contains(e.target)) $("accountMenu").hidden = true; });
  $("copyIdBtn").addEventListener("click", guarded(async () => { await navigator.clipboard.writeText(state.user.id); notice("User id copied.", "ok"); }));
  $("signOutBtn").addEventListener("click", guarded(async () => { await state.sb.auth.signOut(); }));
  $("adminBtn").addEventListener("click", guarded(async () => { state.view = "admin-queue"; renderAll(); await loadQueue(); }));
  const guide = $("guide");
  const guideState = localStorage.getItem(LS.guide);
  guide.open = guideState ? guideState === "open" : matchMedia("(min-width: 901px)").matches;
  guide.addEventListener("toggle", () => localStorage.setItem(LS.guide, guide.open ? "open" : "closed"));
  renderAll();
}

boot().catch((e) => { $("countline").textContent = e.message; notice(e.message, "err", true); });
