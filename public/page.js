// Shell — pages.
// A page is a document you edit yourself, like Word: type, format, paste from
// anywhere. Claude is the editor at your elbow: select words and ask (or tell
// the whole page what to change from the composer), and Claude's edits come
// back as tracked changes you accept or reject. Pages are Markdown underneath,
// so a page opened from a file saves straight back to it.

const $ = (s, el = document) => el.querySelector(s);
const HL = typeof CSS !== "undefined" && "highlights" in CSS;

let ctx; // { api, toast, esc, marked, DOMPurify, projectName, onOpen, onClose, input }
const P = {
  page: null, // {id, title, projectId, md, file, ...}
  saveT: null,
  saving: null,
  dirty: false,
  conflict: false,
  asking: 0,
  range: null, // the selection the bubble acts on
};

const el = {};

// ---------------------------------------------------------------- markdown ⇄ editor

function mdToHtml(md) {
  return ctx.DOMPurify.sanitize(ctx.marked.parse(md || ""));
}

const BLOCKS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "BLOCKQUOTE", "PRE", "HR", "TABLE", "LI", "SECTION", "ARTICLE"]);

function escText(s) {
  return s.replace(/\u00a0/g, " ").replace(/([\\`*])/g, "\\$1").replace(/<(?=[a-zA-Z/!])/g, "&lt;");
}

// Markers hug their words: "** bold**" is not bold in Markdown.
function wrap(inner, open, close = open) {
  if (!inner.trim()) return inner;
  const lead = inner.match(/^\s*/)[0], trail = inner.match(/\s*$/)[0];
  return `${lead}${open}${inner.trim()}${close}${trail}`;
}

function inline(node) {
  let out = "";
  for (const n of node.childNodes) {
    if (n.nodeType === 3) { out += escText(n.textContent.replace(/\s*\n\s*/g, " ")); continue; }
    if (n.nodeType !== 1) continue;
    if (n.classList.contains("sug")) { out += inline($(".sug-del", n) || document.createElement("i")); continue; }
    if (n.classList.contains("sug-ctl") || n.dataset?.skip) continue;
    const t = n.tagName, st = n.style || {};
    let s = BLOCKS.has(t) ? inline(n) + " " : inline(n);
    // Google Docs and Word say bold/italic with styles, not tags.
    const bold = t === "STRONG" || (t === "B" && !/normal|400/.test(st.fontWeight || "")) || /bold|[6-9]00/.test(st.fontWeight || "");
    const ital = t === "EM" || t === "I" || st.fontStyle === "italic";
    const strike = t === "S" || t === "DEL" || t === "STRIKE" || /line-through/.test(st.textDecoration || st.textDecorationLine || "");
    const under = t === "U" || t === "INS" || /underline/.test(st.textDecoration || st.textDecorationLine || "");
    if (t === "BR") { out += "\\\n"; continue; }
    if (t === "IMG") { out += `![${n.alt || ""}](${n.getAttribute("src") || ""})`; continue; }
    if (t === "CODE") { out += "`" + n.textContent + "`"; continue; }
    if (t === "A" && n.getAttribute("href")) s = `[${s.trim()}](${n.getAttribute("href")})`;
    if (under) s = wrap(s, "<u>", "</u>");
    if (strike) s = wrap(s, "~~");
    if (ital) s = wrap(s, "*");
    if (bold) s = wrap(s, "**");
    out += s;
  }
  return out;
}

function listMd(list, depth = 0) {
  const ordered = list.tagName === "OL";
  let i = Number(list.getAttribute("start")) || 1;
  const lines = [];
  for (const li of list.children) {
    if (li.tagName !== "LI") continue;
    const marker = ordered ? `${i++}. ` : "- ";
    const pad = " ".repeat(marker.length);
    const own = document.createElement("div");
    const nested = [];
    for (const c of li.childNodes) {
      if (c.nodeType === 1 && (c.tagName === "UL" || c.tagName === "OL")) nested.push(c);
      else own.appendChild(c.cloneNode(true));
    }
    const text = inline(own).replace(/\s+$/, "").replace(/^\s+/, "");
    lines.push(marker + text.replace(/\n/g, "\n" + pad));
    for (const n of nested) lines.push(listMd(n, depth + 1).replace(/^/gm, pad));
  }
  return lines.join("\n");
}

function blockMd(n) {
  if (n.nodeType === 3) return n.textContent.trim() ? escText(n.textContent.trim()) : "";
  if (n.nodeType !== 1) return "";
  if (n.classList.contains("sug-block")) return [...($(".sug-old", n)?.children || [])].map(blockMd).filter(Boolean).join("\n\n");
  if (n.classList.contains("sug")) return inline($(".sug-del", n));
  const t = n.tagName;
  if (/^H[1-6]$/.test(t)) { const s = inline(n).trim(); return s ? "#".repeat(+t[1]) + " " + s : ""; }
  if (t === "UL" || t === "OL") return listMd(n);
  if (t === "BLOCKQUOTE") {
    const inner = [...n.childNodes].some((c) => c.nodeType === 1 && BLOCKS.has(c.tagName)) ? blocksMd(n) : inline(n).trim();
    return inner ? inner.split("\n").map((l) => (l ? "> " + l : ">")).join("\n") : "";
  }
  if (t === "PRE") return "```\n" + n.textContent.replace(/\n$/, "") + "\n```";
  if (t === "HR") return "---";
  if (t === "TABLE") {
    const rows = [...n.querySelectorAll("tr")].map((tr) => [...tr.children].map((c) => inline(c).trim().replace(/\|/g, "\\|")));
    if (!rows.length) return "";
    const w = Math.max(...rows.map((r) => r.length));
    const line = (r) => "| " + Array.from({ length: w }, (_, i) => r[i] || "").join(" | ") + " |";
    return [line(rows[0]), "| " + Array(w).fill("---").join(" | ") + " |", ...rows.slice(1).map(line)].join("\n");
  }
  // a div holding blocks (pasted from elsewhere) is just a container
  if ([...n.children].some((c) => BLOCKS.has(c.tagName) && c.tagName !== "BR")) return blocksMd(n);
  // a paragraph that starts like Markdown syntax stays a paragraph
  return inline(n).trim().replace(/^(#{1,6} |[-+*] |\d+[.)] |> )/, "\\$1");
}

function blocksMd(root) {
  return [...root.childNodes].map(blockMd).filter((s) => s.trim()).join("\n\n");
}

export const toMarkdown = () => blocksMd(el.body).trim() + "\n";

// ---------------------------------------------------------------- open / close

export function initPage(c) {
  ctx = c;
  Object.assign(el, {
    root: $("#page"), scroll: $("#page"), sheet: $("#sheet"), body: $("#page-body"), file: $("#page-file"),
    style: $("#pg-style"), count: $("#pg-count"), saved: $("#pg-saved"), work: $("#pg-work"),
    bubble: $("#bubble"), sugBar: $("#sug-bar"), menu: $("#pg-menu"), picker: $("#file-picker"),
  });
  wireToolbar();
  wireEditor();
  wireBubble();
  wirePicker();
  addEventListener("beforeunload", () => { if (P.dirty) flushSave(true); });
}

export const pageIsOpen = () => !!P.page;
export const currentPage = () => P.page;

export async function openPage(id) {
  const pg = await ctx.api(`/api/pages/${id}`);
  await show(pg);
}

export async function newPage({ projectId, md = "", fromThread } = {}) {
  const pg = await ctx.api("/api/pages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, md, fromThread }) });
  await show(pg, { fresh: !md });
  return pg;
}

export async function openFile(file, projectId) {
  const res = await fetch("/api/pages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file, projectId }) });
  const pg = await res.json();
  if (!res.ok) throw new Error(pg.error || `HTTP ${res.status}`);
  await show(pg);
}

async function show(pg, { fresh = false } = {}) {
  if (P.page && P.dirty) await flushSave();
  P.page = pg;
  P.dirty = false;
  P.conflict = false;
  el.body.innerHTML = mdToHtml(pg.md) || "";
  if (!el.body.firstElementChild) el.body.innerHTML = "<p><br></p>";
  el.file.innerHTML = pg.file
    ? `<span class="pf-label">Saves to</span> <span class="pf-path"></span>`
    : `<span class="pf-label">${ctx.esc(ctx.projectName(pg.projectId) || "Page")}</span>`;
  if (pg.file) $(".pf-path", el.file).textContent = pg.file.replace(/^\/Users\/[^/]+/, "~");
  document.body.classList.add("paging");
  el.root.hidden = false;
  el.root.scrollTop = 0;
  setSaved(pg.file ? "Saved" : "Saved");
  renderSugBar();
  updateCount();
  try { localStorage.setItem("shell.lastPage", pg.id); } catch {}
  ctx.onOpen?.(pg);
  if (!matchMedia("(pointer: coarse)").matches) {
    el.body.focus({ preventScroll: true });
    const first = fresh ? el.body.firstElementChild : el.body.lastElementChild;
    const r = document.createRange();
    r.selectNodeContents(first || el.body);
    r.collapse(!!fresh);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }
}

export async function closePage() {
  if (!P.page) return;
  if (el.body.querySelector(".sug, .sug-block")) ctx.toast("Claude's unreviewed edits were left out");
  if (P.dirty) await flushSave();
  P.page = null;
  hideBubble();
  el.menu.hidden = true;
  el.root.hidden = true;
  document.body.classList.remove("paging");
  try { localStorage.removeItem("shell.lastPage"); } catch {}
  ctx.onClose?.();
}

// ---------------------------------------------------------------- saving

function setSaved(text, cls = "") {
  el.saved.className = cls;
  el.saved.textContent = text;
}

function markDirty() {
  if (!P.page) return;
  P.dirty = true;
  updateCount();
  if (P.conflict) return;
  setSaved("Editing…");
  clearTimeout(P.saveT);
  P.saveT = setTimeout(() => flushSave(), 700);
}

async function flushSave(beacon = false, extra = {}) {
  clearTimeout(P.saveT);
  const pg = P.page;
  if (!pg || (!P.dirty && !extra.force)) return;
  const md = toMarkdown();
  P.dirty = false;
  setSaved("Saving…");
  const req = fetch(`/api/pages/${pg.id}`, { method: "PUT", keepalive: beacon, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ md, ...extra }) });
  if (beacon) return;
  try {
    const res = await req;
    const out = await res.json();
    if (res.status === 409) {
      P.conflict = true;
      P.dirty = true;
      el.saved.className = "warn";
      el.saved.innerHTML = `File changed outside Shell. <button data-c="reload">Load theirs</button> <button data-c="force">Keep mine</button>`;
      return;
    }
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    pg.title = out.title;
    pg.md = md;
    if (P.page === pg) {
      setSaved(pg.file ? `Saved to ${pg.file.split("/").pop()}` : "Saved");
      ctx.onOpen?.(pg);
    }
  } catch (err) {
    P.dirty = true;
    setSaved("Not saved", "warn");
    ctx.toast("Couldn't save the page: " + err.message, true);
  }
}

async function resolveConflict(how) {
  const pg = P.page;
  if (!pg) return;
  P.conflict = false;
  if (how === "force") return flushSave(false, { force: true });
  const fresh = await ctx.api(`/api/pages/${pg.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reload: true }) });
  P.dirty = false;
  await show(fresh);
}

function updateCount() {
  const words = (el.body.innerText.match(/[\p{L}\p{N}’']+/gu) || []).length;
  const min = Math.max(1, Math.round(words / 230));
  el.count.textContent = words ? `${words.toLocaleString()} words · ${min} min` : "";
}

// ---------------------------------------------------------------- formatting

function blockOf(node) {
  let n = node?.nodeType === 3 ? node.parentNode : node;
  while (n && n !== el.body && n.parentNode !== el.body) n = n.parentNode;
  return n && n !== el.body ? n : null;
}

function currentStyle() {
  const s = getSelection();
  if (!s.rangeCount || !el.body.contains(s.anchorNode)) return null;
  const n = s.anchorNode.nodeType === 3 ? s.anchorNode.parentNode : s.anchorNode;
  const h = n.closest?.("h1, h2, h3, blockquote, li");
  if (!h || !el.body.contains(h)) return "p";
  return h.tagName === "LI" ? h.parentNode.tagName.toLowerCase() : h.tagName.toLowerCase();
}

function setStyle(tag) {
  el.body.focus();
  const cur = currentStyle();
  if (cur === "blockquote" && tag !== "blockquote") document.execCommand("outdent");
  if (tag === "ul" || tag === "ol") {
    if (cur !== tag) document.execCommand(tag === "ul" ? "insertUnorderedList" : "insertOrderedList");
  } else {
    if (cur === "ul" || cur === "ol") document.execCommand(cur === "ul" ? "insertUnorderedList" : "insertOrderedList");
    document.execCommand("formatBlock", false, tag === "blockquote" ? "blockquote" : tag);
  }
  syncToolbar();
  markDirty();
}

function cmd(name) {
  el.body.focus();
  if (name === "link") {
    const s = getSelection();
    const a = s.anchorNode?.parentElement?.closest("a");
    if (a && el.body.contains(a)) { document.execCommand("unlink"); markDirty(); return; }
    if (s.isCollapsed) return ctx.toast("Select the words to link first");
    const r = s.getRangeAt(0).cloneRange();
    const url = prompt("Link to:", "https://");
    if (!url || url === "https://") return;
    s.removeAllRanges(); s.addRange(r);
    document.execCommand("createLink", false, url);
  } else document.execCommand(name);
  syncToolbar();
  markDirty();
}

function syncToolbar() {
  const st = currentStyle();
  if (!st) return;
  el.style.value = st;
  for (const b of document.querySelectorAll("[data-fmt]")) {
    let on = false;
    try { on = document.queryCommandState(b.dataset.fmt); } catch {}
    b.classList.toggle("on", on);
  }
}

// "# " makes a heading, "- " a list, "1. " a numbered list, "> " a quote: as you type.
function autoformat() {
  const s = getSelection();
  if (!s.isCollapsed || !s.rangeCount) return;
  const node = s.anchorNode;
  if (node.nodeType !== 3) return;
  const block = node.parentNode.closest("p, div");
  if (!block || block.parentNode !== el.body || node !== block.firstChild) return;
  const before = node.textContent.slice(0, s.anchorOffset).replace(/\u00a0/g, " ");
  const m = before.match(/^(#{1,3}|[-*•]|1[.)]|>) $/);
  if (!m) return;
  const r = document.createRange();
  r.setStart(node, 0);
  r.setEnd(node, s.anchorOffset);
  s.removeAllRanges();
  s.addRange(r);
  document.execCommand("delete");
  const k = m[1];
  if (k[0] === "#") document.execCommand("formatBlock", false, "h" + k.length);
  else if (k === ">") document.execCommand("formatBlock", false, "blockquote");
  else if (/^1/.test(k)) document.execCommand("insertOrderedList");
  else document.execCommand("insertUnorderedList");
}

// Paste from Word, Google Docs, a web page or a Markdown file: keep the
// structure and the bold/italic, drop the fonts and colours.
function cleanPaste(e) {
  const html = e.clipboardData.getData("text/html");
  const text = e.clipboardData.getData("text/plain");
  if (!html && !text) return;
  e.preventDefault();
  let md;
  if (html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = ctx.DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "script", "meta", "title", "link"] });
    // Google Docs wraps everything in a <b style="font-weight:normal">
    tmp.querySelectorAll("b[id^=docs-internal-guid]").forEach((b) => b.replaceWith(...b.childNodes));
    md = blocksMd(tmp);
  } else {
    // Plain text: Markdown if it looks like it, otherwise lines and paragraphs as they are.
    if (!/\n/.test(text) && !/^(#|[-*] |\d+\. |> )/.test(text)) return document.execCommand("insertText", false, text);
    md = /^(#{1,6} |[-*] |\d+\. |> )/m.test(text) ? text : text.split(/\n{2,}/).map((p) => escText(p).replace(/\n/g, "\\\n")).join("\n\n");
  }
  const out = mdToHtml(md);
  const tmp = document.createElement("div");
  tmp.innerHTML = out;
  // One paragraph goes in where the cursor is, not as a new block.
  if (tmp.children.length === 1 && tmp.firstElementChild.tagName === "P") document.execCommand("insertHTML", false, tmp.firstElementChild.innerHTML);
  else document.execCommand("insertHTML", false, out);
  markDirty();
}

// The line you're typing on stays above the composer, never under the fade.
function keepCaretInView() {
  const s = getSelection();
  if (!s.rangeCount) return;
  let r = s.getRangeAt(0).getBoundingClientRect();
  if (!r.height) { const n = s.anchorNode?.nodeType === 1 ? s.anchorNode : s.anchorNode?.parentElement; r = n?.getBoundingClientRect() || r; }
  const limit = innerHeight - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--composer-h")) || 150) - 70;
  if (r.bottom > limit) el.root.scrollBy({ top: r.bottom - limit + 40 });
}

function wireEditor() {
  document.execCommand("defaultParagraphSeparator", false, "p");
  document.execCommand("styleWithCSS", false, false);
  el.body.addEventListener("input", (e) => {
    if (e.inputType === "insertText" && e.data?.endsWith(" ")) autoformat();
    keepCaretInView();
    if (!el.body.firstElementChild) el.body.innerHTML = "<p><br></p>";
    markDirty();
  });
  el.body.addEventListener("paste", cleanPaste);
  el.body.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.altKey && /^Digit[0-3]$/.test(e.code)) { e.preventDefault(); return setStyle(e.code === "Digit0" ? "p" : "h" + e.code[5]); }
    if (mod && e.shiftKey && e.code === "Digit7") { e.preventDefault(); return setStyle("ol"); }
    if (mod && e.shiftKey && e.code === "Digit8") { e.preventDefault(); return setStyle("ul"); }
    if (mod && e.shiftKey && e.code === "KeyX") { e.preventDefault(); return cmd("strikeThrough"); }
    if (mod && !e.shiftKey && e.key.toLowerCase() === "k") { e.preventDefault(); return cmd("link"); }
    if (mod && !e.shiftKey && e.key.toLowerCase() === "j") { e.preventDefault(); return askFromKeys(); }
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); P.dirty = true; return flushSave(); }
    if (e.key === "Tab") {
      e.preventDefault();
      if (currentStyle() === "ul" || currentStyle() === "ol") document.execCommand(e.shiftKey ? "outdent" : "indent");
      else if (!e.shiftKey) document.execCommand("insertText", false, "\u2003");
      markDirty();
    }
    if (e.key === "Escape" && !el.bubble.hidden) { e.preventDefault(); e.stopPropagation(); hideBubble(); }
  });
  // Claude's tracked changes: accept or reject each one.
  el.body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-sug]");
    if (!b) return;
    e.preventDefault();
    decide(b.closest(".sug, .sug-block"), b.dataset.sug === "accept");
  });
  el.body.addEventListener("mousedown", (e) => { if (e.target.closest("[data-sug]")) e.preventDefault(); });
  document.addEventListener("selectionchange", () => {
    if (!P.page) return;
    syncToolbar();
    clearTimeout(P.selT);
    P.selT = setTimeout(maybeBubble, 220);
  });
  el.root.addEventListener("scroll", () => { if (!el.bubble.hidden && !el.bubble.classList.contains("asking")) hideBubble(); }, { passive: true });
  // Clicking the paper below the last line puts the cursor at the end, like a page.
  el.sheet.addEventListener("mousedown", (e) => {
    if (e.target !== el.sheet) return;
    e.preventDefault();
    el.body.focus();
    const r = document.createRange();
    r.selectNodeContents(el.body.lastElementChild || el.body);
    r.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
}

function wireToolbar() {
  $("#page-bar").addEventListener("mousedown", (e) => { if (e.target.closest("button") && !e.target.closest("#pg-menu")) e.preventDefault(); });
  $("#page-bar").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.fmt) cmd(b.dataset.fmt);
    else if (b.dataset.cmd === "close") closePage();
    else if (b.dataset.cmd === "ask") askFromKeys();
    else if (b.dataset.cmd === "menu") { el.menu.hidden = !el.menu.hidden; }
    else if (b.dataset.c) resolveConflict(b.dataset.c);
  });
  el.style.addEventListener("change", () => setStyle(el.style.value));
  el.menu.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    el.menu.hidden = true;
    const a = b.dataset.m;
    if (a === "open") openPicker();
    else if (a === "new") newPage({ projectId: P.page.projectId }).catch((err) => ctx.toast(err.message, true));
    else if (a === "copy") copyPage();
    else if (a === "md") { await navigator.clipboard.writeText(toMarkdown()); ctx.toast("Copied as Markdown"); }
    else if (a === "delete") {
      if (!confirm(P.page.file ? "Remove this page from Shell? The file stays where it is." : "Delete this page? This can't be undone.")) return;
      const id = P.page.id;
      P.dirty = false;
      await ctx.api(`/api/pages/${id}`, { method: "DELETE" });
      await closePage();
      ctx.toast("Page deleted");
    }
  });
  document.addEventListener("mousedown", (e) => { if (!el.menu.hidden && !e.target.closest("#pg-menu, [data-cmd=menu]")) el.menu.hidden = true; });
  el.sugBar.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const all = [...el.body.querySelectorAll(".sug, .sug-block")];
    if (b.dataset.all === "next") return all[0]?.scrollIntoView({ behavior: "smooth", block: "center" });
    all.forEach((s) => decide(s, b.dataset.all === "accept", { quiet: true }));
    renderSugBar();
    markDirty();
  });
}

// Rich text for Google Docs, Word or email; Markdown for anything plain.
async function copyPage() {
  const md = toMarkdown();
  try {
    await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([mdToHtml(md)], { type: "text/html" }), "text/plain": new Blob([md], { type: "text/plain" }) })]);
  } catch {
    await navigator.clipboard.writeText(md);
  }
  ctx.toast("Copied. Paste it into Docs, Word or an email");
}

// ---------------------------------------------------------------- the selection bubble

function selectionInBody() {
  const s = getSelection();
  if (!s.rangeCount || s.isCollapsed) return null;
  const r = s.getRangeAt(0);
  if (!el.body.contains(r.commonAncestorContainer)) return null;
  if (s.toString().trim().length < 2) return null;
  return r;
}

function maybeBubble() {
  if (el.bubble.classList.contains("asking")) return;
  const r = selectionInBody();
  if (!r) return hideBubble();
  P.range = r.cloneRange();
  el.bubble.hidden = false;
  el.bubble.classList.remove("asking");
  placeBubble(r.getBoundingClientRect());
}

function placeBubble(rect) {
  const b = el.bubble;
  const bw = b.offsetWidth, bh = b.offsetHeight;
  let top = rect.top - bh - 10;
  if (top < 120) top = rect.bottom + 10;
  top = Math.min(top, innerHeight - bh - 12);
  const left = Math.max(12, Math.min(innerWidth - bw - 12, rect.left + rect.width / 2 - bw / 2));
  b.style.top = top + "px";
  b.style.left = left + "px";
}

function hideBubble() {
  el.bubble.hidden = true;
  el.bubble.classList.remove("asking");
}

function openAsk(range) {
  P.range = range;
  el.bubble.hidden = false;
  el.bubble.classList.add("asking");
  const ta = $("#ask-input");
  ta.value = "";
  placeBubble(range.getBoundingClientRect());
  if (HL) CSS.highlights.set("asking", new Highlight(range));
  ta.focus();
}

function askFromKeys() {
  const r = selectionInBody();
  if (r) return openAsk(r.cloneRange());
  // Nothing selected: talk to the whole page from the composer.
  ctx.input.focus();
  ctx.toast("Select words to edit just those, or tell Claude what to change on the whole page");
}

function wireBubble() {
  el.bubble.addEventListener("mousedown", (e) => { if (!e.target.closest("textarea")) e.preventDefault(); });
  el.bubble.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.fmt) {
      const r = P.range;
      el.body.focus();
      if (r) { getSelection().removeAllRanges(); getSelection().addRange(r); }
      cmd(b.dataset.fmt);
    } else if (b.dataset.b === "ask") openAsk(P.range);
    else if (b.dataset.quick) runAsk(b.dataset.quick);
    else if (b.dataset.b === "go") runAsk($("#ask-input").value);
  });
  $("#ask-input").addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runAsk(e.target.value); }
    if (e.key === "Escape") { e.preventDefault(); endAsk(); el.body.focus(); }
  });
  document.addEventListener("mousedown", (e) => {
    if (!el.bubble.hidden && !el.bubble.contains(e.target)) endAsk();
  });
}

function endAsk() {
  if (HL) CSS.highlights.delete("asking");
  hideBubble();
}

// ---------------------------------------------------------------- asking Claude

function working(on, label = "Claude is editing…") {
  P.asking += on ? 1 : -1;
  el.work.hidden = P.asking <= 0;
  el.work.textContent = label;
  document.body.classList.toggle("page-asking", P.asking > 0);
}

async function ask(body) {
  const res = await fetch(`/api/pages/${P.page.id}/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
  return out.text || "";
}

// Edit a passage: the words you selected (inline) or the paragraphs they touch.
async function runAsk(instruction) {
  instruction = String(instruction || "").trim();
  const range = P.range;
  if (!instruction || !range || !P.page) return;
  endAsk();
  const a = blockOf(range.startContainer), b = blockOf(range.endContainer);
  if (!a || !b) return;
  const host = (n) => (n.nodeType === 3 ? n.parentNode : n).closest("p, li, h1, h2, h3, h4, blockquote, td");
  const inlineSel = host(range.startContainer) === host(range.endContainer) && !!host(range.startContainer);
  let blocks = [];
  if (!inlineSel) { for (let n = a; n; n = n.nextElementSibling) { blocks.push(n); if (n === b) break; } }
  const holder = document.createElement("div");
  if (inlineSel) holder.appendChild(range.cloneContents());
  const text = inlineSel ? inline(holder).trim() : blocks.map(blockMd).join("\n\n");
  const pending = inlineSel ? range.cloneRange() : null;
  if (HL) CSS.highlights.set("pending", new Highlight(pending || rangeOver(blocks)));
  const before = inlineSel ? range.toString() : blocks.map((x) => x.textContent).join("\n");
  working(true, "Claude is rewriting your selection…");
  try {
    const out = await ask({ instruction, md: toMarkdown(), selection: { text, inline: inlineSel } });
    if (!P.page) return;
    const now = inlineSel ? pending.toString() : blocks.map((x) => (el.body.contains(x) ? x.textContent : "")).join("\n");
    if (now !== before) return ctx.toast("That passage changed while Claude was writing, so the edit was skipped", true);
    if (inlineSel) suggestInline(pending, out);
    else suggestBlocks(blocks, out);
    renderSugBar();
  } catch (err) {
    ctx.toast("Claude couldn't edit that: " + err.message, true);
  } finally {
    if (HL) CSS.highlights.delete("pending");
    working(false);
  }
}

function rangeOver(blocks) {
  const r = document.createRange();
  r.setStartBefore(blocks[0]);
  r.setEndAfter(blocks[blocks.length - 1]);
  return r;
}

// From the composer: Claude revises the whole page; each changed stretch is a tracked change.
export async function askWholePage(instruction) {
  if (!P.page) return false;
  if (el.body.querySelector(".sug, .sug-block")) { ctx.toast("Accept or reject Claude's last edits first", true); return false; }
  const md = toMarkdown();
  working(true, "Claude is reading the page…");
  el.body.contentEditable = "false";
  try {
    const out = await ask({ instruction, md });
    if (!P.page) return true;
    const n = diffInto(out);
    renderSugBar();
    ctx.toast(n ? `Claude made ${n} change${n === 1 ? "" : "s"}. Accept or reject each one` : "Claude didn't change anything");
    el.body.querySelector(".sug-block")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return true;
  } catch (err) {
    ctx.toast("Claude couldn't edit the page: " + err.message, true);
    return false;
  } finally {
    el.body.contentEditable = "true";
    working(false);
  }
}

const norm = (s) => s.replace(/\s+/g, " ").trim();

// Line up the old blocks with the new ones (longest common subsequence) and
// wrap each run of differences as one tracked change.
function diffInto(newMd) {
  const olds = [...el.body.children];
  const tmp = document.createElement("div");
  tmp.innerHTML = mdToHtml(newMd);
  const news = [...tmp.children];
  const A = olds.map((x) => norm(blockMd(x))), B = news.map((x) => norm(blockMd(x)));
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const hunks = [];
  let i = 0, j = 0, cur = null;
  const close = () => { if (cur) hunks.push(cur); cur = null; };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { close(); i++; j++; continue; }
    cur ||= { old: [], neu: [], at: olds[i] || null };
    if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) cur.neu.push(news[j++]);
    else cur.old.push(olds[i++]);
  }
  close();
  for (const h of hunks) {
    const w = sugBlock(h.neu);
    const anchor = h.old[0] || h.at;
    if (anchor) el.body.insertBefore(w, anchor); else el.body.appendChild(w);
    h.old.forEach((o) => $(".sug-old", w).appendChild(o));
  }
  return hunks.length;
}

function sugBlock(newEls) {
  const w = document.createElement("div");
  w.className = "sug-block";
  w.contentEditable = "false";
  w.innerHTML = `<div class="sug-old"></div><div class="sug-new"></div><div class="sug-ctl"><span class="who">✦ Claude</span><button data-sug="accept">Accept</button><button data-sug="reject">Reject</button></div>`;
  newEls.forEach((x) => $(".sug-new", w).appendChild(x));
  return w;
}

function suggestBlocks(blocks, md) {
  const tmp = document.createElement("div");
  tmp.innerHTML = mdToHtml(md);
  const w = sugBlock([...tmp.children]);
  el.body.insertBefore(w, blocks[0]);
  blocks.forEach((b) => $(".sug-old", w).appendChild(b));
  w.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function suggestInline(range, md) {
  const s = document.createElement("span");
  s.className = "sug";
  s.contentEditable = "false";
  s.innerHTML = `<del class="sug-del"></del><ins class="sug-ins"></ins><span class="sug-ctl"><button data-sug="accept" title="Accept">✓</button><button data-sug="reject" title="Reject">✕</button></span>`;
  $(".sug-ins", s).innerHTML = ctx.DOMPurify.sanitize(ctx.marked.parseInline(md.replace(/\n+/g, " ")));
  $(".sug-del", s).appendChild(range.extractContents());
  range.insertNode(s);
}

function decide(s, accept, { quiet = false } = {}) {
  if (!s) return;
  let keep;
  if (s.classList.contains("sug")) keep = [...(accept ? $(".sug-ins", s) : $(".sug-del", s)).childNodes];
  else keep = [...(accept ? $(".sug-new", s) : $(".sug-old", s)).children];
  s.replaceWith(...keep);
  if (!el.body.firstElementChild) el.body.innerHTML = "<p><br></p>";
  if (!quiet) { renderSugBar(); markDirty(); }
}

function renderSugBar() {
  const n = el.body.querySelectorAll(".sug, .sug-block").length;
  el.sugBar.hidden = !n;
  $(".n", el.sugBar).textContent = `${n} edit${n === 1 ? "" : "s"} from Claude`;
}

// ---------------------------------------------------------------- open a file

let pickerFiles = [];

async function openPicker() {
  const pid = P.page?.projectId || ctx.projectId();
  el.picker.hidden = false;
  $("#fp-title").textContent = `Open a file from ${ctx.projectName(pid) || "this project"}`;
  $("#fp-list").innerHTML = `<div class="fp-empty">Looking…</div>`;
  const q = $("#fp-q");
  q.value = "";
  q.focus();
  try {
    pickerFiles = await ctx.api(`/api/files?projectId=${encodeURIComponent(pid)}`);
    el.picker.dataset.pid = pid;
    renderPicker();
  } catch (err) {
    $("#fp-list").innerHTML = `<div class="fp-empty">Couldn't list files: ${ctx.esc(err.message)}</div>`;
  }
}
export { openPicker };

function renderPicker() {
  const q = $("#fp-q").value.toLowerCase().trim();
  const list = $("#fp-list");
  const hits = pickerFiles.filter((f) => !q || f.label.toLowerCase().includes(q)).slice(0, 80);
  list.innerHTML = hits.length ? "" : `<div class="fp-empty">No .md or .txt files${q ? " match" : " here"}.</div>`;
  for (const f of hits) {
    const b = document.createElement("button");
    b.className = "fp-item";
    b.innerHTML = `<span class="t"></span><span class="d"></span>`;
    const parts = f.label.split("/");
    $(".t", b).textContent = parts.pop();
    $(".d", b).textContent = parts.join("/");
    b.addEventListener("click", async () => {
      el.picker.hidden = true;
      try { await openFile(f.path, el.picker.dataset.pid); } catch (err) { ctx.toast(err.message, true); }
    });
    list.appendChild(b);
  }
}

function wirePicker() {
  $("#fp-q").addEventListener("input", renderPicker);
  $("#fp-q").addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") el.picker.hidden = true;
    if (e.key === "Enter") $("#fp-list .fp-item")?.click();
  });
  el.picker.addEventListener("mousedown", (e) => { if (e.target === el.picker) el.picker.hidden = true; });
  $("#fp-close").addEventListener("click", () => (el.picker.hidden = true));
}
