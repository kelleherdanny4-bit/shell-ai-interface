// Shell — client.
// A canvas of documents. Claude's replies land as docs; the camera flies
// between them. Select text to leave notes; notes go back in one batch.
import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";

marked.setOptions({ gfm: true, breaks: false });

const $ = (s, el = document) => el.querySelector(s);
const world = $("#world");
const docsEl = $("#docs");
const linksEl = $("#links");
const input = $("#input");
const pop = $("#popover");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const HL_SUPPORTED = typeof CSS !== "undefined" && "highlights" in CSS;

const state = {
  thread: null,
  docs: [], // {id, text, title, user, el, bodyEl, scrollEl, local, streaming, at}
  focus: -1,
  overview: false,
  busy: false,
  notes: [], // pending notes for this thread
  view: "thread", // "thread" (docs) or "river" (all projects)
  projects: [],
  projectId: null,
  riverPads: {},
  cam: { x: 0, y: 0, s: 1, r: 0 },
  layout: { docW: 820, docH: 600, cx: 0, cy: 0, wide: true },
};

// ---------------------------------------------------------------- layout

const ROT = [0, -2.5, 2, -1.5, 3, -2, 1.5];

function measure() {
  const vw = innerWidth, vh = innerHeight;
  const wide = vw >= 1200;
  document.body.classList.toggle("wide", wide);
  const topH = vw <= 760 ? 54 : 60;
  // Reserve room for the "notes ready" chip so the doc never sits under it.
  const composerH = Math.round($(".composer-row").getBoundingClientRect().height + ($("#composer-meta").offsetHeight || 0)) + 64;
  document.documentElement.style.setProperty("--composer-h", composerH + "px");
  // On wide screens your notes are pencilled in the margin right of the sheet.
  const margW = 250;
  const avail = wide ? vw - margW - 120 : vw <= 760 ? vw - 24 : vw - 140;
  const docW = Math.round(Math.max(300, Math.min(820, avail)));
  const docH = Math.round(Math.max(320, vh - topH - composerH - 16));
  // Centre the sheet when there's room; otherwise slide it left to keep the margin.
  const cx = Math.round(wide ? Math.min(vw / 2, vw - margW - 44 - docW / 2) : vw / 2);
  document.documentElement.style.setProperty("--cx", cx + "px");
  const cy = Math.round(topH + (vh - topH - composerH) / 2 + 4);
  Object.assign(state.layout, { vw, vh, wide, topH, composerH, docW, docH, cx, cy });
  document.documentElement.style.setProperty("--doc-h", docH + "px");
  document.documentElement.style.setProperty("--doc-w", docW + "px");
}

function docPos(i) {
  const { docW, docH } = state.layout;
  const spacing = docW + Math.max(260, docW * 0.55);
  return {
    x: Math.round(i * spacing),
    y: Math.round(Math.sin(i * 1.15) * docH * 0.6 + (i % 2 ? docH * 0.15 : 0)),
    r: reduceMotion ? 0 : ROT[i % ROT.length],
  };
}

function placeDocs() {
  const { docW, docH } = state.layout;
  state.docs.forEach((d, i) => {
    const p = docPos(i);
    d.pos = p;
    d.el.style.left = p.x - docW / 2 + "px";
    d.el.style.top = p.y - docH / 2 + "px";
    d.el.style.transform = `rotate(${p.r}deg)`;
  });
  drawLinks();
}

function drawLinks() {
  const O = 20000;
  const pts = state.docs.map((d) => [d.pos.x + O, d.pos.y + O]);
  let path = "";
  pts.forEach(([x, y], i) => {
    if (i === 0) path += `M${x},${y}`;
    else {
      const [px, py] = pts[i - 1];
      const mx = (px + x) / 2;
      path += ` C${mx},${py} ${mx},${y} ${x},${y}`;
    }
  });
  // When zoomed out, a river runs under the lily pads; it flows in and out of frame.
  const sp = state.layout.docW * 1.6;
  const [fx, fy] = pts[0] || [O, O], [lx, ly] = pts[pts.length - 1] || [O, O];
  const river = `M${fx - sp},${fy + sp * 0.2} C${fx - sp / 2},${fy + sp * 0.2} ${fx - sp / 2},${fy} ${fx},${fy}` + path.replace(/^M[^ C]+/, "") + ` C${lx + sp / 2},${ly} ${lx + sp / 2},${ly - sp * 0.2} ${lx + sp},${ly - sp * 0.2}`;
  const w = state.layout.docH * 0.55;
  linksEl.innerHTML = `<path class="bank" d="${river}" stroke-width="${w * 1.35}" /><path class="water" d="${river}" stroke-width="${w}" /><path class="shimmer" d="${river}" /><path class="trail" d="${path}" />`;
}

// ---------------------------------------------------------------- camera

function applyCam() {
  const { cx, cy } = state.layout;
  const c = state.cam;
  world.style.transform = `translate(${cx}px,${cy}px) scale(${c.s}) rotate(${-c.r}deg) translate(${-c.x}px,${-c.y}px)`;
  // Semantic zoom: far away, docs turn into lily pads that show only a title.
  document.body.classList.toggle("far", c.s < 0.5 && !state.holdNear);
  world.style.setProperty("--inv", (1 / c.s).toFixed(3));
}

const ease = (t) => t * t * t * (t * (6 * t - 15) + 10); // smootherstep: unhurried
let flight = null;

function flyTo(target, { duration, dip = true } = {}) {
  const from = { ...state.cam };
  const dist = Math.hypot(target.x - from.x, target.y - from.y);
  const d = reduceMotion ? 1 : duration ?? Math.min(2600, 1300 + dist * 0.4);
  // Prezi-style swoop: zoom out mid-flight, more for longer trips.
  const k = dip ? Math.max(0.45, Math.min(0.94, 1 - dist / (dist + state.layout.vw * 0.9))) : 1;
  const t0 = performance.now();
  state.holdNear = from.s >= 0.5 && target.s >= 0.5; // a hop between sheets, not a zoom out
  world.classList.add("flying");
  if (flight) cancelAnimationFrame(flight.raf);
  return new Promise((resolve) => {
    flight = { resolve };
    const step = (now) => {
      const t = Math.min(1, (now - t0) / d);
      const e = ease(t);
      const ls = Math.log(from.s) + (Math.log(target.s) - Math.log(from.s)) * e;
      state.cam.s = Math.exp(ls) * (1 - (1 - k) * Math.sin(Math.PI * t));
      state.cam.x = from.x + (target.x - from.x) * e;
      state.cam.y = from.y + (target.y - from.y) * e;
      state.cam.r = from.r + (target.r - from.r) * e;
      applyCam();
      if (t < 1) flight.raf = requestAnimationFrame(step);
      else {
        Object.assign(state.cam, target);
        applyCam();
        world.classList.remove("flying");
        state.holdNear = false;
        flight = null;
        resolve();
      }
    };
    flight.raf = requestAnimationFrame(step);
  });
}

function camForDoc(i) {
  const p = state.docs[i].pos;
  return { x: p.x, y: p.y, s: 1, r: p.r };
}

function camForOverview() {
  const { docW, docH, vw, vh, topH, composerH } = state.layout;
  if (!state.docs.length) return { x: 0, y: 0, s: 1, r: 0 };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  // Frame the pads around where you are (up to five), so titles stay readable.
  const f = Math.max(0, state.focus), lo = Math.max(0, Math.min(f - 2, state.docs.length - 5));
  for (const d of state.docs.slice(lo, lo + 5)) {
    minX = Math.min(minX, d.pos.x - docW * 0.6); maxX = Math.max(maxX, d.pos.x + docW * 0.6);
    minY = Math.min(minY, d.pos.y - docH * 0.6); maxY = Math.max(maxY, d.pos.y + docH * 0.6);
  }
  const availW = vw - 60, availH = vh - topH - composerH - 30;
  const s = Math.min(availW / (maxX - minX), availH / (maxY - minY), 0.36);
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, s, r: 0 };
}

async function focusDoc(i, opts = {}) {
  if (i < 0 || i >= state.docs.length) return;
  state.overview = false;
  document.body.classList.remove("overview");
  $("#btn-overview").classList.remove("active");
  state.focus = i;
  state.docs.forEach((d, j) => d.el.classList.toggle("focused", j === i));
  updateNav();
  renderNotes();
  hidePopover();
  await flyTo(camForDoc(i), opts);
  if (state.focus === i) positionMarginalia(state.docs[i]);
}

// O zooms out one level: doc → lily pads → the river of projects.
function zoomOut() {
  if (state.view === "river") return;
  if (state.overview) return showRiver();
  toggleOverview(true);
}

function toggleOverview(on = !state.overview) {
  if (!state.docs.length) return;
  if (!on) return focusDoc(Math.max(0, state.focus));
  state.overview = true;
  document.body.classList.add("overview");
  $("#btn-overview").classList.add("active");
  hidePopover();
  flyTo(camForOverview(), { dip: false, duration: 1100 });
}

// ---------------------------------------------------------------- docs

function fmtTime(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function headPrompt(user) {
  if (!user) return "";
  const n = user.display?.notes?.length || 0;
  const t = (user.display?.text || "").trim();
  const bits = [];
  if (n) bits.push(`<b>${n} note${n > 1 ? "s" : ""}</b>`);
  if (t) bits.push(esc(t.length > 90 ? t.slice(0, 90) + "…" : t));
  return bits.length ? `↳ You: ${bits.join(" + ")}` : "";
}

function makeDoc(d) {
  const el = document.createElement("article");
  el.className = "doc";
  el.innerHTML = `
    <div class="doc-head"><span class="idx"></span><span class="time">${fmtTime(d.at)}</span><span class="spacer"></span><span class="prompt" title="">${headPrompt(d.user)}</span></div>
    <div class="doc-scroll"><div class="doc-body"></div></div>
    <div class="inscription"><span class="date"></span><span class="ed"></span></div>
    <aside class="marginalia" aria-label="Your notes on this doc"></aside>
    <div class="pad" aria-hidden="true"><span class="lily"></span><span class="pad-title"></span></div>`;
  d.el = el;
  d.marginEl = $(".marginalia", el);
  setPadTitle(d);
  d.bodyEl = $(".doc-body", el);
  d.scrollEl = $(".doc-scroll", el);
  if (d.user?.display?.text) $(".prompt", el).title = d.user.display.text;
  let tick = 0;
  d.scrollEl.addEventListener("scroll", () => { tick ||= requestAnimationFrame(() => { tick = 0; positionMarginalia(d); }); }, { passive: true });
  el.addEventListener("click", () => {
    const i = state.docs.indexOf(d);
    if (state.overview || i !== state.focus) focusDoc(i);
  });
  docsEl.appendChild(el);
  return d;
}

function setPadTitle(d) {
  $(".pad-title", d.el).textContent = d.title && d.title !== "…" ? d.title : "Writing…";
}

// Like a print's pencilled margin: the date, and its place in the series.
function pencilDate(ts) {
  const d = new Date(ts || Date.now());
  const day = d.getDate();
  const suf = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `${d.toLocaleString("en-US", { month: "short" })}. ${day}${suf} ’${String(d.getFullYear()).slice(2)}`;
}

function renumber() {
  const n = state.docs.length;
  state.docs.forEach((d, i) => {
    $(".idx", d.el).textContent = `Doc ${i + 1}`;
    $(".inscription .date", d.el).textContent = pencilDate(d.at);
    $(".inscription .ed", d.el).textContent = `${i + 1}/${n}`;
  });
}

function renderBody(d, { animate = true } = {}) {
  const html = DOMPurify.sanitize(marked.parse(d.text || ""));
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  const next = [...tmp.children];
  const cur = [...d.bodyEl.children].filter((c) => !c.classList.contains("caret-host"));
  let i = 0;
  while (i < cur.length && i < next.length && cur[i].outerHTML === next[i].outerHTML) i++;
  // Replace everything from the first changed block onward.
  for (let j = i; j < cur.length; j++) cur[j].remove();
  for (let j = i; j < next.length; j++) {
    const n = next[j];
    // Only blocks that are new (not just growing) get the materialize effect.
    if (animate && j >= cur.length) n.classList.add("materialize");
    d.bodyEl.appendChild(n);
  }
  // Caret at the end while streaming
  d.bodyEl.querySelector(".caret")?.remove();
  if (d.streaming) {
    const last = d.bodyEl.lastElementChild;
    const host = last?.matches("ul,ol") ? last.querySelector("li:last-child") || last : last;
    const caret = document.createElement("span");
    caret.className = "caret";
    (host || d.bodyEl).appendChild(caret);
  }
}

function finalizeDoc(d) {
  d.streaming = false;
  d.bodyEl.querySelector(".caret")?.remove();
  d.bodyEl.querySelectorAll(".materialize").forEach((n) => n.classList.remove("materialize"));
  addGutters(d);
  d.el.style.setProperty("--sweep-h", d.scrollEl.clientHeight + 120 + "px");
  d.el.classList.add("sweep");
  setTimeout(() => d.el.classList.remove("sweep"), 1200);
}

function addGutters(d) {
  [...d.bodyEl.children].forEach((block) => {
    if (block.querySelector(":scope > .gutter")) return;
    const b = document.createElement("button");
    b.className = "gutter";
    b.setAttribute("aria-label", "Note on this part");
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const start = textOffset(d.bodyEl, block, 0);
      const end = start + block.textContent.length;
      const r = document.createRange();
      r.selectNodeContents(block);
      openPopover({ doc: d, start, end, quote: block.textContent.trim() }, b.getBoundingClientRect());
    });
    block.appendChild(b);
  });
}

function thinkingMarkup() {
  return `<div class="thinking"><div class="label">Thinking it through…</div><div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="activity"></div></div>`;
}

// ---------------------------------------------------------------- notes & highlights

function textOffset(root, node, offset) {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(node, offset);
  return r.toString().length;
}

function rangeFromOffsets(root, start, end) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0, n, r = document.createRange(), started = false;
  while ((n = walker.nextNode())) {
    const len = n.data.length;
    if (!started && start <= pos + len) { r.setStart(n, Math.max(0, start - pos)); started = true; }
    if (started && end <= pos + len) { r.setEnd(n, Math.max(0, end - pos)); return r; }
    pos += len;
  }
  return started ? r : null;
}

const notesKey = () => `shell.notes.${state.thread?.id}`;
function saveNotes() {
  try { localStorage.setItem(notesKey(), JSON.stringify(state.notes)); } catch {}
  renderNotes();
}
function loadNotes() {
  try { state.notes = JSON.parse(localStorage.getItem(notesKey()) || "[]"); } catch { state.notes = []; }
}

function addNote(target, text) {
  const note = {
    id: Math.random().toString(36).slice(2, 9),
    docId: target.doc.id,
    docTitle: target.doc.title,
    quote: target.quote.slice(0, 600),
    start: target.start,
    end: target.end,
    note: text,
    at: Date.now(),
  };
  state.notes.push(note);
  saveNotes();
  window.getSelection()?.removeAllRanges();
  pulseChip();
}

function paintHighlights(activeId) {
  if (!HL_SUPPORTED) return;
  const normal = [], active = [];
  for (const n of state.notes) {
    const d = state.docs.find((x) => x.id === n.docId);
    if (!d) continue;
    const r = rangeFromOffsets(d.bodyEl, n.start, n.end);
    if (r) (n.id === activeId ? active : normal).push(r);
  }
  CSS.highlights.set("note", new Highlight(...normal));
  CSS.highlights.set("note-active", new Highlight(...active));
}

function renderNotes() {
  const list = $("#notes-list");
  const n = state.notes.length;
  $("#notes-count").textContent = n;
  $("#notes-empty").style.display = n ? "none" : "";
  list.innerHTML = "";
  const focusId = state.docs[state.focus]?.id;
  // Notes on the focused doc first, then others.
  const sorted = [...state.notes].sort((a, b) => (b.docId === focusId) - (a.docId === focusId) || a.at - b.at);
  for (const note of sorted) {
    const card = document.createElement("div");
    card.className = "note-card";
    const di = state.docs.findIndex((d) => d.id === note.docId);
    card.innerHTML = `<div class="q"></div><div class="n" contenteditable="plaintext-only" spellcheck="true"></div>
      <div class="meta"><span class="doc-tag">${di >= 0 ? "Doc " + (di + 1) : "Doc"}</span><span>${fmtTime(note.at)}</span><button class="del" title="Delete note">delete</button></div>`;
    $(".q", card).textContent = note.quote.length > 180 ? note.quote.slice(0, 180) + "…" : note.quote;
    const nEl = $(".n", card);
    nEl.textContent = note.note;
    nEl.addEventListener("blur", () => {
      const v = nEl.textContent.trim();
      if (v && v !== note.note) { note.note = v; saveNotes(); }
    });
    nEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); nEl.blur(); } });
    $(".del", card).addEventListener("click", () => {
      state.notes = state.notes.filter((x) => x.id !== note.id);
      saveNotes();
    });
    card.addEventListener("mouseenter", () => paintHighlights(note.id));
    card.addEventListener("mouseleave", () => paintHighlights());
    $(".q", card).addEventListener("click", () => jumpToNote(note));
    list.appendChild(card);
  }
  paintHighlights();
  state.docs.forEach(renderMarginalia);
  document.body.classList.toggle("has-notes", n > 0);
  // composer chip
  $("#attach").hidden = !n;
  $(".attach-count").textContent = n;
  // constellation dots
  updateNav();
}

// Pencil notes in the margin beside the sheet, each level with the words it is about.
function renderMarginalia(d) {
  const box = d.marginEl;
  if (!box) return;
  box.innerHTML = "";
  const notes = state.notes.filter((n) => n.docId === d.id).sort((a, b) => a.start - b.start);
  for (const note of notes) {
    const el = document.createElement("div");
    el.className = "pencil-note";
    el.innerHTML = `<span class="n" contenteditable="plaintext-only" spellcheck="false"></span><button class="del" title="Erase this note" aria-label="Erase this note">×</button>`;
    el.note = note;
    const nEl = $(".n", el);
    nEl.textContent = note.note;
    nEl.addEventListener("blur", () => {
      const v = nEl.textContent.trim();
      if (v && v !== note.note) { note.note = v; saveNotes(); } else nEl.textContent = note.note;
    });
    nEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); nEl.blur(); } });
    $(".del", el).addEventListener("click", (e) => {
      e.stopPropagation();
      state.notes = state.notes.filter((x) => x.id !== note.id);
      saveNotes();
    });
    el.addEventListener("mouseenter", () => paintHighlights(note.id));
    el.addEventListener("mouseleave", () => paintHighlights());
    box.appendChild(el);
  }
  positionMarginalia(d);
}

// Where a note's words sit down the sheet, measured in the sheet's own pixels.
function noteAnchorY(d, note) {
  // The first text node that actually holds the note's first character.
  const walker = document.createTreeWalker(d.bodyEl, NodeFilter.SHOW_TEXT);
  let pos = 0, node, block = null;
  while ((node = walker.nextNode())) {
    if (pos + node.data.length > note.start) { block = node; break; }
    pos += node.data.length;
  }
  while (block && block.parentNode !== d.bodyEl) block = block.parentNode;
  if (!block || block.nodeType !== 1) return 0;
  // How far down its block the first line of the quote starts.
  const r = rangeFromOffsets(d.bodyEl, note.start, note.end);
  const first = r && [...r.getClientRects()].find((q) => q.width > 0.5);
  const dy = first ? Math.max(0, (first.top - block.getBoundingClientRect().top) / (state.cam.s || 1)) : 0;
  return block.offsetTop + d.bodyEl.offsetTop + d.scrollEl.offsetTop - d.scrollEl.scrollTop + dy;
}

function positionMarginalia(d) {
  const H = d.el.clientHeight;
  let floor = 6;
  for (const el of d.marginEl?.children || []) {
    const a = noteAnchorY(d, el.note);
    const y = Math.max(floor, Math.min(a, H - 34));
    el.style.top = y + "px";
    el.classList.toggle("off", a < -12 || a > H - 20); // its words are scrolled out of view
    floor = y + el.offsetHeight + 8;
  }
}

async function jumpToNote(note) {
  const i = state.docs.findIndex((d) => d.id === note.docId);
  if (i < 0) return;
  if (i !== state.focus || state.overview) await focusDoc(i);
  const d = state.docs[i];
  const r = rangeFromOffsets(d.bodyEl, note.start, note.end);
  if (!r) return;
  const rect = r.getBoundingClientRect(), box = d.scrollEl.getBoundingClientRect();
  d.scrollEl.scrollBy({ top: rect.top - box.top - box.height / 3, behavior: "smooth" });
  paintHighlights(note.id);
  setTimeout(() => paintHighlights(), 1400);
}

function pulseChip() {
  const chip = $("#attach-chip");
  chip.style.animation = "none";
  chip.offsetHeight;
  chip.style.animation = "";
}

// ---------------------------------------------------------------- popover

let popTarget = null;

function openPopover(target, rect) {
  popTarget = target;
  pop.hidden = false;
  $(".pop-quick", pop).hidden = false;
  $(".pop-write", pop).hidden = true;
  positionPopover(rect);
}

function positionPopover(rect) {
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const touch = matchMedia("(pointer: coarse)").matches;
  let top = touch ? rect.bottom + 12 : rect.top - ph - 10;
  if (top < 64) top = rect.bottom + 10;
  if (top + ph > innerHeight - 10) top = innerHeight - ph - 10;
  let left = rect.left + rect.width / 2 - pw / 2;
  left = Math.max(12, Math.min(innerWidth - pw - 12, left));
  pop.style.top = top + "px";
  pop.style.left = left + "px";
}

function hidePopover() {
  pop.hidden = true;
  popTarget = null;
}

function startWriting() {
  if (!popTarget) return;
  const r = pop.getBoundingClientRect();
  $(".pop-quick", pop).hidden = true;
  $(".pop-write", pop).hidden = false;
  const ta = $("#pop-input");
  ta.value = "";
  positionPopover(r);
  ta.focus();
}

function commitWrite() {
  const v = $("#pop-input").value.trim();
  if (v && popTarget) addNote(popTarget, v);
  hidePopover();
}

pop.addEventListener("mousedown", (e) => { if (e.target.tagName !== "TEXTAREA") e.preventDefault(); });
pop.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || !popTarget) return;
  if (b.dataset.quick) { addNote(popTarget, b.dataset.quick); hidePopover(); }
  else if (b.dataset.action === "note") startWriting();
  else if (b.id === "pop-save") commitWrite();
});
$("#pop-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitWrite(); }
  if (e.key === "Escape") { e.preventDefault(); hidePopover(); }
  e.stopPropagation();
});

function checkSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const d = state.docs[state.focus];
  if (!d || d.streaming || state.overview) return;
  if (!d.bodyEl.contains(range.commonAncestorContainer)) return;
  const quote = sel.toString().trim();
  if (quote.length < 2) return;
  const start = textOffset(d.bodyEl, range.startContainer, range.startOffset);
  const end = textOffset(d.bodyEl, range.endContainer, range.endOffset);
  openPopover({ doc: d, start, end, quote }, range.getBoundingClientRect());
}

docsEl.addEventListener("mouseup", () => setTimeout(checkSelection, 0));
docsEl.addEventListener("touchend", () => setTimeout(checkSelection, 250));
document.addEventListener("selectionchange", () => {
  if (!matchMedia("(pointer: coarse)").matches) return;
  clearTimeout(checkSelection.t);
  checkSelection.t = setTimeout(checkSelection, 450);
});
document.addEventListener("mousedown", (e) => {
  if (!pop.hidden && !pop.contains(e.target) && !e.target.closest(".gutter")) hidePopover();
});

// ---------------------------------------------------------------- sending

function setBusy(b) {
  state.busy = b;
  document.body.classList.toggle("busy", b);
  $("#btn-send").disabled = b;
}

function canSend() {
  return !state.busy && (input.value.trim() || state.notes.length);
}

async function send() {
  if (!canSend()) return;
  const text = input.value;
  const notes = state.notes.map(({ quote, note, docTitle }) => ({ quote, note, docTitle }));
  const sentNotes = state.notes;
  input.value = "";
  autoGrow();
  state.notes = [];
  saveNotes();
  setBusy(true);

  const d = makeDoc({ id: "pending-" + Date.now(), text: "", title: "…", streaming: true, at: Date.now(), user: { display: { text, notes } } });
  state.docs.push(d);
  renumber();
  placeDocs();
  d.bodyEl.innerHTML = thinkingMarkup();
  const flown = focusDoc(state.docs.length - 1);

  let first = true, dirty = false;
  const acts = [];
  const showActs = () => {
    const el = d.bodyEl.querySelector(".activity");
    if (el) el.innerHTML = acts.slice(-4).map((a) => `<div>${esc(a)}</div>`).join("");
  };
  const flush = () => {
    if (!dirty) return;
    dirty = false;
    // No auto-scroll: you read from the top while the rest writes itself below.
    renderBody(d);
  };

  try {
    const res = await fetch(`/api/threads/${state.thread.id}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, notes }),
    });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let failed = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = /^event: (.+)$/m.exec(raw)?.[1];
        const data = JSON.parse(/^data: (.+)$/m.exec(raw)?.[1] || "{}");
        if (ev === "user") d.user = data;
        else if (ev === "activity") { acts.push(data.text); showActs(); }
        else if (ev === "reset") {
          // The text so far was a preamble before Claude looked something up.
          d.text = "";
          first = true;
          d.bodyEl.innerHTML = thinkingMarkup();
          showActs();
        }
        else if (ev === "delta" && data.text) {
          if (first) { first = false; await flown; d.bodyEl.innerHTML = ""; }
          d.text += data.text;
          if (!dirty) { dirty = true; requestAnimationFrame(flush); }
        } else if (ev === "usage") {
          // usage is available here if we want a cost readout later
        } else if (ev === "done") {
          Object.assign(d, { id: data.doc.id, title: data.doc.title, at: data.doc.at });
          setPadTitle(d);
          state.thread.title = data.threadTitle;
          updateCrumb();
        } else if (ev === "error") failed = data;
      }
    }
    if (failed) throw Object.assign(new Error(failed.message), { restore: true });
    dirty = true;
    flush();
    finalizeDoc(d);
    updateNav();
  } catch (err) {
    // Put everything back so nothing is lost.
    d.el.remove();
    state.docs.splice(state.docs.indexOf(d), 1);
    renumber();
    placeDocs();
    input.value = text;
    autoGrow();
    state.notes = [...sentNotes, ...state.notes];
    saveNotes();
    toast(err.message || "Something went wrong", true);
    if (state.docs.length) focusDoc(state.docs.length - 1);
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------- threads

const WELCOME = `# Welcome to Shell

> Every answer I give you is a document. React right on it. Your notes come back to me together, with no copy-paste.

## How it works

1. **Ask** in the bar at the bottom. Type, or tap the mic and talk.
2. **Read** my reply. It lands here as a doc, like this one.
3. **React.** Select any words and pick a reaction, or tap the **+** beside a paragraph.
4. **Send.** All your notes go back in one batch. I answer each one.

## Moving around

- **← →** fly between docs in this thread.
- **O** zooms out. Docs turn into lily pads. Press **O** again to see all your projects on the river.
- **T** opens this project's threads. **N** starts a new one.

## Try it now

Select this sentence and tap **✓ Yes**. Watch it land in pencil in the margin.`;

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function openThread(id, { intro = true } = {}) {
  const t = await api(`/api/threads/${id}`);
  state.thread = t;
  state.projectId = t.projectId;
  try { localStorage.setItem("shell.lastThread", id); } catch {}
  updateCrumb();
  docsEl.innerHTML = "";
  state.docs = [];
  let lastUser = null;
  for (const turn of t.turns) {
    if (turn.role === "user") { lastUser = turn; continue; }
    state.docs.push(makeDoc({ id: turn.id, text: turn.text, title: turn.title, at: turn.at, user: lastUser }));
    lastUser = null;
  }
  if (!state.docs.length) {
    state.docs.push(makeDoc({ id: "welcome", text: WELCOME, title: "Welcome to Shell", local: true, at: Date.now() }));
  }
  for (const d of state.docs) { renderBody(d, { animate: false }); addGutters(d); }
  renumber();
  placeDocs();
  loadNotes();
  renderNotes();
  closeDrawer();
  const last = state.docs.length - 1;
  if (intro) {
    // Start far out, then dive into the latest doc.
    const o = camForOverview();
    Object.assign(state.cam, { ...o, s: o.s * 0.25, r: -25 });
    applyCam();
    await focusDoc(last, { duration: reduceMotion ? 1 : 2000 });
  } else focusDoc(last);
  if (!matchMedia("(pointer: coarse)").matches) input.focus({ preventScroll: true });
  if (innerWidth <= 760) input.placeholder = "Ask anything";
}

async function newThread(projectId = state.projectId) {
  const t = await api("/api/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId }) });
  await openThread(t.id);
}

const projectName = (id) => state.projects.find((p) => p.id === id)?.name || "";

function updateCrumb() {
  $("#crumb-project").textContent = projectName(state.projectId);
  $("#thread-title").textContent = state.thread?.title || "";
}

async function refreshThreadList() {
  const all = await api("/api/threads");
  const list = all.filter((t) => !state.projectId || t.projectId === state.projectId);
  $("#drawer .label").textContent = projectName(state.projectId) || "Threads";
  $("#drawer-new").textContent = `+ New thread${state.projectId ? " in " + projectName(state.projectId) : ""}`;
  const el = $("#thread-list");
  el.innerHTML = "";
  for (const t of list) {
    const b = document.createElement("button");
    b.className = "thread-item" + (t.id === state.thread?.id ? " on" : "");
    b.innerHTML = `<span class="t"></span><span class="m">${t.docs} doc${t.docs === 1 ? "" : "s"} · ${new Date(t.updated).toLocaleDateString([], { month: "short", day: "numeric" })}</span>`;
    $(".t", b).textContent = t.title;
    b.addEventListener("click", () => openThread(t.id));
    el.appendChild(b);
  }
  return all;
}

function openDrawer() {
  refreshThreadList();
  $("#drawer").classList.add("open");
  $("#drawer-scrim").hidden = false;
}
function closeDrawer() {
  $("#drawer").classList.remove("open");
  $("#drawer-scrim").hidden = true;
}

// ---------------------------------------------------------------- HUD

function updateNav() {
  $("#constellation").innerHTML = '<div class="track"></div>';
  const c = $("#constellation .track");
  const noteDocs = new Set(state.notes.map((n) => n.docId));
  state.docs.forEach((d, i) => {
    if (i) c.appendChild(document.createElement("i"));
    const b = document.createElement("button");
    b.className = (i === state.focus && !state.overview ? "on " : "") + (noteDocs.has(d.id) ? "has-notes" : "");
    b.dataset.tip = d.title || `Doc ${i + 1}`;
    b.setAttribute("aria-label", d.title || `Doc ${i + 1}`);
    b.innerHTML = "<span></span>";
    b.addEventListener("click", () => focusDoc(i));
    c.appendChild(b);
  });
  $("#nav-prev").disabled = state.focus <= 0;
  $("#nav-next").disabled = state.focus >= state.docs.length - 1;
}

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", err);
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), err ? 6000 : 2600);
}

function tickClock() {
  $("#clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function autoGrow() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, innerHeight * 0.3) + "px";
}

// ---------------------------------------------------------------- printmaking textures
// Everything is printed on paper: handmade-paper fibres, woodgrain from the
// block, halftone dots for the sky. Textures are drawn once, then reused.

const rnd = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function makeGrain(size = 512, seed = 11) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const r = rnd(seed);
  // Long wavy fibres of a woodblock, tiling seamlessly in both directions.
  for (let i = 0; i < 170; i++) {
    const y0 = r() * size, a = 1 + r() * 7, k = 1 + Math.floor(r() * 3), p = r() * 6.28;
    const dark = r() < 0.72;
    g.strokeStyle = dark ? `rgba(60,45,30,${0.05 + r() * 0.11})` : `rgba(255,255,255,${0.08 + r() * 0.14})`;
    g.lineWidth = 0.4 + r() * 1.8;
    for (const dy of [-size, 0, size]) {
      g.beginPath();
      for (let x = 0; x <= size; x += 4) {
        const y = y0 + dy + Math.sin((x / size) * Math.PI * 2 * k + p) * a + Math.sin((x / size) * Math.PI * 2 * (k + 3) + p * 2) * a * 0.3;
        x ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    }
  }
  return c;
}

function makeWashi(size = 384, seed = 7) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const r = rnd(seed);
  // Speckle
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = r() < 0.5 ? `rgba(120,100,70,${r() * 0.07})` : `rgba(255,255,250,${r() * 0.25})`;
    g.fillRect(r() * size, r() * size, 1, 1);
  }
  // Fibres: short curls, some light, some a touch darker
  for (let i = 0; i < 230; i++) {
    const x = r() * size, y = r() * size, len = 6 + r() * 26, ang = r() * 6.28, bend = (r() - 0.5) * 0.9;
    g.strokeStyle = r() < 0.65 ? `rgba(255,255,248,${0.25 + r() * 0.35})` : `rgba(140,115,80,${0.05 + r() * 0.08})`;
    g.lineWidth = 0.3 + r() * 0.8;
    for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) {
      g.beginPath();
      g.moveTo(x + ox, y + oy);
      g.quadraticCurveTo(x + ox + Math.cos(ang + bend) * len * 0.6, y + oy + Math.sin(ang + bend) * len * 0.6, x + ox + Math.cos(ang) * len, y + oy + Math.sin(ang) * len);
      g.stroke();
    }
  }
  return c;
}

const TEX = { grain: makeGrain(), washi: makeWashi() };
document.documentElement.style.setProperty("--grain", `url(${TEX.grain.toDataURL()})`);
document.documentElement.style.setProperty("--washi", `url(${TEX.washi.toDataURL()})`);

// ---------------------------------------------------------------- paper and light
// The ground is one bare sheet of washi. Nothing is drawn on it. What changes
// with the real time of day (?hour=19 previews dusk) is the light: the tone of
// the paper, and the direction and length of the shadow the reading sheet casts.

const PAPER = [229, 221, 205];
const SCENES = [
  { h: 0,    ink: "#2d3b55", dens: 0.82 },
  { h: 5.5,  ink: "#6d5a78", dens: 0.55 },
  { h: 7.5,  ink: "#b88a83", dens: 0.3 },
  { h: 12,   ink: "#8a8f8c", dens: 0.2 },
  { h: 17.5, ink: "#c0905a", dens: 0.32 },
  { h: 19.6, ink: "#5e5478", dens: 0.6 },
  { h: 21.5, ink: "#2f3d57", dens: 0.8 },
  { h: 24,   ink: "#2d3b55", dens: 0.82 },
];
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

function sceneAt(hour) {
  let i = 0;
  while (SCENES[i + 1].h <= hour) i++;
  const A = SCENES[i], B = SCENES[i + 1];
  const t = (hour - A.h) / (B.h - A.h);
  const st = t * t * (3 - 2 * t);
  return { ink: mix(hex(A.ink), hex(B.ink), st), dens: A.dens + (B.dens - A.dens) * st };
}

// One light source. By day it crosses from the left (morning) to the right
// (evening): shadows fall away from it, short at noon and long near the horizon.
// At night a single lamp sits high and a little to the right.
function lightAt(hour) {
  if (hour < 6 || hour > 18.5) return { sx: -0.22, sy: 0.62, sa: 1.25 };
  const arc = (hour - 6) / 12.5, el = Math.sin(Math.PI * arc), len = 1.5 - 0.85 * el;
  return { sx: Math.cos(Math.PI * arc) * len, sy: (0.45 + 0.3 * el) * len, sa: 1 };
}

function landscape() {
  const cv = $("#stars"), ctx = cv.getContext("2d");
  const params = new URLSearchParams(location.search);
  const hourNow = () => {
    if (params.has("hour")) return Number(params.get("hour")) % 24;
    const d = new Date();
    return d.getHours() + d.getMinutes() / 60;
  };
  let W, H, dpr, scene, light, sceneT = -Infinity, washiPat, last = "";

  const resize = () => {
    dpr = Math.min(1.5, devicePixelRatio || 1);
    W = cv.width = Math.round(innerWidth * dpr); H = cv.height = Math.round(innerHeight * dpr);
    washiPat = ctx.createPattern(TEX.washi, "repeat");
    last = "";
  };
  resize();
  addEventListener("resize", resize);

  const frame = (now) => {
    if (now - sceneT > 30000) {
      const hr = hourNow();
      scene = sceneAt(hr); light = lightAt(hr); sceneT = now; last = "";
      document.body.classList.toggle("night", scene.dens > 0.6);
      const rs = document.documentElement.style;
      rs.setProperty("--sx", light.sx.toFixed(3));
      rs.setProperty("--sy", light.sy.toFixed(3));
      rs.setProperty("--sa", light.sa.toFixed(2));
      // Water is always a pale printed blue, just dimmed a little at night.
      rs.setProperty("--water-a", rgb(mix([150, 182, 198], [52, 66, 92], Math.max(0, scene.dens - 0.3) * 0.6)));
      rs.setProperty("--water-b", rgb(mix([136, 170, 188], [48, 62, 88], Math.max(0, scene.dens - 0.3) * 0.6)));
      rs.setProperty("--bank", rgb(mix(scene.ink, [70, 90, 110], 0.5)));
    }
    // Only repaint when the camera has moved: the paper is still otherwise.
    const c = state.cam, { cx = 0, cy = 0 } = state.layout;
    const key = [c.x, c.y, c.s, c.r, cx, cy].map((v) => v.toFixed(2)).join();
    if (key !== last) {
      last = key;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = rgb(mix(PAPER, scene.ink, scene.dens * 0.42));
      ctx.fillRect(0, 0, W, H);

      // The paper's fibres belong to the world, not the screen: they slide, turn
      // and scale with the camera, so sheets feel laid on a real surface.
      const fs = Math.max(0.55, c.s); // keep fibres from turning to dust far out
      washiPat.setTransform(new DOMMatrix().translate(cx * dpr, cy * dpr).scale(fs * dpr).rotate(-c.r).translate(-c.x * (c.s / fs), -c.y * (c.s / fs)));
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = washiPat;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;

      // Light pools on the side it comes from and falls off toward the other.
      const n = Math.hypot(light.sx, light.sy) || 1, ux = light.sx / n, uy = light.sy / n, R = Math.hypot(W, H) * 0.55;
      const lg = ctx.createLinearGradient(W / 2 - ux * R, H / 2 - uy * R, W / 2 + ux * R, H / 2 + uy * R);
      lg.addColorStop(0, "rgba(255,252,244,0.20)");
      lg.addColorStop(0.5, "rgba(255,252,244,0)");
      lg.addColorStop(1, `rgba(30,24,18,${0.13 + scene.dens * 0.12})`);
      ctx.fillStyle = lg;
      ctx.fillRect(0, 0, W, H);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- the river (all projects)
// Zoomed all the way out, each project is a lily pad on a river. Client work
// floats in its own pond, kept apart from personal projects.

const riverWorld = $("#river-world");

async function loadProjects() {
  state.projects = await api("/api/projects");
  return state.projects;
}

function riverGeometry() {
  const portrait = innerHeight > innerWidth * 1.15;
  // Design in a 1600×1000 landscape; on tall screens, turn it on its side.
  const T = portrait ? ([x, y]) => [y * 0.95, x] : ([x, y]) => [x, y];
  const W = portrait ? 950 : 1600, H = portrait ? 1600 : 1000;
  const at = (t) => [-150 + 1900 * t, 360 + 120 * Math.sin(t * Math.PI * 2 + 0.5)];
  const river = Array.from({ length: 61 }, (_, i) => T(at(i / 60)));
  const pond = { c: T([1220, 800]), rx: portrait ? 170 : 330, ry: portrait ? 330 : 150 };
  return { portrait, T, W, H, at, river, pond };
}

function renderRiver() {
  const g = riverGeometry();
  const personal = state.projects.filter((p) => p.group !== "client");
  const clients = state.projects.filter((p) => p.group === "client");
  const pathD = g.river.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [pcx, pcy] = g.pond.c;
  $("#river-svg").setAttribute("viewBox", `0 0 ${g.W} ${g.H}`);
  $("#river-svg").setAttribute("width", g.W);
  $("#river-svg").setAttribute("height", g.H);
  $("#river-svg").innerHTML = `
    <defs><pattern id="grainpat" patternUnits="userSpaceOnUse" width="512" height="512"><image href="${TEX.grain.toDataURL()}" width="512" height="512" /></pattern></defs>
    <path class="bank" d="${pathD}" />
    <path class="water" d="${pathD}" />
    <path class="grainline" d="${pathD}" />
    <path class="shimmer" d="${pathD}" />
    <path class="shimmer two" d="${pathD}" />
    <ellipse class="bank" cx="${pcx}" cy="${pcy}" rx="${g.pond.rx + 30}" ry="${g.pond.ry + 30}" />
    <ellipse class="water" cx="${pcx}" cy="${pcy}" rx="${g.pond.rx}" ry="${g.pond.ry}" />
    <ellipse class="grainfill" cx="${pcx}" cy="${pcy}" rx="${g.pond.rx}" ry="${g.pond.ry}" />
    <ellipse class="shimmer" cx="${pcx}" cy="${pcy}" rx="${g.pond.rx * 0.8}" ry="${g.pond.ry * 0.7}" />`;

  const pads = $("#pads");
  pads.innerHTML = "";
  state.riverPads = {};
  const place = (p, x, y, ghost = false) => {
    const recent = p.threads?.[0] && Date.now() - p.threads[0].updated < 36e5 * 24;
    const size = ghost ? 150 : 160 + 14 * Math.min(p.threads?.length || 0, 6);
    const b = document.createElement(ghost ? "div" : "button");
    b.className = "lilypad" + (recent ? " bloom" : "") + (ghost ? " ghost" : "") + (p.id === state.projectId ? " here" : "");
    b.style.cssText = `left:${x - size / 2}px;top:${y - size / 2}px;width:${size}px;height:${size}px;--d:${(x % 7).toFixed(1)}s`;
    b.innerHTML = `<span class="lily"></span><span class="pad-name"></span><span class="pad-meta"></span>`;
    $(".pad-name", b).textContent = p.name;
    if (!ghost) {
      const n = p.threads?.length || 0;
      $(".pad-meta", b).textContent = n ? `${n} thread${n === 1 ? "" : "s"}` : "start here";
      b.addEventListener("click", () => enterProject(p.id));
      state.riverPads[p.id] = { x, y };
    } else $(".pad-meta", b).textContent = "add one in projects.json";
    pads.appendChild(b);
  };
  personal.forEach((p, i) => {
    const t = (i + 0.7) / (personal.length + 0.4);
    const [x, y] = g.T(g.at(Math.min(0.92, t * 0.85 + 0.04)));
    place(p, x, y + (g.portrait ? 0 : i % 2 ? 26 : -26));
  });
  if (clients.length) {
    clients.forEach((p, i) => {
      const k = (i + 1) / (clients.length + 1) - 0.5;
      const [x, y] = g.portrait ? [pcx, pcy + k * g.pond.ry * 1.6] : [pcx + k * g.pond.rx * 1.6, pcy];
      place(p, x, y);
    });
  } else place({ name: "Client work" }, pcx, pcy, true);

  const labels = g.portrait
    ? [["Your projects", 250, -70], ["Clients", pcx - g.pond.rx + 20, pcy - g.pond.ry - 80]]
    : [["Your projects", 90, 120], ["Clients", pcx - 60, pcy - g.pond.ry - 80]];
  for (const [txt, x, y] of labels) {
    const l = document.createElement("div");
    l.className = "river-label";
    l.style.cssText = `left:${x}px;top:${y}px`;
    l.textContent = txt;
    pads.appendChild(l);
  }
  riverWorld.style.width = g.W + "px";
  riverWorld.style.height = g.H + "px";
  return g;
}

function riverFit(g) {
  const topH = state.layout.topH;
  const s = Math.min(innerWidth / g.W, (innerHeight - topH) / g.H) * 0.94;
  return { x: g.W / 2, y: g.H / 2, s, oy: topH / 2 };
}

function setRiverCam(c, animate) {
  riverWorld.style.transition = animate && !reduceMotion ? "transform 1.6s var(--ease), opacity 1.2s var(--ease)" : "none";
  riverWorld.style.transform = `translate(${innerWidth / 2}px, ${innerHeight / 2 + (c.oy || 0)}px) scale(${c.s}) translate(${-c.x}px, ${-c.y}px)`;
}

async function showRiver({ instant = false } = {}) {
  if (state.view === "river" && !instant) return;
  hidePopover();
  closeDrawer();
  await loadProjects().catch(() => {});
  const g = renderRiver();
  const fit = riverFit(g);
  const pad = state.riverPads[state.projectId];
  // Labels stay one readable size whatever the zoom.
  riverWorld.style.setProperty("--rs", fit.s.toFixed(3));
  state.view = "river";
  document.body.classList.add("river");
  if (instant) {
    setRiverCam(fit, false);
    return;
  }
  // The docs sink away while the river rises up from this project's pad.
  if (state.docs.length) {
    const o = camForOverview();
    flyTo({ ...o, s: o.s * 0.2, r: 0 }, { dip: false, duration: 1200 });
  }
  setRiverCam(pad ? { ...fit, x: pad.x, y: pad.y, s: fit.s * 3 } : { ...fit, s: fit.s * 1.6 }, false);
  riverWorld.offsetWidth; // commit the start position before animating
  setRiverCam(fit, true);
}

async function enterProject(pid, threadId) {
  const g = riverGeometry();
  const fit = riverFit(g);
  const pad = state.riverPads[pid];
  if (pad) setRiverCam({ ...fit, x: pad.x, y: pad.y, s: fit.s * 3.2 }, true);
  await new Promise((r) => setTimeout(r, reduceMotion ? 0 : 650));
  state.view = "thread";
  document.body.classList.remove("river");
  state.projectId = pid;
  const proj = state.projects.find((p) => p.id === pid);
  const target = threadId && (!proj || proj.threads.some((t) => t.id === threadId)) ? threadId : proj?.threads?.[0]?.id;
  if (target) await openThread(target);
  else await newThread(pid);
}

// ---------------------------------------------------------------- overview pan / zoom

function overviewControls() {
  const vp = $("#viewport");
  let drag = null;
  vp.addEventListener("pointerdown", (e) => {
    if (!state.overview || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, cam: { ...state.cam }, moved: false };
  });
  addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    state.cam.x = drag.cam.x - dx / state.cam.s;
    state.cam.y = drag.cam.y - dy / state.cam.s;
    applyCam();
  });
  addEventListener("pointerup", () => { if (drag?.moved) suppressClick = true; drag = null; setTimeout(() => (suppressClick = false), 0); });
  let suppressClick = false;
  vp.addEventListener("click", (e) => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
  vp.addEventListener("wheel", (e) => {
    if (state.overview) {
      e.preventDefault();
      const f = Math.exp(-e.deltaY * 0.0015);
      state.cam.s = Math.max(0.05, Math.min(1.2, state.cam.s * f));
      applyCam();
    } else if (e.ctrlKey && e.deltaY > 0) {
      // pinch out on a trackpad → zoom to overview
      e.preventDefault();
      toggleOverview(true);
    }
  }, { passive: false });
}

// ---------------------------------------------------------------- voice

function voice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  const btn = $("#btn-mic");
  btn.hidden = false;
  let rec = null, base = "";
  btn.addEventListener("click", () => {
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    base = input.value ? input.value.replace(/\s*$/, " ") : "";
    rec.onresult = (e) => {
      let txt = "";
      for (const r of e.results) txt += r[0].transcript;
      input.value = base + txt;
      autoGrow();
    };
    rec.onend = () => { rec = null; btn.classList.remove("listening"); document.body.classList.remove("listening"); };
    rec.onerror = () => rec?.stop();
    rec.start();
    btn.classList.add("listening");
    document.body.classList.add("listening");
  });
}

// ---------------------------------------------------------------- wiring

input.addEventListener("input", autoGrow);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
$("#btn-send").addEventListener("click", send);
$("#btn-threads").addEventListener("click", openDrawer);
$("#drawer-close").addEventListener("click", closeDrawer);
$("#drawer-scrim").addEventListener("click", closeDrawer);
$("#drawer-new").addEventListener("click", () => newThread());
$("#btn-new").addEventListener("click", () => (state.view === "river" ? null : newThread()));
$("#brand").addEventListener("click", () => (state.view === "river" ? enterProject(state.projectId, state.thread?.id) : showRiver()));
$("#drawer-river").addEventListener("click", () => { closeDrawer(); showRiver(); });
$("#btn-overview").addEventListener("click", zoomOut);
$("#nav-prev").addEventListener("click", () => focusDoc(state.focus - 1));
$("#nav-next").addEventListener("click", () => focusDoc(state.focus + 1));
$("#attach-chip").addEventListener("click", () => $("#notes-panel").classList.toggle("open"));
$("#notes-close").addEventListener("click", () => $("#notes-panel").classList.remove("open"));
$("#attach-clear").addEventListener("click", () => {
  if (!confirm(`Discard ${state.notes.length} notes?`)) return;
  state.notes = [];
  saveNotes();
});

addEventListener("keydown", (e) => {
  const typing = e.target.closest?.("textarea, input, [contenteditable]");
  if (!pop.hidden && !typing && popTarget) {
    const map = { y: "Yes", x: "No", w: "Why?", m: "More" };
    const k = e.key.toLowerCase();
    if (map[k]) { e.preventDefault(); addNote(popTarget, map[k]); hidePopover(); return; }
    if (k === "n" || k === "enter") { e.preventDefault(); startWriting(); return; }
    if (k === "escape") { hidePopover(); return; }
  }
  if (typing) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (state.view === "river") {
    if (e.key === "Escape" || e.key === "o" || e.key === "O") enterProject(state.projectId, state.thread?.id);
    return;
  }
  if (e.key === "ArrowRight") { e.preventDefault(); focusDoc(Math.min(state.docs.length - 1, state.focus + 1)); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); focusDoc(Math.max(0, state.focus - 1)); }
  else if (e.key === "o" || e.key === "O") zoomOut();
  else if (e.key === "Escape") { if (state.overview) toggleOverview(false); closeDrawer(); }
  else if (e.key === "t" || e.key === "T") openDrawer();
  else if (e.key === "n" || e.key === "N") newThread();
  else if (e.key === "p" || e.key === "P") showRiver();
  else if (e.key === "/") { e.preventDefault(); input.focus(); }
});

let resizeT;
addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    measure();
    placeDocs();
    Object.assign(state.cam, state.overview ? camForOverview() : state.focus >= 0 ? camForDoc(state.focus) : state.cam);
    applyCam();
  }, 80);
});

// Chrome gets out of the way: after a few still seconds only the sheet remains.
function quietChrome() {
  if (!matchMedia("(hover: hover)").matches) return;
  let t;
  const wake = () => {
    document.body.classList.remove("idle");
    clearTimeout(t);
    t = setTimeout(() => document.body.classList.add("idle"), 3200);
  };
  addEventListener("pointermove", wake, { passive: true });
  addEventListener("pointerdown", wake, { passive: true });
  addEventListener("keydown", (e) => { if (!e.target.closest?.("textarea, input, [contenteditable]")) wake(); });
  wake();
}

async function boot() {
  measure();
  quietChrome();
  landscape();
  overviewControls();
  voice();
  tickClock();
  setInterval(tickClock, 15000);
  try {
    const s = await api("/api/status");
    const st = $("#status");
    st.classList.toggle("live", s.live);
    $(".status-text", st).textContent = { plan: "Your plan", api: "API", demo: "Demo" }[s.engine] || "Demo";
    st.title = s.engine === "plan" ? `Running on your Claude plan via Claude Code. Tools: ${s.tools.join(", ")}` : s.engine === "api" ? `Claude API · ${s.model}` : "Demo mode: replies are canned. See README.";
  } catch {}
  await loadProjects();
  const list = await api("/api/threads");
  let last = null;
  try { last = localStorage.getItem("shell.lastThread"); } catch {}
  const pick = list.find((t) => t.id === last) || list[0];
  // Open on the river for a moment, then glide into where you left off.
  state.projectId = pick?.projectId || state.projects[0]?.id;
  await showRiver({ instant: true });
  await new Promise((r) => setTimeout(r, reduceMotion ? 0 : 1100));
  await enterProject(state.projectId, pick?.id);
}

boot();
