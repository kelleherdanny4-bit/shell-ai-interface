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
  view: "thread", // "thread" (docs) or "sky" (all projects)
  projects: [],
  projectId: null,
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
    d.el.style.setProperty("--rot", p.r + "deg");
  });
  drawLinks();
  buildSky();
}

// A pencil line joins one doc to the next.
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
  linksEl.innerHTML = `<path class="trail" d="${path}" />`;
}

// ---------------------------------------------------------------- camera

function applyCam() {
  const { cx, cy } = state.layout;
  const c = state.cam;
  world.style.transform = `translate(${cx}px,${cy}px) scale(${c.s}) rotate(${-c.r}deg) translate(${-c.x}px,${-c.y}px)`;
  // Semantic zoom: far away, docs turn into clouds that show only a title;
  // further still they melt into the sky and the projects' clouds come out.
  document.body.classList.toggle("far", c.s < 0.5 && !state.holdNear);
  world.style.setProperty("--inv", (1 / c.s).toFixed(4));
  const lw = levelW(c.s);
  const dv = smooth(0.35, 0.85, lw), sv = 1 - smooth(0.12, 0.55, lw);
  docsEl.style.opacity = linksEl.style.opacity = dv.toFixed(3);
  docsEl.style.visibility = dv < 0.01 ? "hidden" : "";
  skyEl.style.opacity = sv.toFixed(3);
  skyEl.style.visibility = sv < 0.01 ? "hidden" : "";
  document.body.classList.toggle("high", lw < 0.5);
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
  setView("thread");
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

// O zooms out one level: doc → the thread's clouds → the sky of projects.
function zoomOut() {
  if (state.view === "sky") return;
  if (state.overview) return showSky();
  toggleOverview(true);
}

function toggleOverview(on = !state.overview) {
  if (!state.docs.length) return;
  if (!on) return focusDoc(Math.max(0, state.focus));
  setView("thread");
  state.overview = true;
  document.body.classList.add("overview");
  $("#btn-overview").classList.add("active");
  hidePopover();
  updateNav();
  flyTo(camForOverview(), { dip: false, duration: reduceMotion ? 1 : 1500 });
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
    <div class="pad" aria-hidden="true"><span class="pad-title"></span><span class="pad-meta"></span></div>`;
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
  $(".pad-meta", d.el).textContent = d.streaming ? "" : fmtTime(d.at);
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
  input.blur(); // the reply is a doc to read; letter keys go back to moving around
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
- **O** zooms out. Docs turn into clouds. Press **O** again to rise into the sky, where every project is a cloud.
- **T** opens this project's threads. **N** starts a new one.

## Try it now

Select this sentence and tap **✓ Yes**. Watch it land in pencil in the margin.`;

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// from: "sky" when diving down out of a project's cloud, "boot" on first load,
// otherwise a short glide in from just above the thread.
async function openThread(id, { from = "near" } = {}) {
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
  for (const d of state.docs) { renderBody(d, { animate: false }); addGutters(d); setPadTitle(d); }
  renumber();
  placeDocs();
  loadNotes();
  renderNotes();
  closeDrawer();
  const last = state.docs.length - 1;
  if (from === "boot" && SKY.g) {
    // Open on the sky, hold a breath, then sink into this project's cloud.
    Object.assign(state.cam, camForSky());
    setView("sky");
    applyCam();
    await new Promise((r) => setTimeout(r, reduceMotion ? 0 : 1300));
    await focusDoc(last, { duration: reduceMotion ? 1 : 3000, dip: false });
  } else if (from === "sky" && SKY.g) {
    // The camera was over this project's cloud; the cloud now sits on the latest doc.
    Object.assign(state.cam, { x: SKY.origin.x, y: SKY.origin.y, r: 0 });
    applyCam();
    await focusDoc(last, { duration: reduceMotion ? 1 : 2600, dip: false });
  } else {
    const o = camForOverview();
    Object.assign(state.cam, { ...o, s: o.s * 0.6, r: -6 });
    applyCam();
    await focusDoc(last, { duration: reduceMotion ? 1 : 1900, dip: false });
  }
  if (innerWidth <= 760) input.placeholder = "Ask anything";
}

async function newThread(projectId = state.projectId, opts) {
  const t = await api("/api/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId }) });
  await openThread(t.id, opts);
  loadProjects().catch(() => {});
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

function makeWashi(size = 512, seed = 7) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const r = rnd(seed);
  // Speckle
  for (let i = 0; i < 4600; i++) {
    g.fillStyle = r() < 0.5 ? `rgba(120,100,70,${r() * 0.07})` : `rgba(255,255,250,${r() * 0.25})`;
    g.fillRect(r() * size, r() * size, 1, 1);
  }
  // Fibres: short curls, some light, some a touch darker
  for (let i = 0; i < 410; i++) {
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

// ---------------------------------------------------------------- paper, light and sky
// One world, one camera. Up close it is a bare sheet of washi. Zoom out and a
// pale blue sky is printed over it in halftone dots; the clouds are the paper
// the press left unprinted. Each doc is a small cloud, each project a large
// one, and the cloud you dive into opens out into the paper you read on.
// The light follows the real time of day (?hour=19 previews dusk).

const PAPER = [229, 221, 205];
const SCENES = [
  { h: 0,    ink: "#2d3b55", dens: 0.82, blue: "#1d335e", sky: 0.92 },
  { h: 5.5,  ink: "#6d5a78", dens: 0.55, blue: "#3e5a8e", sky: 0.74 },
  { h: 7.5,  ink: "#b88a83", dens: 0.3,  blue: "#78a5d4", sky: 0.4 },
  { h: 12,   ink: "#8a8f8c", dens: 0.2,  blue: "#7fb2e0", sky: 0.3 },
  { h: 17.5, ink: "#c0905a", dens: 0.32, blue: "#6a97cc", sky: 0.46 },
  { h: 19.6, ink: "#5e5478", dens: 0.6,  blue: "#3a5488", sky: 0.74 },
  { h: 21.5, ink: "#2f3d57", dens: 0.8,  blue: "#22386a", sky: 0.88 },
  { h: 24,   ink: "#2d3b55", dens: 0.82, blue: "#1d335e", sky: 0.92 },
];
const RED = [207, 79, 54], GRAPHITE = [52, 48, 44];
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function sceneAt(hour) {
  let i = 0;
  while (SCENES[i + 1].h <= hour) i++;
  const A = SCENES[i], B = SCENES[i + 1];
  const t = (hour - A.h) / (B.h - A.h);
  const st = t * t * (3 - 2 * t);
  return {
    ink: mix(hex(A.ink), hex(B.ink), st), dens: A.dens + (B.dens - A.dens) * st,
    blue: mix(hex(A.blue), hex(B.blue), st), sky: A.sky + (B.sky - A.sky) * st,
  };
}

// One light source. By day it crosses from the left (morning) to the right
// (evening): shadows fall away from it, short at noon and long near the horizon.
// At night a single lamp sits high and a little to the right.
function lightAt(hour) {
  if (hour < 6 || hour > 18.5) return { sx: -0.22, sy: 0.62, sa: 1.25 };
  const arc = (hour - 6) / 12.5, el = Math.sin(Math.PI * arc), len = 1.5 - 0.85 * el;
  return { sx: Math.cos(Math.PI * arc) * len, sy: (0.45 + 0.3 * el) * len, sa: 1 };
}

const hourParam = new URLSearchParams(location.search).get("hour");
const hourNow = () => {
  if (hourParam !== null && !isNaN(Number(hourParam))) return ((Number(hourParam) % 24) + 24) % 24;
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60;
};

// ---- the sky's layout: where every project's cloud floats

const SKY = { K: 40, origin: { x: 0, y: 0 }, g: null, clouds: [], hover: null };
const skyEl = $("#sky");

function hashStr(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 2147483646) + 1;
}

// A cumulus: a low, wide base with billows heaped on top, tallest toward the middle.
function cloudPuffs(seed, W, H) {
  const r = rnd(seed);
  r(); r();
  const puffs = [];
  for (let i = 0; i < 3; i++) puffs.push({ x: (i - 1) * W * 0.27 + (r() - 0.5) * W * 0.04, y: H * 0.2, r: W * 0.22 * (0.9 + r() * 0.2), w: 0.85 });
  const n = 6, lean = (r() - 0.5) * 0.3;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const hump = Math.sin(Math.PI * Math.min(1, Math.max(0, t + lean * (1 - Math.abs(t - 0.5) * 2))));
    const rad = H * (0.3 + 0.44 * hump) * (0.8 + r() * 0.4);
    puffs.push({ x: (t - 0.5) * W * 0.8 + (r() - 0.5) * W * 0.05, y: H * 0.08 - H * 0.36 * hump + (r() - 0.5) * H * 0.12, r: rad, w: 1 });
  }
  return puffs;
}

function skyLayout() {
  const vw = innerWidth, vh = innerHeight, topH = state.layout.topH || 60;
  const portrait = vh > vw * 1.15;
  const FW = portrait ? 800 : 1600, FH = portrait ? 1500 : 1000;
  const personal = state.projects.filter((p) => p.group !== "client");
  const clients = state.projects.filter((p) => p.group === "client");
  const pos = {}, size = {};
  const sz = (p) => { const w = (portrait ? 520 : 380) + 20 * Math.min(p.threads?.length || 0, 6); return [w, w * (portrait ? 0.4 : 0.5)]; };
  const n = personal.length;
  personal.forEach((p, i) => {
    if (portrait) pos[p.id] = [FW / 2 + (i % 2 ? 1 : -1) * FW * 0.1, 190 + (i + 0.5) * (980 / Math.max(1, n))];
    else if (n <= 4) pos[p.id] = [FW * (0.17 + 0.66 * (n === 1 ? 0.5 : i / (n - 1))), 340 + Math.sin(i * 2.2 + 0.9) * 95];
    else {
      const cols = Math.ceil(n / 2), row = i % 2, col = Math.floor(i / 2);
      pos[p.id] = [FW * (0.14 + 0.72 * (cols === 1 ? 0.5 : col / (cols - 1))) + (row ? 80 : -40), 240 + row * 250 + Math.sin(i * 1.7) * 30];
    }
    size[p.id] = sz(p);
  });
  const bankY = portrait ? 1310 : 820;
  const bank = clients.length ? clients : [{ id: "__ghost", name: "Client work", ghost: true, threads: [] }];
  bank.forEach((p, i) => {
    const m = bank.length, k = m === 1 ? 0.5 : i / (m - 1);
    pos[p.id] = portrait ? [FW * (0.3 + 0.4 * k), bankY + 40 + (i % 2) * 90] : [FW * (0.3 + 0.44 * k), bankY + Math.sin(i * 2) * 25];
    size[p.id] = p.ghost ? [330, 160] : sz(p);
  });
  const words = portrait
    ? [["Your projects", 40, 90], ["Clients", 40, bankY - 110]]
    : [["Your projects", 70, 120], ["Clients", 70, bankY - 40]];
  const fit = Math.min(vw / FW, (vh - topH) / FH) * 0.94;
  return { portrait, FW, FH, pos, size, personal, bank, words, topH, sSky: fit / SKY.K };
}

// Sky units → world. The project you are in floats right over its latest doc,
// so diving into its cloud lands you on the page you were reading.
function skyToWorld([x, y]) {
  const g = SKY.g, h = g.pos[state.projectId] || [g.FW / 2, g.FH / 2];
  return { x: SKY.origin.x + (x - h[0]) * SKY.K, y: SKY.origin.y + (y - h[1]) * SKY.K };
}

function camForSky() {
  const g = SKY.g, L = state.layout, s = g.sSky;
  const c = skyToWorld([g.FW / 2, g.FH / 2]);
  return { x: c.x - (L.vw / 2 - L.cx) / s, y: c.y - (g.topH + (L.vh - g.topH) / 2 - L.cy) / s, s, r: 0 };
}

// 1 while you are among a thread's docs, 0 up in the sky of projects.
function levelW(s) {
  const g = SKY.g;
  if (!g) return 1;
  return smooth(Math.log(g.sSky * 2), Math.log(g.sSky * 8), Math.log(s));
}

function ago(ts) {
  if (!ts) return "";
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 864e5);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 7 ? `${days} days ago` : new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

function buildSky() {
  if (!state.projects.length) return;
  SKY.g = skyLayout();
  const last = state.docs[state.docs.length - 1];
  SKY.origin = last ? { x: last.pos.x, y: last.pos.y } : { x: 0, y: 0 };
  const { docW } = state.layout, tid = state.thread?.id || "";
  SKY.clouds = state.docs.map((d, i) => {
    const seed = hashStr(tid + ":" + i);
    return { kind: "doc", d, puffs: cloudPuffs(seed, docW * 1.15, docW * 0.52), ph: (seed % 628) / 100, depth: 0.8 + (i % 3) * 0.15, hov: 0 };
  });
  const g = SKY.g;
  for (const p of [...g.personal, ...g.bank]) {
    const [w, h] = g.size[p.id], seed = hashStr(p.id);
    SKY.clouds.push({
      kind: "proj", id: p.id, c: skyToWorld(g.pos[p.id]), ghost: !!p.ghost,
      puffs: cloudPuffs(seed, w * SKY.K, h * SKY.K), ph: (seed % 628) / 100,
      depth: p.group === "client" || p.ghost ? 1.3 : 0.85 + (seed % 3) * 0.12, hov: 0,
    });
  }
  renderSkyLabels();
}

function renderSkyLabels() {
  const g = SKY.g;
  skyEl.innerHTML = "";
  for (const p of [...g.personal, ...g.bank]) {
    const [w, h] = g.size[p.id], c = skyToWorld(g.pos[p.id]);
    const W = w * SKY.K, H = h * SKY.K;
    const el = document.createElement(p.ghost ? "div" : "button");
    el.className = "sky-cloud" + (p.id === state.projectId ? " here" : "") + (p.ghost ? " ghost" : "");
    el.style.cssText = `left:${c.x - W / 2}px;top:${c.y - H / 2}px;width:${W}px;height:${H}px`;
    el.innerHTML = `<span class="name"></span><span class="meta"></span>`;
    $(".name", el).textContent = p.name;
    const n = p.threads?.length || 0;
    $(".meta", el).textContent = p.ghost ? "add one in projects.json" : n ? `${n} thread${n === 1 ? "" : "s"} · ${ago(p.threads[0].updated)}` : "start here";
    if (!p.ghost) {
      el.setAttribute("aria-label", `${p.name}, ${$(".meta", el).textContent}`);
      el.addEventListener("click", () => enterProject(p.id));
      const on = () => (SKY.hover = p.id), off = () => { if (SKY.hover === p.id) SKY.hover = null; };
      el.addEventListener("pointerenter", on); el.addEventListener("focus", on);
      el.addEventListener("pointerleave", off); el.addEventListener("blur", off);
    }
    skyEl.appendChild(el);
  }
  for (const [txt, x, y] of g.words) {
    const c = skyToWorld([x, y]);
    const l = document.createElement("div");
    l.className = "sky-word";
    l.style.cssText = `left:${c.x}px;top:${c.y}px`;
    l.textContent = txt;
    skyEl.appendChild(l);
  }
}

// ---- printing the ground

const VS = `#version 300 es
in vec2 a; void main() { gl_Position = vec4(a, 0., 1.); }`;

// Pass 1: one texel per halftone cell. How much blue ink the cell takes, how
// much grey (a cloud's underside, away from the light), and how cloudy it is.
const FS_CELLS = `#version 300 es
precision highp float;
#define MAXP 64
uniform vec2 uCell0; uniform float uPitch; uniform vec2 uRot;
uniform vec4 uA[MAXP]; uniform int uNA; uniform vec4 uB[MAXP]; uniform int uNB;
uniform float uW, uT, uDens, uOffA, uOffB; uniform vec2 uSh; uniform vec4 uMoon;
out vec4 o;
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
float puff(vec4 c, vec2 p) { vec2 d = (p - c.xy) / c.z; d.y *= 1.3; float q = dot(d, d); float k = max(0., 1. - q); return k * k * c.w; }
float fA(vec2 p) { float f = 0., m = 0.; for (int i = 0; i < MAXP; i++) { if (i >= uNA) break; float k = puff(uA[i], p); f += k; m = max(m, k); } return m + .28 * (f - m); }
float fB(vec2 p) { float f = 0., m = 0.; for (int i = 0; i < MAXP; i++) { if (i >= uNB) break; float k = puff(uB[i], p); f += k; m = max(m, k); } return m + .28 * (f - m); }
float cov(float f, vec2 p) {
  float n = vn(p * .011 + vec2(uT * .013, uT * .004)) + .5 * vn(p * .033 - vec2(uT * .021, 0.));
  return smoothstep(.07, .55, f + (n - .75) * .3);
}
void main() {
  if (uDens < .002) { o = vec4(0.); return; }
  vec2 q = (uCell0 + floor(gl_FragCoord.xy) + .5) * uPitch;
  vec2 p = vec2(uRot.x * q.x + uRot.y * q.y, -uRot.y * q.x + uRot.x * q.y);
  float a = 0., b = 0., a2 = 0., b2 = 0.;
  if (uW > .002) { a = cov(fA(p), p); vec2 s = p + uSh * uOffA; a2 = cov(fA(s), s); }
  if (uW < .998) { b = cov(fB(p), p); vec2 s = p + uSh * uOffB; b2 = cov(fB(s), s); }
  float c = mix(b, a, uW);
  float sh = mix(b * (1. - b2), a * (1. - a2), uW);
  float ink = uDens * (1. - c);
  if (uMoon.w > 0.) ink *= 1. - uMoon.w * (1. - smoothstep(uMoon.z * .9, uMoon.z * 1.1, length(p - uMoon.xy)));
  o = vec4(ink, sh, c, 1.);
}`;

// Pass 2: print. Washi, then the blue screen at 15°, the red sun, the grey
// undersides, and the one light falling across it all.
const FS_PRINT = `#version 300 es
precision highp float;
uniform sampler2D uCells; uniform sampler2D uWashi;
uniform vec2 uRes, uRot, uCell0; uniform float uDpr, uPitch, uDark;
uniform vec3 uPaper, uBlue, uGraph, uRed, uWM0, uWM1;
uniform vec4 uLg, uSun;
out vec4 o;
void main() {
  vec2 P = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 p = P / uDpr;
  vec3 col = uPaper;
  vec4 w = texture(uWashi, vec2(dot(uWM0, vec3(P, 1.)), dot(uWM1, vec3(P, 1.))) / 512.);
  col = mix(col, w.rgb, w.a * .55);
  vec2 q = vec2(uRot.x * p.x - uRot.y * p.y, uRot.y * p.x + uRot.x * p.y);
  vec2 cell = floor(q / uPitch);
  vec4 c = texelFetch(uCells, ivec2(cell - uCell0), 0);
  float d = length(q - (cell + .5) * uPitch), aa = .7 / uDpr;
  float rb = uPitch * .6 * sqrt(c.r);
  col = mix(col, uBlue, (1. - smoothstep(rb - aa, rb + aa, d)) * .94 * step(.004, c.r));
  if (uSun.w > 0.) {
    float disc = 1. - smoothstep(uSun.z - aa, uSun.z + aa, length(p - uSun.xy));
    col = mix(col, uRed, disc * uSun.w * (1. - c.b));
  }
  float rg = uPitch * .5 * sqrt(c.g * .16);
  col = mix(col, uGraph, (1. - smoothstep(rg - aa, rg + aa, d)) * .42 * step(.02, c.g));
  float t = clamp(dot(p - uLg.xy, uLg.zw), 0., 1.);
  col = t < .5 ? mix(col, vec3(1., .988, .957), .2 * (1. - t * 2.)) : mix(col, vec3(.118, .094, .07), uDark * (t * 2. - 1.));
  o = vec4(col, 1.);
}`;

function ground() {
  const cv = $("#ground");
  const gl = cv.getContext("webgl2", { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false });
  if (!gl) return paperOnly(cv);

  const compile = (fs) => {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      gl.attachShader(p, sh);
    }
    gl.bindAttribLocation(p, 0, "a");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = new Proxy({}, { get: (m, k) => (k in m ? m[k] : (m[k] = gl.getUniformLocation(p, k))) });
    return { p, u };
  };
  let P1, P2;
  try { P1 = compile(FS_CELLS); P2 = compile(FS_PRINT); } catch (e) { console.warn("Sky shader failed, printing paper only:", e); return paperOnly(cv); }

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const washi = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, washi);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, TEX.washi);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  const cells = gl.createTexture(), fbo = gl.createFramebuffer();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, cells);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  let PITCH = 6; const ANG = (15 * Math.PI) / 180, ROTV = [Math.cos(ANG), Math.sin(ANG)];
  let W, H, dpr, cell0, cw = 0, ch = 0;
  const resize = () => {
    dpr = Math.min(2, devicePixelRatio || 1);
    PITCH = innerWidth <= 760 ? 5 : 6;
    W = cv.width = Math.round(innerWidth * dpr);
    H = cv.height = Math.round(innerHeight * dpr);
    // the halftone grid is turned 15°: find the cells that cover the screen
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (const [x, y] of [[0, 0], [innerWidth, 0], [0, innerHeight], [innerWidth, innerHeight]]) {
      const qx = ROTV[0] * x - ROTV[1] * y, qy = ROTV[1] * x + ROTV[0] * y;
      mnx = Math.min(mnx, qx); mny = Math.min(mny, qy); mxx = Math.max(mxx, qx); mxy = Math.max(mxy, qy);
    }
    cell0 = [Math.floor(mnx / PITCH) - 1, Math.floor(mny / PITCH) - 1];
    cw = Math.ceil(mxx / PITCH) - cell0[0] + 2;
    ch = Math.ceil(mxy / PITCH) - cell0[1] + 2;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, cells);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cw, ch, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, cells, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    last = "";
  };
  let scene, light, sceneT = -Infinity, last = "", lastDraw = 0, hour = 12;
  resize();
  addEventListener("resize", resize);
  cv.addEventListener("webglcontextlost", (e) => e.preventDefault());

  const A = new Float32Array(64 * 4), B = new Float32Array(64 * 4);

  const frame = (now) => {
    requestAnimationFrame(frame);
    if (now - sceneT > 30000) {
      hour = hourNow();
      scene = sceneAt(hour); light = lightAt(hour); sceneT = now; last = "";
      document.body.classList.toggle("night", scene.dens > 0.6);
      const rs = document.documentElement.style;
      rs.setProperty("--sx", light.sx.toFixed(3));
      rs.setProperty("--sy", light.sy.toFixed(3));
      rs.setProperty("--sa", light.sa.toFixed(2));
    }
    const c = state.cam, L = state.layout, s = c.s;
    const lw = levelW(s);
    const pres = (1 - smooth(0.38, 0.85, s)) * (state.holdNear ? 0.45 : 1);
    const dens = scene.sky * pres;
    let hovering = false;
    for (const cl of SKY.clouds) {
      const want = cl.id && cl.id === SKY.hover ? 1 : 0;
      if (Math.abs(cl.hov - want) > 0.004) { cl.hov += (want - cl.hov) * (reduceMotion ? 1 : 0.12); hovering = true; }
    }
    const key = [c.x, c.y, c.s, c.r, L.cx, L.cy].map((v) => (v || 0).toFixed(2)).join();
    const alive = dens > 0.002 && !reduceMotion && now - lastDraw > 50;
    if (key === last && !alive && !hovering) return;
    last = key; lastDraw = now;

    // world → screen, exactly as #world is transformed
    const th = (-c.r * Math.PI) / 180, co = Math.cos(th), si = Math.sin(th);
    const t = reduceMotion ? 0 : now / 1000;
    const vw = L.vw, vh = L.vh;
    const fill = (arr, list, infl) => {
      let n = 0, rs = 0;
      for (const cl of list) {
        const cx0 = cl.kind === "doc" ? cl.d.pos.x : cl.c.x, cy0 = cl.kind === "doc" ? cl.d.pos.y : cl.c.y;
        const k = infl * (1 + 0.07 * cl.hov) * (1 + 0.012 * Math.sin((t * 2 * Math.PI) / 41 + cl.ph));
        const dx = 5 * cl.depth * Math.sin((t * 2 * Math.PI) / (200 * cl.depth) + cl.ph), dy = 2 * Math.sin((t * 2 * Math.PI) / 290 + cl.ph * 1.7);
        for (const pf of cl.puffs) {
          if (n >= 64) break;
          const wx = cx0 + pf.x * k - c.x, wy = cy0 + pf.y * k - c.y;
          const x = L.cx + s * (wx * co - wy * si) + dx, y = L.cy + s * (wx * si + wy * co) + dy, r = pf.r * k * s;
          if (r < 0.8 || x < -r || y < -r || x > vw + r || y > vh + r) continue;
          arr.set([x, y, r, pf.w * (cl.ghost ? 0.72 : 1)], n * 4);
          rs += r; n++;
        }
      }
      return [n, n ? (rs / n) * 0.2 : 0];
    };
    let nA = 0, nB = 0, offA = 0, offB = 0;
    if (dens > 0.002) {
      if (lw > 0.002) [nA, offA] = fill(A, SKY.clouds.filter((x) => x.kind === "doc"), 1 + 2.6 * smooth(0.28, 0.95, s));
      if (lw < 0.998) [nB, offB] = fill(B, SKY.clouds.filter((x) => x.kind === "proj"), 1);
    }
    const sl = Math.hypot(light.sx, light.sy) || 1;
    const night = smooth(0.62, 0.8, scene.dens), skyOnly = 1 - lw;
    // the sun crosses the sky with the hour; at night a moon is left unprinted
    const arc = Math.max(0, Math.min(1, (hour - 6) / 12.5)), topH = SKY.g?.topH || 60;
    const sunR = Math.min(vw, vh) * 0.034;
    const sun = [vw * (0.1 + 0.8 * arc), topH + (vh - topH) * (0.34 - 0.22 * Math.sin(Math.PI * arc)), sunR, skyOnly * (1 - night) * (dens > 0.002 ? 1 : 0)];
    const moon = [vw * 0.8, topH + (vh - topH) * 0.16, sunR * 0.85, skyOnly * night];

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, cw, ch);
    gl.useProgram(P1.p);
    const u1 = P1.u;
    gl.uniform2f(u1.uCell0, cell0[0], cell0[1]);
    gl.uniform1f(u1.uPitch, PITCH);
    gl.uniform2f(u1.uRot, ROTV[0], ROTV[1]);
    gl.uniform4fv(u1.uA, A); gl.uniform1i(u1.uNA, nA);
    gl.uniform4fv(u1.uB, B); gl.uniform1i(u1.uNB, nB);
    gl.uniform1f(u1.uW, lw);
    gl.uniform1f(u1.uT, t % 10000);
    gl.uniform1f(u1.uDens, dens);
    gl.uniform1f(u1.uOffA, offA); gl.uniform1f(u1.uOffB, offB);
    gl.uniform2f(u1.uSh, light.sx / sl, light.sy / sl);
    gl.uniform4f(u1.uMoon, ...moon);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.useProgram(P2.p);
    const u2 = P2.u;
    gl.uniform1i(u2.uCells, 0); gl.uniform1i(u2.uWashi, 1);
    gl.uniform2f(u2.uRes, W, H);
    gl.uniform2f(u2.uRot, ROTV[0], ROTV[1]);
    gl.uniform2f(u2.uCell0, cell0[0], cell0[1]);
    gl.uniform1f(u2.uDpr, dpr);
    gl.uniform1f(u2.uPitch, PITCH);
    gl.uniform1f(u2.uDark, 0.13 + scene.dens * 0.12);
    gl.uniform3fv(u2.uPaper, mix(PAPER, scene.ink, scene.dens * 0.42).map((v) => v / 255));
    gl.uniform3fv(u2.uBlue, scene.blue.map((v) => v / 255));
    gl.uniform3fv(u2.uGraph, GRAPHITE.map((v) => v / 255));
    gl.uniform3fv(u2.uRed, RED.map((v) => v / 255));
    // The paper's fibres belong to the world: they slide, turn and scale with the camera.
    const fs = Math.max(0.55, s);
    const M = new DOMMatrix().translate(L.cx * dpr, L.cy * dpr).scale(fs * dpr).rotate(-c.r).translate(-c.x * (s / fs), -c.y * (s / fs)).inverse();
    gl.uniform3f(u2.uWM0, M.a, M.c, M.e);
    gl.uniform3f(u2.uWM1, M.b, M.d, M.f);
    const ux = light.sx / sl, uy = light.sy / sl, R = Math.hypot(vw, vh) * 0.55;
    gl.uniform4f(u2.uLg, vw / 2 - ux * R, vh / 2 - uy * R, ux / (2 * R), uy / (2 * R));
    gl.uniform4f(u2.uSun, ...sun);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  requestAnimationFrame(frame);
}

// Without WebGL 2: the bare paper and its light, no sky.
function paperOnly(cv) {
  const ctx = cv.getContext("2d");
  let W, H, dpr, washiPat, last = "", sceneT = -Infinity, scene, light;
  const resize = () => {
    dpr = Math.min(1.5, devicePixelRatio || 1);
    W = cv.width = Math.round(innerWidth * dpr); H = cv.height = Math.round(innerHeight * dpr);
    washiPat = ctx.createPattern(TEX.washi, "repeat");
    last = "";
  };
  resize();
  addEventListener("resize", resize);
  const frame = (now) => {
    requestAnimationFrame(frame);
    if (now - sceneT > 30000) {
      const hr = hourNow();
      scene = sceneAt(hr); light = lightAt(hr); sceneT = now; last = "";
      document.body.classList.toggle("night", scene.dens > 0.6);
      const rs = document.documentElement.style;
      rs.setProperty("--sx", light.sx.toFixed(3)); rs.setProperty("--sy", light.sy.toFixed(3)); rs.setProperty("--sa", light.sa.toFixed(2));
    }
    const c = state.cam, { cx = 0, cy = 0 } = state.layout;
    const key = [c.x, c.y, c.s, c.r, cx, cy].map((v) => v.toFixed(2)).join();
    if (key === last) return;
    last = key;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = rgb(mix(PAPER, scene.ink, scene.dens * 0.42));
    ctx.fillRect(0, 0, W, H);
    const fs = Math.max(0.55, c.s);
    washiPat.setTransform(new DOMMatrix().translate(cx * dpr, cy * dpr).scale(fs * dpr).rotate(-c.r).translate(-c.x * (c.s / fs), -c.y * (c.s / fs)));
    ctx.globalAlpha = 0.55; ctx.fillStyle = washiPat; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- moving between levels
// O rises one level: doc → its thread's clouds → the sky of all projects.
// Diving back down is the same camera, the other way.

async function loadProjects() {
  state.projects = await api("/api/projects");
  return state.projects;
}

function setView(v) {
  state.view = v;
  document.body.classList.toggle("sky", v === "sky");
}

async function showSky() {
  if (state.view === "sky") return;
  hidePopover();
  closeDrawer();
  $("#notes-panel").classList.remove("open");
  await loadProjects().catch(() => {});
  buildSky();
  if (!SKY.g) return;
  state.overview = false;
  document.body.classList.remove("overview");
  $("#btn-overview").classList.remove("active");
  setView("sky");
  updateNav();
  await flyTo(camForSky(), { dip: false, duration: reduceMotion ? 1 : 2400 });
}

async function enterProject(pid, threadId) {
  const proj = state.projects.find((p) => p.id === pid);
  const target = threadId && (!proj || proj.threads.some((t) => t.id === threadId)) ? threadId : proj?.threads?.[0]?.id;
  if (pid === state.projectId && state.thread && (!target || target === state.thread.id)) {
    setView("thread");
    return focusDoc(state.docs.length - 1, { duration: reduceMotion ? 1 : 2600, dip: false });
  }
  // Drift over to that cloud, then sink into it.
  const cl = SKY.clouds.find((x) => x.id === pid);
  if (cl && !reduceMotion) await flyTo({ x: cl.c.x, y: cl.c.y, s: SKY.g.sSky * 2.6, r: 0 }, { dip: false, duration: 1300 });
  state.projectId = pid;
  if (target) await openThread(target, { from: "sky" });
  else await newThread(pid, { from: "sky" });
}

// ---------------------------------------------------------------- overview pan / zoom

function overviewControls() {
  const vp = $("#viewport");
  const far = () => state.overview || state.view === "sky";
  let drag = null;
  vp.addEventListener("pointerdown", (e) => {
    if (!far() || e.button !== 0 || flight) return;
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
  // One continuous zoom: scroll (or pinch) from a thread's clouds up into the sky and back.
  let settle;
  addEventListener("wheel", (e) => {
    if (e.target.closest?.("#drawer, #notes-panel, .doc-scroll, #composer")) {
      if (!(e.ctrlKey && e.deltaY > 0 && !far())) return;
    }
    if (far() && !flight) {
      e.preventDefault();
      const c = state.cam, L = state.layout;
      const s1 = Math.max((SKY.g?.sSky || 0.02) * 0.75, Math.min(0.62, c.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018))));
      // keep the point under the cursor still
      const th = (-c.r * Math.PI) / 180, mx = (e.clientX - L.cx) , my = (e.clientY - L.cy);
      const wx = (mx * Math.cos(th) + my * Math.sin(th)), wy = (-mx * Math.sin(th) + my * Math.cos(th));
      c.x += wx / c.s - wx / s1; c.y += wy / c.s - wy / s1; c.s = s1;
      applyCam();
      const up = levelW(s1) < 0.5;
      if (up && state.view !== "sky") { state.overview = false; document.body.classList.remove("overview"); buildSky(); setView("sky"); updateNav(); }
      else if (!up && state.view === "sky") { setView("thread"); state.overview = true; document.body.classList.add("overview"); updateNav(); }
      clearTimeout(settle);
      // zoomed all the way in on a thread: land on the nearest sheet;
      // all the way out: let the sky settle into frame
      if (s1 >= 0.62 && e.deltaY < 0) settle = setTimeout(() => focusDoc(nearestDoc()), 160);
      else if (s1 < (SKY.g?.sSky || 0) * 1.25 && SKY.g) settle = setTimeout(() => flyTo(camForSky(), { dip: false, duration: 900 }), 220);
    } else if (e.ctrlKey && e.deltaY > 0 && state.view === "thread") {
      e.preventDefault();
      toggleOverview(true);
    }
  }, { passive: false });
}

function nearestDoc() {
  let best = 0, bd = Infinity;
  state.docs.forEach((d, i) => { const k = Math.hypot(d.pos.x - state.cam.x, d.pos.y - state.cam.y); if (k < bd) { bd = k; best = i; } });
  return best;
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
$("#btn-new").addEventListener("click", () => (state.view === "sky" ? null : newThread()));
$("#brand").addEventListener("click", () => (state.view === "sky" ? enterProject(state.projectId, state.thread?.id) : showSky()));
$("#drawer-river").addEventListener("click", () => { closeDrawer(); showSky(); });
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
  if (state.view === "sky") {
    if (["Escape", "Enter", "o", "O"].includes(e.key)) enterProject(state.projectId, state.thread?.id);
    return;
  }
  // Type anywhere to start writing. Lowercase o, p, t, n stay shortcuts; a
  // capital (the start of a sentence) always goes to the composer.
  if (e.key.length === 1 && !/^[otnp/]$/.test(e.key) && !state.overview) {
    input.focus({ preventScroll: true });
    return;
  }
  if (e.key === "ArrowRight") { e.preventDefault(); focusDoc(Math.min(state.docs.length - 1, state.focus + 1)); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); focusDoc(Math.max(0, state.focus - 1)); }
  else if (e.key === "o") zoomOut();
  else if (e.key === "Escape") { if (state.overview) toggleOverview(false); closeDrawer(); }
  else if (e.key === "t") openDrawer();
  else if (e.key === "n") newThread();
  else if (e.key === "p") showSky();
  else if (e.key === "/") { e.preventDefault(); input.focus(); }
});

let resizeT;
addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    measure();
    placeDocs();
    Object.assign(state.cam, state.view === "sky" && SKY.g ? camForSky() : state.overview ? camForOverview() : state.focus >= 0 ? camForDoc(state.focus) : state.cam);
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
  ground();
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
  await loadProjects().catch(() => {});
  const list = await api("/api/threads");
  let last = null;
  try { last = localStorage.getItem("shell.lastThread"); } catch {}
  const pick = list.find((t) => t.id === last) || list[0];
  state.projectId = pick?.projectId || state.projects[0]?.id;
  if (pick) await openThread(pick.id, { from: "boot" });
  else await newThread(state.projectId, { from: "boot" });
}

boot();
