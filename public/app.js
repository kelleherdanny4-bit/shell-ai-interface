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
  cam: { x: 0, y: 0, s: 1, r: 0 },
  layout: { docW: 820, docH: 600, cx: 0, cy: 0, wide: true },
};

// ---------------------------------------------------------------- layout

const ROT = [0, -5, 4, -3, 6, -4, 3];

function measure() {
  const vw = innerWidth, vh = innerHeight;
  const wide = vw >= 1200;
  document.body.classList.toggle("wide", wide);
  const topH = vw <= 760 ? 54 : 60;
  // Reserve room for the "notes ready" chip so the doc never sits under it.
  const composerH = Math.round($(".composer-row").getBoundingClientRect().height + ($("#composer-meta").offsetHeight || 0)) + 64;
  document.documentElement.style.setProperty("--composer-h", composerH + "px");
  const notesW = 320;
  const avail = wide ? vw - notesW - 48 - 130 : vw <= 760 ? vw - 24 : vw - 140;
  const docW = Math.round(Math.max(300, Math.min(820, avail)));
  const docH = Math.round(Math.max(320, vh - topH - composerH - 16));
  const cx = Math.round(wide ? (vw - notesW - 16) / 2 : vw / 2);
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
  const R = state.layout.docW * 0.78;
  const rings = pts.map(([x, y], i) => `
    <circle class="ring" cx="${x}" cy="${y}" r="${R}" />
    <circle class="ring spin" cx="${x}" cy="${y}" r="${R * 0.92}" />
    <circle class="ring spin rev" cx="${x}" cy="${y}" r="${R * 1.08}" />`).join("");
  linksEl.innerHTML = `${rings}<path class="trail" d="${path}" />`;
}

// ---------------------------------------------------------------- camera

function applyCam() {
  const { cx, cy } = state.layout;
  const c = state.cam;
  world.style.transform = `translate(${cx}px,${cy}px) scale(${c.s}) rotate(${-c.r}deg) translate(${-c.x}px,${-c.y}px)`;
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
let flight = null;

function flyTo(target, { duration, dip = true } = {}) {
  const from = { ...state.cam };
  const dist = Math.hypot(target.x - from.x, target.y - from.y);
  const d = reduceMotion ? 1 : duration ?? Math.min(1900, 900 + dist * 0.35);
  // Prezi-style swoop: zoom out mid-flight, more for longer trips.
  const k = dip ? Math.max(0.3, Math.min(0.92, 1 - dist / (dist + state.layout.vw * 0.9))) : 1;
  const t0 = performance.now();
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
  const { docW, docH, vw, vh, topH, composerH, wide } = state.layout;
  if (!state.docs.length) return { x: 0, y: 0, s: 1, r: 0 };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const d of state.docs) {
    minX = Math.min(minX, d.pos.x - docW * 0.6); maxX = Math.max(maxX, d.pos.x + docW * 0.6);
    minY = Math.min(minY, d.pos.y - docH * 0.6); maxY = Math.max(maxY, d.pos.y + docH * 0.6);
  }
  const availW = (wide ? vw - 352 : vw) - 60, availH = vh - topH - composerH - 30;
  const s = Math.min(availW / (maxX - minX), availH / (maxY - minY), 0.7);
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
    <div class="doc-scroll"><div class="doc-body"></div></div>`;
  d.el = el;
  d.bodyEl = $(".doc-body", el);
  d.scrollEl = $(".doc-scroll", el);
  if (d.user?.display?.text) $(".prompt", el).title = d.user.display.text;
  el.addEventListener("click", () => {
    const i = state.docs.indexOf(d);
    if (state.overview || i !== state.focus) focusDoc(i);
  });
  docsEl.appendChild(el);
  return d;
}

function renumber() {
  state.docs.forEach((d, i) => ($(".idx", d.el).textContent = `DOC ${String(i + 1).padStart(2, "0")}`));
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
  return `<div class="thinking"><div class="label">THINKING</div><div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div></div>`;
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
      <div class="meta"><span class="doc-tag">${di >= 0 ? "DOC " + String(di + 1).padStart(2, "0") : "DOC"}</span><span>${fmtTime(note.at)}</span><button class="del" title="Delete note">delete</button></div>`;
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
  // composer chip
  $("#attach").hidden = !n;
  $(".attach-count").textContent = n;
  // constellation dots
  updateNav();
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
        else if (ev === "delta" && data.text) {
          if (first) { first = false; await flown; d.bodyEl.innerHTML = ""; }
          d.text += data.text;
          if (!dirty) { dirty = true; requestAnimationFrame(flush); }
        } else if (ev === "usage") {
          $("#composer-meta").textContent = `${data.output.toLocaleString()} tokens out · ${data.cached ? Math.round((100 * data.cached) / Math.max(1, data.input + data.cached)) + "% cached · " : ""}← → move · O overview`;
        } else if (ev === "done") {
          Object.assign(d, { id: data.doc.id, title: data.doc.title, at: data.doc.at });
          state.thread.title = data.threadTitle;
          $("#thread-title").textContent = data.threadTitle;
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
- **O** zooms out to see the whole thread at once. Click any doc to fly in.
- **T** opens your other threads. **N** starts a new one.

## Try it now

Select this sentence and tap **✓ Yes**. Watch it light up and land in your notes.`;

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function openThread(id, { intro = true } = {}) {
  const t = await api(`/api/threads/${id}`);
  state.thread = t;
  try { localStorage.setItem("shell.lastThread", id); } catch {}
  $("#thread-title").textContent = t.title;
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
  if (innerWidth <= 760) input.placeholder = "Ask, or select text to note";
}

async function newThread() {
  const t = await api("/api/threads", { method: "POST" });
  await openThread(t.id);
}

async function refreshThreadList() {
  const list = await api("/api/threads");
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
  return list;
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
  const c = $("#constellation");
  c.innerHTML = "";
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

// ---------------------------------------------------------------- starfield

function starfield() {
  const cv = $("#stars"), ctx = cv.getContext("2d");
  let W, H, dpr;
  const stars = Array.from({ length: 320 }, () => ({ x: Math.random(), y: Math.random(), z: Math.random() * 0.9 + 0.1, tw: Math.random() * 6.28 }));
  const resize = () => {
    dpr = Math.min(2, devicePixelRatio || 1);
    W = cv.width = innerWidth * dpr; H = cv.height = innerHeight * dpr;
  };
  resize();
  addEventListener("resize", resize);
  let prev = { ...state.cam };
  const frame = (now) => {
    const c = state.cam;
    const vx = c.x - prev.x, vy = c.y - prev.y, vs = Math.log(c.s / prev.s);
    prev = { ...c };
    ctx.clearRect(0, 0, W, H);
    const speed = Math.min(1, Math.hypot(vx, vy) / 60 + Math.abs(vs) * 8);
    for (const s of stars) {
      const par = s.z * 0.18 * (0.5 + c.s * 0.5);
      let x = ((s.x * W - c.x * par * dpr) % W + W) % W;
      let y = ((s.y * H - c.y * par * dpr) % H + H) % H;
      const a = 0.25 + 0.55 * s.z * (0.6 + 0.4 * Math.sin(now / 900 + s.tw));
      const size = s.z * 1.6 * dpr;
      if (speed > 0.05) {
        // warp streaks during flight
        ctx.strokeStyle = `rgba(150,235,255,${a})`;
        ctx.lineWidth = size;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + vx * par * dpr * 3 + (x - W / 2) * vs * 0.6, y + vy * par * dpr * 3 + (y - H / 2) * vs * 0.6);
        ctx.stroke();
      } else {
        ctx.fillStyle = `rgba(180,235,255,${a})`;
        ctx.fillRect(x, y, size, size);
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
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
$("#drawer-new").addEventListener("click", newThread);
$("#btn-new").addEventListener("click", newThread);
$("#btn-overview").addEventListener("click", () => toggleOverview());
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
  if (e.key === "ArrowRight") { e.preventDefault(); focusDoc(Math.min(state.docs.length - 1, state.focus + 1)); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); focusDoc(Math.max(0, state.focus - 1)); }
  else if (e.key === "o" || e.key === "O") toggleOverview();
  else if (e.key === "Escape") { if (state.overview) toggleOverview(false); closeDrawer(); }
  else if (e.key === "t" || e.key === "T") openDrawer();
  else if (e.key === "n" || e.key === "N") newThread();
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

async function boot() {
  measure();
  starfield();
  overviewControls();
  voice();
  tickClock();
  setInterval(tickClock, 15000);
  try {
    const s = await api("/api/status");
    const st = $("#status");
    st.classList.toggle("live", s.live);
    $(".status-text", st).textContent = s.live ? `${s.model.replace("claude-", "")} · online` : "demo mode";
    st.title = s.live ? `Model ${s.model}, effort ${s.effort}. Context files: ${s.contextFiles.join(", ") || "none"}` : "No API key — replies are canned. See README.";
  } catch {}
  const list = await refreshThreadList();
  let last = null;
  try { last = localStorage.getItem("shell.lastThread"); } catch {}
  const pick = list.find((t) => t.id === last) || list[0];
  if (pick) await openThread(pick.id);
  else await newThread();
}

boot();
