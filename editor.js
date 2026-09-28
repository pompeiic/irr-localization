// Community translation editor. Repo files are the truth; Supabase holds suggestions and votes until an
// admin applies them to Areas/*.json with their own GitHub token (never stored anywhere but this browser).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 40;
const LS = { name: "irrLoc.displayName", culture: "irrLoc.culture", token: "irrLoc.githubToken" };

const state = {
  config: {}, sb: null, user: null, isAdmin: false,
  project: null, cultures: [], entries: [], bySlot: new Map(),
  settings: { defaultThreshold: 3, requireBeatCurrent: true, cultures: {} },
  culture: "", page: 0, expanded: new Set(),
  suggestions: new Map(), currentScores: new Map(), myVotes: new Map(), myCurrentVotes: new Map(),
  queueRows: [], queueSelected: new Set(),
};

// ---------- helpers ----------

const slotOf = (e) => `${e.ns}\u001f${e.key}`;
const net = (o) => (o?.ups || 0) - (o?.downs || 0);

function fnv(text) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
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

let noticeTimer = 0;
function notice(message, isError = false, sticky = false) {
  const n = $("notice");
  n.textContent = message;
  n.className = isError ? "error" : "";
  n.hidden = !message;
  clearTimeout(noticeTimer);
  if (message && !sticky) noticeTimer = setTimeout(() => (n.hidden = true), 6000);
}

const cultureName = (() => {
  const en = new Intl.DisplayNames(["en"], { type: "language" });
  return (c) => {
    try { return `${en.of(c)} · ${new Intl.DisplayNames([c], { type: "language" }).of(c)}`; } catch { return c; }
  };
})();

const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

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
const openTags = (text) => [...text.matchAll(/<([A-Za-z][\w-]*)>/g)].map((m) => m[1]).sort().join(",");

function checkText(entry, text) {
  const problems = [];
  if (!text.trim()) return ["Enter a translation."];
  const args = formatArgs(entry.source);
  if (formatArgs(text) !== args) problems.push(`Keep these {arguments} exactly as written: ${args ? args.split(",").map((a) => `{${a}}`).join(" ") : "none"}`);
  if (closers(text) !== closers(entry.source) || openTags(text) !== openTags(entry.source)) {
    problems.push(`Keep the rich-text tags: ${openTags(entry.source) ? openTags(entry.source).split(",").map((t) => `<${t}>…</>`).join(" ") : "none"}`);
  }
  if (entry.maxLength > 0 && text.length > entry.maxLength) problems.push(`${text.length}/${entry.maxLength} characters — too long for this spot.`);
  return problems;
}

// ---------- status of the current translation ----------

function currentOf(entry, culture) {
  const t = entry.t?.[culture];
  return t && t.text && t.status !== "untranslated" ? t : null;
}

function describe(t) {
  if (!t) return { cls: "none", label: "Untranslated" };
  if (t.status === "stale") return { cls: "stale", label: "Outdated — English changed" };
  if (t.status === "machine") return { cls: "ai", label: "AI translation · not checked by a human" };
  const by = t.by || "";
  if (by.startsWith("community:")) return { cls: "community", label: `Community · ${by.slice(10)}` };
  return { cls: "human", label: `${t.status === "approved" ? "Approved" : "Human reviewed"}${by && by !== "ai" ? ` · ${by}` : ""}` };
}

const thresholdFor = (culture) => state.settings.cultures?.[culture] ?? state.settings.defaultThreshold;

function currentScore(entry, culture, scores = state.currentScores) {
  const t = currentOf(entry, culture);
  return t ? scores.get(`${culture}|${slotOf(entry)}|${fnv(t.text)}`) : null;
}

function passes(s, entry, curScore) {
  if (!entry || s.source_hash !== entry.sourceHash) return false;
  if (net(s) < thresholdFor(s.culture)) return false;
  return !state.settings.requireBeatCurrent || net(s) > net(curScore);
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

async function refreshUser() {
  const { data } = await state.sb.auth.getSession();
  state.user = data.session?.user ?? null;
  state.isAdmin = false;
  if (state.user && !state.user.is_anonymous) {
    const { data: rows } = await state.sb.from("admins").select("user_id").eq("user_id", state.user.id);
    state.isAdmin = !!rows?.length;
  }
  renderAdminAuth();
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    document.head.append(h("script", { src, onload: resolve, onerror: () => reject(new Error("Could not load the captcha.")) }));
  });
}

async function captchaToken() {
  const sitekey = state.config.turnstileSiteKey;
  if (!sitekey) return undefined;
  await loadScript("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
  return new Promise((resolve, reject) => {
    const box = $("captcha");
    const close = (fn) => (v) => { box.hidden = true; fn(v); };
    box.hidden = false;
    $("captchaWidget").replaceChildren();
    window.turnstile.render("#captchaWidget", { sitekey, callback: close(resolve), "error-callback": close(() => reject(new Error("Captcha failed — try again."))) });
    $("captchaCancel").onclick = close(() => reject(new Error("Cancelled.")));
  });
}

async function ensureSignedIn() {
  if (!state.sb) throw new Error("Community features are not configured yet.");
  if (state.user) return;
  const { error } = await state.sb.auth.signInAnonymously({ options: { captchaToken: await captchaToken() } });
  if (error) throw error;
  await refreshUser();
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
  await ensureSignedIn();
  const before = state.myVotes.get(s.id) || 0;
  const after = before === value ? 0 : value;
  const q = after
    ? state.sb.from("votes").upsert({ suggestion_id: s.id, voter: state.user.id, value: after })
    : state.sb.from("votes").delete().eq("suggestion_id", s.id).eq("voter", state.user.id);
  const { error } = await q;
  if (error) throw error;
  if (after) state.myVotes.set(s.id, after); else state.myVotes.delete(s.id);
  applyVoteDelta(s, before, after);
}

async function voteCurrent(entry, value) {
  await ensureSignedIn();
  const c = state.culture;
  const hash = fnv(currentOf(entry, c).text);
  const id = `${c}|${slotOf(entry)}|${hash}`;
  const before = state.myCurrentVotes.get(id) || 0;
  const after = before === value ? 0 : value;
  const row = { ns: entry.ns, key: entry.key, culture: c, text_hash: hash, voter: state.user.id };
  const q = after
    ? state.sb.from("current_votes").upsert({ ...row, value: after })
    : state.sb.from("current_votes").delete().match(row);
  const { error } = await q;
  if (error) throw error;
  if (after) state.myCurrentVotes.set(id, after); else state.myCurrentVotes.delete(id);
  if (!state.currentScores.has(id)) state.currentScores.set(id, { ups: 0, downs: 0 });
  applyVoteDelta(state.currentScores.get(id), before, after);
}

async function submitSuggestion(entry, text, note) {
  await ensureSignedIn();
  const author_name = ($("displayName").value.trim() || "Anonymous").slice(0, 40);
  const { data, error } = await state.sb.from("suggestions")
    .insert({ ns: entry.ns, key: entry.key, culture: state.culture, source_hash: entry.sourceHash, text, note, author_name })
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
  const id = `${s.ns}\u001f${s.key}`;
  if (s.culture !== state.culture) return;
  const list = (state.suggestions.get(id) || []).filter((x) => x.id !== s.id);
  if (list.length) state.suggestions.set(id, list); else state.suggestions.delete(id);
}

// ---------- list view ----------

function visibleEntries() {
  const q = $("search").value.trim().toLowerCase();
  const area = $("area").value;
  const filter = $("filter").value;
  const c = state.culture;
  return state.entries.filter((e) => {
    if (area && e.area !== area) return false;
    const t = e.t?.[c];
    const cur = currentOf(e, c);
    const sugg = state.suggestions.get(slotOf(e));
    if (filter === "ai" && t?.status !== "machine") return false;
    if (filter === "missing" && cur && cur.status !== "stale") return false;
    if (filter === "human" && !(cur && (cur.status === "reviewed" || cur.status === "approved"))) return false;
    if (filter === "open" && !sugg?.length) return false;
    if (filter === "mine" && !sugg?.some((s) => s.author === state.user?.id)) return false;
    if (q && !(e.source.toLowerCase().includes(q) || (t?.text || "").toLowerCase().includes(q) || e.key.toLowerCase().includes(q))) return false;
    return true;
  });
}

function guarded(fn) {
  return async (...args) => {
    try { await fn(...args); } catch (e) { notice(e.message || String(e), true); }
  };
}

function voteBox(score, mine, onVote, disabledReason) {
  const dis = !state.sb || !!disabledReason;
  const title = disabledReason || (state.sb ? "" : "Community features are not configured yet.");
  return h("span", { class: "votes", title },
    h("button", { class: `up${mine === 1 ? " active" : ""}`, disabled: dis, onclick: guarded(() => onVote(1)) }, `▲ ${score?.ups || 0}`),
    h("span", { class: "net" }, net(score) > 0 ? `+${net(score)}` : net(score)),
    h("button", { class: `down${mine === -1 ? " active" : ""}`, disabled: dis, onclick: guarded(() => onVote(-1)) }, `▼ ${score?.downs || 0}`));
}

function renderEntry(entry) {
  const c = state.culture;
  const id = slotOf(entry);
  const cur = currentOf(entry, c);
  const info = describe(cur);
  const curScore = currentScore(entry, c);
  const sugg = [...(state.suggestions.get(id) || [])].sort((a, b) => net(b) - net(a) || a.id - b.id);
  const expanded = state.expanded.has(id);
  const card = h("div", { class: "entry" });
  const rerender = () => card.replaceWith(renderEntry(entry));

  const currentRow = h("div", { class: `current${cur ? "" : " empty"}` },
    h("span", { class: `badge ${info.cls}` }, info.label),
    h("div", { class: "text", lang: c }, cur ? cur.text : "No translation yet"),
    cur ? voteBox(curScore, state.myCurrentVotes.get(`${c}|${id}|${fnv(cur.text)}`), async (v) => { await voteCurrent(entry, v); rerender(); }) : null);

  card.append(
    h("div", { class: "head" },
      h("span", {}, entry.area),
      h("span", { class: "key", title: entry.origin }, entry.ns ? `${entry.ns} · ${entry.key}` : entry.key),
      entry.maxLength > 0 ? h("span", {}, `max ${entry.maxLength} chars`) : null),
    h("div", { class: "source text", lang: "en" }, entry.source),
    entry.note ? h("div", { class: "muted" }, entry.note) : null,
    currentRow,
    h("div", { class: "toggle" },
      h("button", { class: "link", onclick: () => { expanded ? state.expanded.delete(id) : state.expanded.add(id); rerender(); } },
        expanded ? "Hide suggestions" : sugg.length ? `${sugg.length} suggestion${sugg.length > 1 ? "s" : ""} — view / suggest` : "Suggest a better translation")));

  if (expanded) {
    const box = h("div", { class: "suggestions" });
    for (const s of sugg) box.append(renderSuggestion(entry, s, curScore, rerender));
    box.append(renderForm(entry, cur, rerender));
    card.append(box);
  }
  return card;
}

function renderSuggestion(entry, s, curScore, rerender) {
  const outdated = s.source_hash !== entry.sourceHash;
  const mine = state.user && s.author === state.user.id;
  const pass = passes(s, entry, curScore);
  return h("div", { class: `sugg${outdated ? " outdated" : ""}` },
    h("div", { class: "line" },
      h("div", { class: "text", lang: s.culture }, s.text),
      voteBox(s, state.myVotes.get(s.id), async (v) => { await voteSuggestion(s, v); rerender(); }, mine ? "You can't vote on your own suggestion." : null)),
    s.note ? h("div", { class: "note" }, s.note) : null,
    h("div", { class: "by" },
      h("span", {}, `${s.author_name} · ${fmtDate(s.created_at)}`),
      outdated ? h("span", { class: "badge outdated", title: "The English text changed after this was suggested." }, "Outdated") : null,
      pass ? h("span", { class: "badge pass" }, "In admin queue") : null,
      mine ? h("span", { class: "badge mine" }, "Yours") : null,
      mine ? h("button", { class: "link", onclick: guarded(async () => { await withdrawSuggestion(s); rerender(); }) }, "Withdraw") : null,
      state.isAdmin ? h("button", { class: "link", onclick: guarded(async () => { await applySuggestions([s]); rerender(); }) }, "Apply") : null,
      state.isAdmin ? h("button", { class: "link", onclick: guarded(async () => { await rejectSuggestions([s]); rerender(); }) }, "Reject") : null,
      state.isAdmin && !mine ? h("button", { class: "link", onclick: guarded(async () => { await banAuthor(s); rerender(); }) }, "Ban author") : null));
}

function renderForm(entry, cur, rerender) {
  if (!state.sb) return h("div", { class: "muted form" }, "Suggestions open once the community backend is configured.");
  const text = h("textarea", { lang: state.culture, placeholder: `Your ${cultureName(state.culture).split(" · ")[0]} translation` });
  text.value = cur?.text || "";
  const note = h("input", { maxlength: "1000", placeholder: "Note (optional) — why this is better, context, terminology…" });
  const problems = h("div", { class: "problems" });
  const submit = h("button", { class: "primary" }, "Submit suggestion");
  const check = () => {
    const p = checkText(entry, text.value);
    if (!p.length && cur && text.value === cur.text) p.push("Change the text to suggest something new.");
    problems.replaceChildren(...p.map((x) => h("div", {}, x)));
    submit.disabled = p.length > 0;
  };
  text.addEventListener("input", check);
  submit.addEventListener("click", guarded(async () => {
    submit.disabled = true;
    try { await submitSuggestion(entry, text.value, note.value.trim()); notice("Thanks — your suggestion is up for votes."); rerender(); }
    finally { submit.disabled = false; }
  }));
  check();
  return h("div", { class: "form" }, text, note, problems, h("div", { class: "row" }, submit,
    h("span", { class: "muted" }, "Keep {arguments} and <Tag>…</> markup unchanged.")));
}

function render() {
  const list = visibleEntries();
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages - 1);
  const c = state.culture;
  const done = state.entries.filter((e) => currentOf(e, c) && e.t[c].status !== "stale").length;
  const ai = state.entries.filter((e) => e.t?.[c]?.status === "machine").length;
  const open = [...state.suggestions.values()].reduce((n, l) => n + l.length, 0);
  $("summary").textContent = `${list.length} of ${state.entries.length} strings · ${cultureName(c)}: ${done} translated, ${ai} by AI · ${open} open suggestions` +
    (state.sb ? "" : " · voting and suggestions are not enabled yet");
  $("list").replaceChildren(...list.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE).map(renderEntry));
  const go = (p) => () => { state.page = p; render(); window.scrollTo(0, 0); };
  $("pager").replaceChildren(
    h("button", { disabled: state.page === 0, onclick: go(state.page - 1) }, "‹ Previous"),
    h("span", { class: "muted" }, `Page ${state.page + 1} of ${pages}`),
    h("button", { disabled: state.page >= pages - 1, onclick: go(state.page + 1) }, "Next ›"));
}

// ---------- GitHub (admin) ----------

async function gh(path, init = {}) {
  const token = localStorage.getItem(LS.token);
  if (!token) throw new Error("Add your GitHub token in the admin panel first.");
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
  if (!state.isAdmin) throw new Error("Sign in with your admin account first.");
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
  }, `Apply community suggestions from the web editor (${chosen.map((s) => s.culture).filter((c, i, a) => a.indexOf(c) === i).join(", ")})`);

  if (done && applied.length) {
    const { error } = await state.sb.from("suggestions").update({ status: "applied", resolved_at: new Date().toISOString() }).in("id", applied.map((s) => s.id));
    if (error) notice(`Committed, but marking suggestions as applied failed: ${error.message}`, true, true);
    for (const s of applied) {
      const entry = state.bySlot.get(`${s.ns}\u001f${s.key}`);
      entry.t = entry.t || {};
      entry.t[s.culture] = { text: s.text, status: "reviewed", by: `community:${s.author_name}`, at };
      dropSuggestionLocally(s);
    }
  }
  const msg = `${applied.length} applied${skipped.length ? `, ${skipped.length} skipped (${skipped.map(([s, why]) => `${s.culture} "${s.text.slice(0, 30)}": ${why}`).join("; ")})` : ""}.` +
    (applied.length ? " The site updates in about a minute; Unreal picks it up on its next sync." : "");
  notice(msg, skipped.length > 0 && !applied.length, skipped.length > 0);
  if ($("admin").hidden === false) await loadQueue();
  render();
}

async function rejectSuggestions(list) {
  if (!state.isAdmin) throw new Error("Sign in with your admin account first.");
  const { error } = await state.sb.from("suggestions").update({ status: "rejected", resolved_at: new Date().toISOString() }).in("id", list.map((s) => s.id));
  if (error) throw error;
  list.forEach(dropSuggestionLocally);
  notice(`${list.length} rejected.`);
  if ($("admin").hidden === false) await loadQueue();
  render();
}

async function banAuthor(s) {
  if (!confirm(`Ban "${s.author_name}" and reject all their open suggestions?`)) return;
  const { error } = await state.sb.from("bans").upsert({ user_id: s.author, reason: `via suggestion ${s.id}` });
  if (error) throw error;
  const { data, error: e2 } = await state.sb.from("suggestions").update({ status: "rejected", resolved_at: new Date().toISOString() })
    .eq("author", s.author).eq("status", "open").select("id,ns,key,culture");
  if (e2) throw e2;
  (data || []).forEach(dropSuggestionLocally);
  notice(`Banned ${s.author_name}; ${data?.length || 0} suggestion(s) rejected.`);
  render();
}

// ---------- admin panel ----------

function renderAdminAuth() {
  const who = $("adminWho");
  const signedInAdmin = state.user && !state.user.is_anonymous;
  $("adminAuth").hidden = !!signedInAdmin;
  $("adminSignOut").hidden = !signedInAdmin;
  who.textContent = !state.sb ? "Supabase is not configured (community/config.json)."
    : signedInAdmin ? `Signed in as ${state.user.email} — ${state.isAdmin ? "admin ✓" : `not an admin yet (user id ${state.user.id})`}`
    : "Not signed in.";
}

function renderThresholds() {
  const box = $("thresholds");
  const s = state.settings;
  const def = h("input", { type: "number", min: "1", step: "1", value: s.defaultThreshold });
  def.addEventListener("input", () => { s.defaultThreshold = Math.max(1, parseInt(def.value, 10) || 1); $("thresholdsState").textContent = "unsaved"; });
  const beat = h("input", { type: "checkbox", checked: s.requireBeatCurrent });
  beat.addEventListener("change", () => { s.requireBeatCurrent = beat.checked; $("thresholdsState").textContent = "unsaved"; });
  const rows = [h("span", {}, "Default"), def, h("span", {}, "Must outscore current"), beat];
  for (const c of state.cultures) {
    const input = h("input", { type: "number", min: "1", step: "1", placeholder: String(s.defaultThreshold), value: s.cultures?.[c] ?? "" });
    input.addEventListener("input", () => {
      const v = parseInt(input.value, 10);
      s.cultures = s.cultures || {};
      if (v > 0) s.cultures[c] = v; else delete s.cultures[c];
      $("thresholdsState").textContent = "unsaved";
    });
    rows.push(h("span", { class: "muted" }, cultureName(c)), input);
  }
  box.replaceChildren(...rows);
}

async function saveThresholds() {
  const clean = { defaultThreshold: state.settings.defaultThreshold, requireBeatCurrent: !!state.settings.requireBeatCurrent, cultures: state.settings.cultures || {} };
  const content = `${JSON.stringify(clean, null, "\t")}\n`;
  const ok = await commitFiles(async () => [{ path: "community/settings.json", content }], "Update community acceptance thresholds");
  $("thresholdsState").textContent = ok ? "saved" : "no change";
  await loadQueue();
  render();
}

async function checkToken() {
  const who = $("ghWho");
  if (!localStorage.getItem(LS.token)) { who.textContent = "No token saved."; return; }
  try {
    const repo = await gh("");
    who.textContent = repo.permissions?.push ? `Token can write to ${repo.full_name} ✓` : `Token can read ${repo.full_name} but not write.`;
  } catch (e) { who.textContent = e.message; }
}

async function loadQueue() {
  const box = $("queue");
  if (!state.sb || !state.isAdmin) { box.textContent = "Sign in with your admin account to load the queue."; return; }
  box.textContent = "Loading…";
  const [sugg, scores] = await Promise.all([
    fetchAll(() => state.sb.from("open_suggestions").select("*").order("id")),
    fetchAll(() => state.sb.from("current_scores").select("*")),
  ]);
  const scoreMap = new Map(scores.map((r) => [`${r.culture}|${r.ns}\u001f${r.key}|${r.text_hash}`, r]));
  const showAll = $("queueAll").checked;
  const rows = [];
  for (const s of sugg) {
    const entry = state.bySlot.get(`${s.ns}\u001f${s.key}`);
    const cur = entry ? currentScore(entry, s.culture, scoreMap) : null;
    const pass = passes(s, entry, cur);
    if (pass || showAll) rows.push({ s, entry, cur, pass, outdated: !entry || entry.sourceHash !== s.source_hash });
  }
  if (!showAll) {
    const best = new Map();
    for (const r of rows) {
      const id = `${r.s.culture}|${r.s.ns}\u001f${r.s.key}`;
      if (!best.has(id) || net(r.s) > net(best.get(id).s)) best.set(id, r);
    }
    rows.splice(0, rows.length, ...best.values());
  }
  rows.sort((a, b) => a.s.culture.localeCompare(b.s.culture) || net(b.s) - net(a.s));
  state.queueRows = rows;
  state.queueSelected = new Set([...state.queueSelected].filter((id) => rows.some((r) => r.s.id === id)));
  renderQueue();
}

function renderQueue() {
  const box = $("queue");
  const rows = state.queueRows;
  if (!rows.length) { box.textContent = $("queueAll").checked ? "No open suggestions." : "Nothing has reached the threshold yet."; return; }
  const table = h("table", { class: "queue" },
    h("tr", {}, h("th", {}, ""), h("th", {}, "Lang"), h("th", {}, "English"), h("th", {}, "Current"), h("th", {}, "Suggestion"), h("th", {}, "Score"), h("th", {}, "Needs")));
  for (const r of rows) {
    const { s, entry, cur } = r;
    const t = entry ? currentOf(entry, s.culture) : null;
    const box2 = h("input", { type: "checkbox", checked: state.queueSelected.has(s.id), disabled: r.outdated });
    box2.addEventListener("change", () => { box2.checked ? state.queueSelected.add(s.id) : state.queueSelected.delete(s.id); });
    const need = Math.max(thresholdFor(s.culture), state.settings.requireBeatCurrent ? net(cur) + 1 : 0);
    table.append(h("tr", { class: r.outdated ? "outdated" : "" },
      h("td", {}, box2),
      h("td", {}, s.culture),
      h("td", { class: "text" }, entry ? entry.source : "(string removed)"),
      h("td", { class: "text" }, t ? [h("span", { class: `badge ${describe(t).cls}` }, describe(t).label), h("br"), t.text] : h("span", { class: "muted" }, "untranslated")),
      h("td", { class: "text" }, s.text, s.note ? h("div", { class: "muted" }, s.note) : null, h("div", { class: "muted" }, `${s.author_name} · ${fmtDate(s.created_at)}${r.outdated ? " · outdated" : ""}`)),
      h("td", { class: "num" }, `${net(s) > 0 ? "+" : ""}${net(s)} (${s.ups}/${s.downs})${cur ? ` vs ${net(cur)}` : ""}`),
      h("td", { class: "num" }, r.pass ? "✓" : `≥ ${need}`)));
  }
  box.replaceChildren(table);
}

const selectedQueue = () => state.queueRows.filter((r) => state.queueSelected.has(r.s.id)).map((r) => r.s);

function wireAdmin() {
  $("adminToggle").addEventListener("click", guarded(async () => {
    const panel = $("admin");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { renderAdminAuth(); renderThresholds(); await checkToken(); await loadQueue(); }
  }));
  $("adminSignIn").addEventListener("click", guarded(async () => {
    if (!state.sb) throw new Error("Supabase is not configured.");
    const { error } = await state.sb.auth.signInWithPassword({ email: $("adminEmail").value.trim(), password: $("adminPassword").value });
    if (error) throw error;
    $("adminPassword").value = "";
    await refreshUser();
    await loadCommunity();
    await loadQueue();
    render();
  }));
  $("adminSignOut").addEventListener("click", guarded(async () => {
    await state.sb.auth.signOut();
    await refreshUser();
    await loadCommunity();
    await loadQueue();
    render();
  }));
  $("ghSave").addEventListener("click", guarded(async () => {
    const v = $("ghToken").value.trim();
    if (v) localStorage.setItem(LS.token, v);
    $("ghToken").value = "";
    await checkToken();
  }));
  $("ghForget").addEventListener("click", guarded(async () => { localStorage.removeItem(LS.token); await checkToken(); }));
  $("thresholdsSave").addEventListener("click", guarded(saveThresholds));
  $("queueRefresh").addEventListener("click", guarded(loadQueue));
  $("queueAll").addEventListener("change", guarded(loadQueue));
  $("queueSelectAll").addEventListener("click", () => {
    const all = state.queueRows.filter((r) => !r.outdated);
    const allOn = all.every((r) => state.queueSelected.has(r.s.id));
    state.queueSelected = new Set(allOn ? [] : all.map((r) => r.s.id));
    renderQueue();
  });
  $("queueApply").addEventListener("click", guarded(async () => {
    const list = selectedQueue();
    if (!list.length) throw new Error("Select suggestions first.");
    if (!confirm(`Apply ${list.length} suggestion(s) to the repo?`)) return;
    $("queueApply").disabled = true;
    try { await applySuggestions(list); state.queueSelected.clear(); } finally { $("queueApply").disabled = false; }
  }));
  $("queueReject").addEventListener("click", guarded(async () => {
    const list = selectedQueue();
    if (!list.length) throw new Error("Select suggestions first.");
    if (!confirm(`Reject ${list.length} suggestion(s)?`)) return;
    await rejectSuggestions(list);
    state.queueSelected.clear();
  }));
}

// ---------- boot ----------

async function fetchJson(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`Could not load ${path} (${r.status}).`);
  return r.json();
}

async function boot() {
  state.config = await fetchJson("community/config.json").catch(() => ({}));
  state.settings = { ...state.settings, ...(await fetchJson("community/settings.json").catch(() => ({}))) };
  state.project = await fetchJson("Project.json");
  state.cultures = state.project.cultures;

  const docs = await Promise.all(state.project.areas.map((a) => fetchJson(a.file).then((d) => ({ a, d }))));
  for (const { a, d } of docs) {
    for (const e of d.entries) {
      e.area = a.area;
      e.file = a.file;
      state.entries.push(e);
      state.bySlot.set(slotOf(e), e);
    }
  }

  const urlLang = new URLSearchParams(location.search).get("lang");
  const saved = localStorage.getItem(LS.culture);
  const browser = state.cultures.find((c) => navigator.language?.toLowerCase().startsWith(c.split("-")[0].toLowerCase()));
  state.culture = [urlLang, saved, browser, state.cultures[0]].find((c) => c && state.cultures.includes(c));

  const sel = $("culture");
  sel.replaceChildren(...state.cultures.map((c) => h("option", { value: c, selected: c === state.culture }, cultureName(c))));
  $("area").append(...state.project.areas.map((a) => h("option", { value: a.area }, `${a.area} (${a.entries})`)));
  $("displayName").value = localStorage.getItem(LS.name) || "";

  if (state.config.supabaseUrl && state.config.supabaseAnonKey) {
    state.sb = createClient(state.config.supabaseUrl, state.config.supabaseAnonKey, { auth: { persistSession: true } });
    await refreshUser();
    try { await loadCommunity(); } catch (e) { notice(`Could not load suggestions: ${e.message}`, true, true); }
  } else {
    notice("Browsing only — community voting and suggestions are not switched on yet.", false, true);
  }

  sel.addEventListener("change", guarded(async () => {
    state.culture = sel.value;
    localStorage.setItem(LS.culture, state.culture);
    state.page = 0;
    state.expanded.clear();
    await loadCommunity();
    render();
  }));
  let searchTimer = 0;
  $("search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.page = 0; render(); }, 150); });
  $("area").addEventListener("change", () => { state.page = 0; render(); });
  $("filter").addEventListener("change", () => { state.page = 0; render(); });
  $("displayName").addEventListener("change", () => localStorage.setItem(LS.name, $("displayName").value.trim()));
  wireAdmin();
  render();
}

boot().catch((e) => { $("summary").textContent = e.message; notice(e.message, true, true); });
