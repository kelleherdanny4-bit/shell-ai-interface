// Shell — client.
// A chat in a printed sky. Your words float in the blue in white letters;
// Claude's replies arrive as clouds you can mark up. Zoom out (O) and this
// project's chats become clouds, newest first; zoom out again and every
// project is a cloud. One world, one camera.
import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";
import { initPage, openPage, openFile, newPage, closePage, pageIsOpen, currentPage, askWholePage, openPicker, dismissPageMenus, setEditable, refreshFromDisk } from "/page.js";

marked.setOptions({ gfm: true, breaks: false });

const $ = (s, el = document) => el.querySelector(s);
const world = $("#world");
const viewportEl = $("#viewport");
const chatEl = $("#chat");
const feed = $("#feed");
const spacer = $("#spacer");
const mapEl = $("#map");
const skyEl = $("#sky");
const input = $("#input");
const pop = $("#popover");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const HL_SUPPORTED = typeof CSS !== "undefined" && "highlights" in CSS;

const state = {
  thread: null, // {id (null until the first message), projectId, title, turns}
  msgs: [], // Claude's replies in this chat: {id, text, title, at, el, bodyEl, marginEl, streaming}
  notes: [], // pending notes for this chat
  view: "chat", // "chat" | "chats" (this project's chats as clouds) | "sky" (every project)
  chatK: 0, // 1 = down in a chat, 0 = up among the clouds
  night: false,
  projects: [],
  projectId: null,
  busy: false,
  cam: { x: 0, y: 0, s: 1.1, r: 0 },
  layout: { cx: 0, cy: 0 },
};

// ---------------------------------------------------------------- layout

function measure() {
  const vw = innerWidth, vh = innerHeight;
  const wide = vw >= 1280; // room for pencil notes in the sky beside each cloud
  document.body.classList.toggle("wide", wide);
  const topH = vw <= 760 ? 56 : 60;
  Object.assign(state.layout, { vw, vh, wide, topH, cx: Math.round(vw / 2), cy: Math.round(topH + (vh - topH) / 2) });
  measureComposer();
}

function measureComposer() {
  const h = Math.round($("#composer").getBoundingClientRect().height) + 24;
  state.layout.composerH = h;
  document.documentElement.style.setProperty("--composer-h", h + "px");
  // The page keeps the room it had for an empty typing line. A message that grows
  // to two or three lines lays over the foot of the page instead of shoving the
  // whole sheet (and its fade) up and down with every line.
  if (!input.value.trim() || !state.layout.pageComposerH) {
    state.layout.pageComposerH = h;
    document.documentElement.style.setProperty("--page-composer-h", h + "px");
  }
}

// Fixed controls use layout-viewport coordinates, including while pinch-panned.
function measureVisibleViewport() {
  const viewport = window.visualViewport;
  const root = document.documentElement.style;
  root.setProperty("--visible-top", `${viewport.offsetTop}px`);
  root.setProperty("--visible-left", `${viewport.offsetLeft}px`);
  root.setProperty("--visible-right", `${innerWidth - viewport.offsetLeft - viewport.width}px`);
  root.setProperty("--visible-bottom", `${innerHeight - viewport.offsetTop - viewport.height}px`);
  root.setProperty("--visible-width", `${viewport.width}px`);
  root.setProperty("--visible-height", `${viewport.height}px`);
  document.body.classList.toggle("compact-chrome", viewport.width <= 760);
}

// ---------------------------------------------------------------- camera

function applyCam() {
  const { cx, cy } = state.layout;
  const c = state.cam;
  world.style.transform = `translate(${cx}px,${cy}px) scale(${c.s}) rotate(${-c.r}deg) translate(${-c.x}px,${-c.y}px)`;
  world.style.setProperty("--inv", (1 / c.s).toFixed(4));
  // This project's chat clouds give way to the projects' clouds as you rise.
  const lw = levelW(c.s);
  const mv = smooth(0.35, 0.85, lw), sv = 1 - smooth(0.12, 0.55, lw);
  mapEl.style.opacity = mv.toFixed(3);
  mapEl.style.visibility = mv < 0.01 ? "hidden" : "";
  skyEl.style.opacity = sv.toFixed(3);
  skyEl.style.visibility = sv < 0.01 ? "hidden" : "";
}

const ease = (t) => t * t * t * (t * (6 * t - 15) + 10); // smootherstep: unhurried
let flight = null;

function flyTo(target, { duration, dip = true } = {}) {
  const from = { ...state.cam };
  const dist = Math.hypot(target.x - from.x, target.y - from.y) * Math.min(from.s, target.s);
  const d = reduceMotion ? 1 : duration ?? Math.min(2600, 1300 + dist * 0.4);
  // Prezi-style swoop: zoom out mid-flight, more for longer trips.
  const k = dip ? Math.max(0.45, Math.min(0.94, 1 - dist / (dist + state.layout.vw * 0.9))) : 1;
  const t0 = performance.now();
  world.classList.add("flying");
  if (flight) { cancelAnimationFrame(flight.raf); flight.resolve(); }
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

// The chat fades in as you sink into its cloud, and out as you rise.
function setChatK(k) {
  state.chatK = k;
  chatEl.style.opacity = k.toFixed(3);
  chatEl.style.transform = k > 0.999 ? "" : `scale(${(0.95 + 0.05 * k).toFixed(4)})`;
  chatEl.style.visibility = k < 0.01 ? "hidden" : "";
  chatEl.style.pointerEvents = k > 0.6 ? "" : "none";
  viewportEl.style.opacity = (1 - k).toFixed(3);
  viewportEl.style.visibility = k > 0.99 ? "hidden" : "";
}

let chatTween = null;
function tweenChatK(to, ms = 700) {
  if (chatTween) cancelAnimationFrame(chatTween);
  const from = state.chatK, t0 = performance.now(), d = reduceMotion ? 1 : ms;
  return new Promise((resolve) => {
    const step = (now) => {
      const t = Math.min(1, (now - t0) / d);
      setChatK(from + (to - from) * ease(t));
      if (t < 1) chatTween = requestAnimationFrame(step);
      else { chatTween = null; resolve(); }
    };
    chatTween = requestAnimationFrame(step);
  });
}

function setView(v) {
  state.view = v;
  for (const k of ["chat", "chats", "sky"]) document.body.classList.toggle("view-" + k, v === k);
  syncChrome();
  updateCrumb();
}

// Over the blue (in a chat, or any time at night) the chrome is printed in white.
function syncChrome() {
  document.body.classList.toggle("night", state.night);
  document.body.classList.toggle("onblue", state.view === "chat" || state.night);
}

// ---------------------------------------------------------------- small helpers

function fmtTime(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// When you last talked in a chat: "Today 2:14 PM", "Yesterday 9:03 PM", "Mon 4:10 PM", "Nov 3".
function when(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 864e5);
  const time = fmtTime(ts);
  if (days <= 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days < 7) return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
const clip = (s, n) => (s.length > n ? s.slice(0, n).trimEnd() + "…" : s);

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const projectName = (id) => state.projects.find((p) => p.id === id)?.name || "";
const remember = (id) => { try { localStorage.setItem("shell.lastThread", id); } catch {} };

// ---------------------------------------------------------------- the chat

// Your words: the shorter they are, the bigger they float.
function sizeClass(n) {
  return n <= 40 ? "s1" : n <= 110 ? "s2" : n <= 260 ? "s3" : "s4";
}

function makeYou(display, at, { arrive = false } = {}) {
  const text = (display?.text || "").trim();
  const notes = display?.notes || [];
  const el = document.createElement("section");
  el.className = `msg you ${sizeClass(text ? text.length : 120)}${arrive ? " arrive" : ""}`;
  el.innerHTML = `<div class="you-meta">You · ${fmtTime(at)}</div>`;
  if (text) {
    const t = document.createElement("div");
    t.className = "you-text";
    t.textContent = text;
    el.appendChild(t);
  }
  if (notes.length) {
    const ul = document.createElement("ul");
    ul.className = "you-notes";
    for (const n of notes) {
      const li = document.createElement("li");
      const q = document.createElement("q");
      q.textContent = clip((n.quote || "").replace(/\s+/g, " ").trim(), 70);
      li.append(q, `  ${n.note}`);
      ul.appendChild(li);
    }
    el.appendChild(ul);
  }
  feed.appendChild(el);
  return el;
}

// A cumulus around each reply: billows heaped along the top, tallest toward the
// middle, a few smaller ones underneath. The text sits in the cloud's body.
function puffsFor(seed) {
  const r = rnd(seed);
  r(); r();
  const out = [];
  const nTop = 4 + Math.floor(r() * 3);
  for (let i = 0; i < nTop; i++) {
    const t = (i + 0.5) / nTop;
    const d = 70 + 100 * Math.sin(Math.PI * t) * (0.7 + r() * 0.5);
    out.push(`<i class="puff top" style="left:${(7 + t * 86 + (r() - 0.5) * 6).toFixed(1)}%;--d:${d | 0}"></i>`);
  }
  for (let i = 0; i < 3; i++) {
    const d = 60 + r() * 40;
    out.push(`<i class="puff low" style="left:${(20 + i * 30 + (r() - 0.5) * 10).toFixed(1)}%;--d:${d | 0}"></i>`);
  }
  const ds = 90 + r() * 40;
  out.push(`<i class="puff side" style="left:1.5%;--d:${ds | 0}"></i>`, `<i class="puff side" style="left:98.5%;--d:${(ds * 0.8) | 0}"></i>`);
  return out.join("");
}

function makeReply(m, { arrive = false } = {}) {
  const el = document.createElement("section");
  el.className = "msg reply" + (arrive ? " arrive" : "");
  el.innerHTML = `<div class="shape">${puffsFor(hashStr(m.id))}<div class="body"><div class="reply-head">${fmtTime(m.at)}<button class="reply-edit" title="Open this reply as a page you can edit">Edit as page</button></div><div class="doc-body"></div></div></div><aside class="marginalia" aria-label="Your notes on this reply"></aside>`;
  m.el = el;
  m.bodyEl = $(".doc-body", el);
  m.marginEl = $(".marginalia", el);
  $(".reply-edit", el).addEventListener("click", () => {
    if (m.streaming) return;
    newPage({ projectId: shellProject(state.thread?.projectId), md: m.text, fromThread: state.thread?.id, fromReply: m.id }).catch((err) => toast(err.message, true));
  });
  feed.appendChild(el);
  return m;
}

function renderBody(m, { animate = true } = {}) {
  const html = DOMPurify.sanitize(marked.parse(m.text || ""));
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  const next = [...tmp.children];
  const cur = [...m.bodyEl.children];
  let i = 0;
  while (i < cur.length && i < next.length && cur[i].outerHTML === next[i].outerHTML) i++;
  // Replace everything from the first changed block onward.
  for (let j = i; j < cur.length; j++) cur[j].remove();
  for (let j = i; j < next.length; j++) {
    const n = next[j];
    // Only blocks that are new (not just growing) ink in.
    if (animate && j >= cur.length) n.classList.add("materialize");
    m.bodyEl.appendChild(n);
  }
  m.bodyEl.querySelector(".caret")?.remove();
  if (m.streaming) {
    const last = m.bodyEl.lastElementChild;
    const host = last?.matches("ul,ol") ? last.querySelector("li:last-child") || last : last;
    const caret = document.createElement("span");
    caret.className = "caret";
    (host || m.bodyEl).appendChild(caret);
  }
}

function finalizeReply(m) {
  m.streaming = false;
  m.bodyEl.querySelector(".caret")?.remove();
  m.bodyEl.querySelectorAll(".materialize").forEach((n) => n.classList.remove("materialize"));
  addGutters(m);
  renderMarginalia(m);
}

function addGutters(m) {
  [...m.bodyEl.children].forEach((block) => {
    if (block.querySelector(":scope > .gutter")) return;
    const b = document.createElement("button");
    b.className = "gutter";
    b.setAttribute("aria-label", "Note on this part");
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const start = textOffset(m.bodyEl, block, 0);
      const end = start + block.textContent.length;
      openPopover({ msg: m, start, end, quote: block.textContent.trim() }, b.getBoundingClientRect());
    });
    block.appendChild(b);
  });
}

function thinkingMarkup() {
  return `<div class="thinking"><div class="label">Thinking it through…</div><div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="activity"></div></div>`;
}

const INVITES = ["What's on your mind?", "Where should we start?", "What are we making today?", "Say it plainly. I'm listening."];

function renderEmpty() {
  const p = projectName(state.thread?.projectId);
  const el = document.createElement("section");
  el.className = "empty";
  el.innerHTML = `<div class="where">${esc(p ? p + " · " : "")}new chat</div><h1>${INVITES[Math.floor(Math.random() * INVITES.length)]}</h1>
    <p>Type anywhere. Your words float up into the sky.</p>
    <p>Select words in a reply to leave a note. <kbd>O</kbd> rises above the clouds.</p>`;
  feed.appendChild(el);
}

// Keep room below your newest message so it can sit near the top while the reply writes itself under it.
function fitSpacer(anchor) {
  const base = (state.layout.composerH || 150) + 40;
  if (!anchor) { spacer.style.height = base + "px"; return; }
  const below = feed.offsetTop + feed.offsetHeight - anchor.offsetTop;
  spacer.style.height = Math.max(base, chatEl.clientHeight - below - state.layout.topH - 30) + "px";
}

function renderThread() {
  feed.innerHTML = "";
  state.msgs = [];
  const t = state.thread;
  // Sessions from the Claude app are shown, not continued (yet).
  document.body.classList.toggle("readonly", !!t.readOnly);
  if (t.readOnly) {
    const ro = $("#ro-note");
    if (t.source === "claude.ai") {
      ro.innerHTML = `From claude.ai. Read-only here: <a target="_blank" rel="noopener">open it on claude.ai</a> to keep going.`;
      $("a", ro).href = t.url;
    } else {
      ro.innerHTML = `From the Claude app. <a href="#">Take it to the skeye</a> to keep going here.`;
      $("a", ro).onclick = (e) => { e.preventDefault(); takeToSkeye(t.sessionId).catch(() => {}); };
    }
  }
  if (!t.turns.length) renderEmpty();
  for (const turn of t.turns) {
    if (turn.role === "user") makeYou(turn.display || { text: turn.text }, turn.at);
    else {
      const m = makeReply({ id: turn.id, text: turn.text, title: turn.title, at: turn.at });
      state.msgs.push(m);
      renderBody(m, { animate: false });
      if (!t.readOnly) addGutters(m);
    }
  }
  loadNotes();
  renderNotes();
  updateCrumb();
  fitSpacer();
  chatEl.scrollTop = chatEl.scrollHeight;
  requestAnimationFrame(() => { chatEl.scrollTop = chatEl.scrollHeight; state.msgs.forEach(positionMarginalia); });
}

async function openThread(id) {
  const t = await api(`/api/threads/${id}`);
  state.thread = t;
  state.projectId = t.projectId;
  remember(id);
  renderThread();
}

// Bring a Claude app session into Shell as a chat you can keep going (the original stays as it was).
async function takeToSkeye(sessionId) {
  const t = await api(`/api/skeye/${encodeURIComponent(sessionId)}`, { method: "POST" });
  await loadProjects().catch(() => {});
  await openThread(t.id);
  buildMap();
  return t;
}

// A new chat is only a draft until you say something; nothing is saved before that.
function draftThread(projectId = state.projectId) {
  state.thread = { id: null, projectId, title: "", turns: [] };
  state.projectId = projectId;
  renderThread();
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

const notesKey = () => `shell.notes.${state.thread?.id || "draft"}`;
function saveNotes() {
  try { localStorage.setItem(notesKey(), JSON.stringify(state.notes)); } catch {}
  renderNotes();
}
function loadNotes() {
  try { state.notes = JSON.parse(localStorage.getItem(notesKey()) || "[]"); } catch { state.notes = []; }
}

function addNote(target, text) {
  state.notes.push({
    id: Math.random().toString(36).slice(2, 9),
    docId: target.msg.id,
    docTitle: target.msg.title || state.thread?.title || "your reply",
    quote: target.quote.slice(0, 600),
    start: target.start,
    end: target.end,
    note: text,
    at: Date.now(),
  });
  saveNotes();
  window.getSelection()?.removeAllRanges();
}

function paintHighlights(activeId) {
  if (!HL_SUPPORTED) return;
  const normal = [], active = [];
  for (const n of state.notes) {
    const m = state.msgs.find((x) => x.id === n.docId);
    if (!m) continue;
    const r = rangeFromOffsets(m.bodyEl, n.start, n.end);
    if (r) (n.id === activeId ? active : normal).push(r);
  }
  CSS.highlights.set("note", new Highlight(...normal));
  CSS.highlights.set("note-active", new Highlight(...active));
}

function renderNotes() {
  const list = $("#notes-list");
  const n = state.notes.length;
  $("#notes-count").textContent = n;
  list.innerHTML = "";
  for (const note of [...state.notes].sort((a, b) => a.at - b.at)) {
    const card = document.createElement("div");
    card.className = "note-card";
    card.innerHTML = `<div class="q"></div><div class="n" contenteditable="plaintext-only" spellcheck="true"></div><div class="meta"><button class="del" title="Delete note">delete</button></div>`;
    $(".q", card).textContent = clip(note.quote, 180);
    const nEl = $(".n", card);
    nEl.textContent = note.note;
    nEl.addEventListener("blur", () => {
      const v = nEl.textContent.trim();
      if (v && v !== note.note) { note.note = v; saveNotes(); }
    });
    nEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); nEl.blur(); } });
    $(".del", card).addEventListener("click", () => { state.notes = state.notes.filter((x) => x.id !== note.id); saveNotes(); });
    card.addEventListener("mouseenter", () => paintHighlights(note.id));
    card.addEventListener("mouseleave", () => paintHighlights());
    $(".q", card).addEventListener("click", () => jumpToNote(note));
    list.appendChild(card);
  }
  if (!n) $("#notes-panel").classList.remove("open");
  paintHighlights();
  state.msgs.forEach(renderMarginalia);
  document.body.classList.toggle("has-notes", n > 0);
  $("#attach").hidden = !n;
  $(".attach-count").textContent = n;
  requestAnimationFrame(measureComposer);
}

// Pencil notes in the sky beside the cloud, each level with the words it is about.
function renderMarginalia(m) {
  const box = m.marginEl;
  if (!box) return;
  box.innerHTML = "";
  for (const note of state.notes.filter((n) => n.docId === m.id).sort((a, b) => a.start - b.start)) {
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
  positionMarginalia(m);
}

function positionMarginalia(m) {
  if (!m.marginEl?.children.length || !state.layout.wide) return;
  const top = m.el.getBoundingClientRect().top;
  const k = state.chatK > 0.999 ? 1 : 0.95 + 0.05 * state.chatK; // undo the fade-in scale
  let floor = 0;
  for (const el of m.marginEl.children) {
    const r = rangeFromOffsets(m.bodyEl, el.note.start, el.note.end);
    const first = r && [...r.getClientRects()].find((q) => q.width > 0.5);
    const y = Math.max(floor, first ? (first.top - top) / k - 4 : 0);
    el.style.top = y + "px";
    floor = y + el.offsetHeight + 8;
  }
}

function jumpToNote(note) {
  const m = state.msgs.find((x) => x.id === note.docId);
  const r = m && rangeFromOffsets(m.bodyEl, note.start, note.end);
  if (!r) return;
  chatEl.scrollBy({ top: r.getBoundingClientRect().top - innerHeight / 3, behavior: "smooth" });
  paintHighlights(note.id);
  setTimeout(() => paintHighlights(), 1400);
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
  if (!sel || sel.isCollapsed || !sel.rangeCount || state.view !== "chat" || state.thread?.readOnly) return;
  const range = sel.getRangeAt(0);
  const m = state.msgs.find((x) => x.bodyEl.contains(range.commonAncestorContainer));
  if (!m || m.streaming) return;
  const quote = sel.toString().trim();
  if (quote.length < 2) return;
  const start = textOffset(m.bodyEl, range.startContainer, range.startOffset);
  const end = textOffset(m.bodyEl, range.endContainer, range.endOffset);
  openPopover({ msg: m, start, end, quote }, range.getBoundingClientRect());
}

feed.addEventListener("mouseup", () => setTimeout(checkSelection, 0));
feed.addEventListener("touchend", () => setTimeout(checkSelection, 250));
document.addEventListener("selectionchange", () => {
  if (!matchMedia("(pointer: coarse)").matches) return;
  clearTimeout(checkSelection.t);
  checkSelection.t = setTimeout(checkSelection, 450);
});
document.addEventListener("mousedown", (e) => {
  if (!pop.hidden && !pop.contains(e.target) && !e.target.closest(".gutter")) hidePopover();
});
// Scrolling away closes the quick reactions (but never a note you're writing).
chatEl.addEventListener("scroll", () => { if (!pop.hidden && $(".pop-write", pop).hidden) hidePopover(); }, { passive: true });

// ---------------------------------------------------------------- sending

function setBusy(b) {
  state.busy = b;
  document.body.classList.toggle("busy", b);
  $("#btn-send").disabled = b;
}

function canSend() {
  if (pageIsOpen()) return !state.busy && !!input.value.trim();
  return !state.busy && !state.thread?.readOnly && (input.value.trim() || state.notes.length);
}

// The chat is saved the moment you first say something in it.
async function ensureThread(thread) {
  if (thread.id) return;
  const t = await api("/api/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: thread.projectId }) });
  Object.assign(thread, { id: t.id, created: t.created });
  remember(t.id);
}

async function send() {
  if (!canSend()) return;
  if (pageIsOpen() && docFull()) return sendToPage();
  const text = input.value.trim();
  const notes = state.notes.map(({ quote, note, docTitle }) => ({ quote, note, docTitle }));
  const sentNotes = state.notes;
  input.value = "";
  autoGrow();
  input.blur(); // letter keys go back to moving around while you read
  state.notes = [];
  saveNotes();
  hidePopover();
  setBusy(true);

  feed.querySelector(".empty")?.remove();
  const youEl = makeYou({ text, notes }, Date.now(), { arrive: true });
  const m = makeReply({ id: "pending-" + Date.now(), text: "", streaming: true, at: Date.now() }, { arrive: true });
  state.msgs.push(m);
  m.bodyEl.innerHTML = thinkingMarkup();
  // Your message rises to the top; the reply gathers beneath it.
  fitSpacer(youEl);
  chatEl.scrollTo({ top: youEl.offsetTop - state.layout.topH - 30, behavior: reduceMotion ? "auto" : "smooth" });

  let first = true, dirty = false;
  const acts = [];
  const showActs = () => {
    const el = m.bodyEl.querySelector(".activity");
    if (el) el.innerHTML = acts.slice(-4).map((a) => `<div>${esc(a)}</div>`).join("");
  };
  const flush = () => {
    if (!dirty) return;
    dirty = false;
    renderBody(m); // no auto-scroll: you read from the top while the rest writes itself below
    fitSpacer(youEl);
  };

  // You might wander off to another chat while this one replies; keep hold of this one.
  const thread = state.thread;
  try {
    await ensureThread(thread);
    const res = await fetch(`/api/threads/${thread.id}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, notes }),
    });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", failed = null;
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
        if (ev === "activity") { acts.push(data.text); showActs(); }
        else if (ev === "reset") {
          // The text so far was a preamble before Claude looked something up.
          m.text = "";
          first = true;
          m.bodyEl.innerHTML = thinkingMarkup();
          showActs();
        } else if (ev === "delta" && data.text) {
          if (first) { first = false; m.bodyEl.innerHTML = ""; }
          m.text += data.text;
          if (!dirty) { dirty = true; requestAnimationFrame(flush); }
        } else if (ev === "done") {
          Object.assign(m, { id: data.doc.id, title: data.doc.title, at: data.doc.at });
          thread.title = data.threadTitle;
          if (state.thread === thread) updateCrumb();
        } else if (ev === "error") failed = data;
      }
    }
    if (failed) throw new Error(failed.message);
    dirty = true;
    flush();
    finalizeReply(m);
    loadProjects().then(() => { if (state.view !== "chat") buildMap(); }).catch(() => {});
  } catch (err) {
    // Put everything back so nothing is lost.
    youEl.remove();
    m.el.remove();
    const i = state.msgs.indexOf(m);
    if (i >= 0) state.msgs.splice(i, 1);
    if (!feed.children.length) renderEmpty();
    input.value = text;
    autoGrow();
    state.notes = [...sentNotes, ...state.notes];
    saveNotes();
    fitSpacer();
    toast(err.message || "Something went wrong", true);
  } finally {
    setBusy(false);
  }
}

// On a page, what you type is an instruction to Claude about the whole page.
async function sendToPage() {
  const text = input.value.trim();
  input.value = "";
  autoGrow();
  input.blur();
  setBusy(true);
  try {
    if (!(await askWholePage(text))) { input.value = text; autoGrow(); }
  } finally {
    setBusy(false);
  }
}

// New things start in one of your Shell projects, not a read-only folder cloud.
function shellProject(pid = state.projectId) {
  const p = state.projects.find((x) => x.id === pid);
  return p && !p.fromClaude ? pid : state.projects.find((x) => !x.fromClaude)?.id || pid;
}

async function startPage() {
  try {
    if (state.view !== "chat") { setView("chat"); tweenChatK(1, 700); }
    leaveChat();
    await newPage({ projectId: shellProject() });
  } catch (err) {
    toast("Couldn't start a page: " + err.message, true);
  }
}

const CHAT_PLACEHOLDER = () => (innerWidth <= 760 ? "Say something" : "Say something to the sky");
const CHAT_META = $("#composer-meta").innerHTML;

// The composer talks to whatever you're in: the page when you're in it, its chat when you've stepped back.
function composerFor(page) {
  if (page) {
    document.body.classList.remove("readonly");
    input.placeholder = innerWidth <= 760 ? "Tell Claude a change" : "Tell Claude what to change on this page";
    $("#composer-meta").innerHTML = "Enter: Claude edits the whole page as tracked changes · select words to edit just those (⌘J) · pinch out to talk it over";
  } else {
    input.placeholder = pageIsOpen() ? (innerWidth <= 760 ? "Talk it over" : "Talk it over. Pinch in to write") : CHAT_PLACEHOLDER();
    $("#composer-meta").innerHTML = CHAT_META;
    if (state.thread) document.body.classList.toggle("readonly", !!state.thread.readOnly);
  }
  measureComposer();
  updateCrumb();
}

function pageOpened() {
  // Every page opens with you in it, typing.
  cancelAnimationFrame(DOC.raf);
  Object.assign(DOC, { k: 1, v: 0, target: 1, raf: null, g: null, anchor: null });
  renderDoc();
  composerFor(true);
}

function pageClosed() {
  cancelAnimationFrame(DOC.raf);
  Object.assign(DOC, { k: 1, v: 0, target: 1, raf: null, g: null, anchor: null });
  pageEl.style.transform = pageEl.style.transformOrigin = pageEl.style.clipPath = "";
  sheetEl.style.rotate = "";
  feed.style.opacity = feed.style.transform = "";
  document.body.classList.remove("doc-far", "doc-narrow");
  document.body.classList.add("doc-full");
  composerFor(false);
}

// ---------------------------------------------------------------- the page and its chat, a pinch apart
// In a page, pinch out (zoom out) and the page floats up into the corner as a
// little sheet of paper; the chat about it opens around it, and you talk it
// over. Pinch in and you sink back into the page to write. One number, DOC.k:
// 1 = in the page, 0 = out in its chat. It rides a spring, so it bounces.

const pageEl = $("#page"), sheetEl = $("#sheet");
const DOC = { k: 1, v: 0, target: 1, raf: null, g: null, anchor: null, settleT: null };
const docFull = () => DOC.target === 1;

// Where the little sheet floats when you step back: top right, beside the chat.
function docAnchor() {
  const { vw, topH } = state.layout;
  const sheetW = sheetEl.offsetWidth || 860;
  const side = (vw - Math.min(760, vw - 32)) / 2;
  const narrow = side < 230;
  const w = narrow ? Math.min(150, vw * 0.38) : Math.min(320, side - 48);
  const s = Math.max(0.1, Math.min(0.42, w / sheetW));
  const m = narrow ? 16 : 30;
  const sx1 = sheetEl.offsetLeft + sheetW;
  const sy0 = sheetEl.offsetTop - pageEl.scrollTop;
  const top = topH + (narrow ? 12 : 30);
  let seen = Math.max(0, Math.min(sheetEl.offsetHeight + Math.min(0, sy0), pageEl.clientHeight - Math.max(0, sy0) - (state.layout.composerH || 150)));
  // On a phone the sheet is a short strip above the chat, so the two never overlap.
  let clip = 0;
  if (narrow && seen * s > 120) { clip = pageEl.clientHeight - (Math.max(0, sy0) + 120 / s); seen = 120 / s; }
  return { s, narrow, clip, ox: (vw - m - sx1 * s) / (1 - s), oy: (top - sy0 * s) / (1 - s), h: Math.round(seen * s), top };
}

// Past either end it stretches like a rubber band, then springs back.
const band = (x) => (x > 1 ? 1 + 0.14 * (1 - Math.exp(-(x - 1) * 3)) : x < 0 ? -0.16 * (1 - Math.exp(x * 3)) : x);

function renderDoc() {
  if (!pageIsOpen()) return;
  const k = DOC.k, f = Math.max(0, Math.min(1, k));
  const a = (DOC.anchor ||= docAnchor());
  if (k > 0.999 && k < 1.001) {
    pageEl.style.transform = "";
    sheetEl.style.rotate = "";
  } else {
    pageEl.style.transformOrigin = `${a.ox.toFixed(1)}px ${a.oy.toFixed(1)}px`;
    pageEl.style.transform = `scale(${Math.max(0.04, a.s + (1 - a.s) * k).toFixed(4)})`;
    sheetEl.style.rotate = `${((1 - f) * 2.4).toFixed(2)}deg`; // a little tilt, like paper set down on the sky
  }
  pageEl.style.clipPath = a.clip && f < 0.999 ? `inset(0 0 ${(a.clip * (1 - f)).toFixed(0)}px 0)` : "";
  // The chat comes up from below as the page lifts away.
  feed.style.opacity = f > 0.995 ? "" : (1 - f).toFixed(3);
  feed.style.transform = f > 0.995 || f < 0.005 ? "" : `translateY(${(f * 40).toFixed(1)}px) scale(${(1 - f * 0.04).toFixed(4)})`;
  const full = f > 0.985;
  document.body.classList.toggle("doc-full", full);
  document.body.classList.toggle("doc-far", !full);
  document.body.classList.toggle("doc-narrow", a.narrow);
  document.documentElement.style.setProperty("--doc-card-bottom", `${a.top + a.h}px`);
}

// Decide which side you're on as soon as you let go, so the page or the chat is ready under your fingers.
function docMode(full) {
  if (DOC.target === (full ? 1 : 0)) return;
  DOC.target = full ? 1 : 0;
  setEditable(full);
  composerFor(full);
  if (full) refreshFromDisk().catch(() => {});
  else { hidePopover(); requestAnimationFrame(() => state.msgs.forEach(positionMarginalia)); }
}

function springDoc(to) {
  if (!pageIsOpen()) return;
  if (DOC.k > 0.98 && to === 0) DOC.anchor = docAnchor();
  docMode(to === 1);
  cancelAnimationFrame(DOC.raf);
  if (reduceMotion) { Object.assign(DOC, { k: to, v: 0, raf: null }); return renderDoc(); }
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(0.032, (now - last) / 1000);
    last = now;
    // stiffness 190, damping 15: overshoots about a tenth, wobbles once, settles
    DOC.v += (-190 * (DOC.k - to) - 15 * DOC.v) * dt;
    DOC.k += DOC.v * dt;
    if (Math.abs(DOC.k - to) < 0.0015 && Math.abs(DOC.v) < 0.02) { Object.assign(DOC, { k: to, v: 0, raf: null }); return renderDoc(); }
    renderDoc();
    DOC.raf = requestAnimationFrame(step);
  };
  DOC.raf = requestAnimationFrame(step);
}

// Follow the fingers while they pinch; spring to a side when they stop.
function scrubDoc(d) {
  if (!pageIsOpen() || state.view !== "chat") return;
  cancelAnimationFrame(DOC.raf);
  DOC.raf = null;
  if (!DOC.g) {
    if (DOC.k > 0.98) DOC.anchor = docAnchor();
    DOC.g = { from: DOC.target, raw: DOC.k, t: performance.now() };
  }
  const now = performance.now(), dt = Math.max(8, now - DOC.g.t) / 1000;
  DOC.g.raw += d;
  DOC.g.t = now;
  const k = band(DOC.g.raw);
  DOC.v = (k - DOC.k) / dt;
  DOC.k = k;
  renderDoc();
  clearTimeout(DOC.settleT);
  DOC.settleT = setTimeout(settleDoc, 140);
}

function settleDoc() {
  const g = DOC.g;
  if (!g) return;
  DOC.g = null;
  clearTimeout(DOC.settleT);
  DOC.v = Math.max(-6, Math.min(6, DOC.v));
  // Out in the chat and still pinching out: rise to this project's chats.
  if (g.from === 0 && g.raw < -0.45) return showChats();
  // A small pinch is enough to change sides.
  const to = g.from === 1 ? (g.raw < 0.78 ? 0 : 1) : g.raw > 0.22 ? 1 : 0;
  springDoc(to);
}

function pinchControls() {
  // Trackpad pinch arrives as ctrl+wheel (Chrome, Firefox, Edge). While a page is open, it's ours.
  addEventListener("wheel", (e) => {
    if (!e.ctrlKey || !pageIsOpen() || state.view !== "chat") return;
    e.preventDefault();
    scrubDoc(-e.deltaY * 0.0085);
  }, { passive: false });
  // Safari on a Mac sends gesture events instead.
  let gs = null, touching = false;
  addEventListener("gesturestart", (e) => { if (!pageIsOpen() || state.view !== "chat") return; e.preventDefault(); gs = 1; }, { passive: false });
  addEventListener("gesturechange", (e) => {
    if (gs === null) return;
    e.preventDefault();
    if (!touching) scrubDoc(Math.log(e.scale / gs) * 1.7);
    gs = e.scale;
  }, { passive: false });
  addEventListener("gestureend", (e) => { if (gs === null) return; e.preventDefault(); gs = null; if (!touching) settleDoc(); }, { passive: false });
  // Two fingers on a phone or tablet.
  let td = null;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  addEventListener("touchstart", (e) => {
    if (e.touches.length !== 2 || !pageIsOpen() || state.view !== "chat") return;
    touching = true;
    td = dist(e.touches);
  }, { passive: true });
  addEventListener("touchmove", (e) => {
    if (td === null || e.touches.length !== 2) return;
    e.preventDefault();
    const d = dist(e.touches);
    scrubDoc(Math.log(d / td) * 1.7);
    td = d;
  }, { passive: false });
  addEventListener("touchend", (e) => {
    if (td === null || e.touches.length >= 2) return;
    td = null;
    touching = false;
    settleDoc();
  });
  // Out in the chat, the little sheet is a door back in.
  pageEl.addEventListener("pointerdown", (e) => { if (!docFull()) { e.preventDefault(); e.stopPropagation(); } }, true);
  pageEl.addEventListener("click", (e) => { if (!docFull()) { e.preventDefault(); e.stopPropagation(); springDoc(1); } }, true);
}

// ---------------------------------------------------------------- header, drawer, toast

function updateCrumb() {
  const crumb = $("#crumb-project"), title = $("#thread-title");
  if (state.view === "sky") { crumb.textContent = "All projects"; title.textContent = ""; return; }
  const pg = state.view === "chat" && docFull() && currentPage();
  crumb.textContent = projectName(pg ? pg.projectId : state.projectId);
  title.textContent = pg ? `▤ ${pg.title || "Untitled page"}` : state.view === "chat" ? state.thread?.title || "New chat" : "";
}

async function openDrawer() {
  $("#drawer").classList.add("open");
  $("#drawer-scrim").hidden = false;
  await loadProjects().catch(() => {});
  state.pages = await api("/api/pages").catch(() => []);
  renderDrawer();
}
function closeDrawer() {
  $("#drawer").classList.remove("open");
  $("#drawer-scrim").hidden = true;
}

// Every chat, grouped by project like folders, newest first. Client work keeps its own section.
function renderDrawer() {
  const list = $("#drawer-list");
  list.innerHTML = "";
  const groups = [["Your projects", state.projects.filter((p) => p.group !== "client")], ["Client work", state.projects.filter((p) => p.group === "client")]];
  for (const [label, projs] of groups) {
    const g = document.createElement("div");
    g.className = "d-group";
    g.textContent = label;
    list.appendChild(g);
    if (!projs.length) {
      const e = document.createElement("div");
      e.className = "d-empty";
      e.textContent = 'None yet. Add one to projects.json with "group": "client".';
      list.appendChild(e);
    }
    for (const p of projs) {
      const head = document.createElement("div");
      head.className = "d-proj";
      head.innerHTML = `<button class="name" title="See ${esc(p.name)}'s chats as clouds"></button><button class="add" title="New chat in ${esc(p.name)}" aria-label="New chat in ${esc(p.name)}">+</button>`;
      $(".name", head).textContent = p.name;
      $(".name", head).addEventListener("click", () => { closeDrawer(); showChats(p.id); });
      if (p.fromClaude) $(".add", head).remove();
      else $(".add", head).addEventListener("click", () => { closeDrawer(); newChat(p.id); });
      list.appendChild(head);
      const chats = p.threads || [];
      if (!chats.length) {
        const e = document.createElement("div");
        e.className = "d-empty";
        e.textContent = "No chats yet";
        list.appendChild(e);
      }
      for (const t of chats.slice(0, 8)) {
        const b = document.createElement("button");
        b.className = "d-item" + (t.id === state.thread?.id ? " on" : "");
        b.innerHTML = `<span class="t"></span><span class="m">${esc(when(t.updated))}</span>`;
        if (t.source) b.title = `From ${t.source === "claude.ai" ? "claude.ai" : "the Claude app"} (read-only here)`;
        $(".t", b).textContent = t.title;
        b.addEventListener("click", () => { closeDrawer(); goToChat(t.id); });
        list.appendChild(b);
      }
      for (const pg of (state.pages || []).filter((x) => x.projectId === p.id).slice(0, 6)) {
        const b = document.createElement("button");
        b.className = "d-item page" + (pg.id === currentPage()?.id ? " on" : "");
        b.innerHTML = `<span class="t"></span><span class="m">${esc(when(pg.updated))}</span>`;
        $(".t", b).textContent = pg.title;
        if (pg.file) b.title = pg.file;
        b.addEventListener("click", async () => {
          closeDrawer();
          if (state.view !== "chat") { leaveChat(); setView("chat"); tweenChatK(1, 700); }
          openPage(pg.id).catch((e) => toast("Couldn't open that page: " + e.message, true));
        });
        list.appendChild(b);
      }
      if (chats.length > 8) {
        const more = document.createElement("button");
        more.className = "d-item";
        more.innerHTML = `<span class="t">${chats.length - 8} more… see them all as clouds</span>`;
        more.addEventListener("click", () => { closeDrawer(); showChats(p.id); });
        list.appendChild(more);
      }
    }
  }
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

// The longer you write, the smaller your words get, so the whole thought stays in view.
function autoGrow() {
  const n = input.value.length;
  input.classList.toggle("m", n > 50 && n <= 160);
  input.classList.toggle("l", n > 160);
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, innerHeight * 0.38) + "px";
  measureComposer();
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
  const n = personal.length;
  // more projects, smaller clouds, so the sky never crowds
  const base = portrait ? (n > 4 ? 380 : 520) : n > 4 ? 300 : 380, grow = n > 4 ? 10 : 20;
  const sz = (p) => { const w = base + grow * Math.min(p.threads?.length || 0, 6); return [w, w * (portrait ? 0.4 : 0.5)]; };
  personal.forEach((p, i) => {
    if (portrait) pos[p.id] = [FW / 2 + (i % 2 ? 1 : -1) * FW * 0.1, 190 + (i + 0.5) * (980 / Math.max(1, n))];
    else if (n <= 4) pos[p.id] = [FW * (0.17 + 0.66 * (n === 1 ? 0.5 : i / (n - 1))), 340 + Math.sin(i * 2.2 + 0.9) * 95];
    else {
      const cols = Math.ceil(n / 2), row = i % 2, col = Math.floor(i / 2);
      pos[p.id] = [FW * (0.12 + 0.74 * (cols === 1 ? 0.5 : col / (cols - 1))) + (row ? 90 : -30), 320 + row * 270 + Math.sin(i * 1.7) * 25];
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

// ---- one level up: this project's chats, each a cloud, newest first

const MAP = { clouds: [], byId: {}, newCloud: null, cols: 3, W: 860, H: 380, GX: 1080, GY: 640 };

function buildMap() {
  const proj = state.projects.find((p) => p.id === state.projectId);
  const chats = proj?.threads || []; // the server sorts them by last talked, newest first
  const items = proj?.fromClaude ? [...chats] : [{ id: null, isNew: true, title: "New chat", updated: null }, ...chats];
  const { vw, vh } = state.layout;
  const cols = (MAP.cols = vw < 760 || vh > vw * 1.15 ? 1 : items.length <= 4 ? 2 : 3);
  const { W, H, GX, GY } = MAP;
  MAP.byId = {};
  MAP.newCloud = null;
  MAP.clouds = items.map((it, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    // read like a page: newest top-left, older to the right and down, drifting a little
    const x = (col - (cols - 1) / 2) * GX + (row % 2 ? GX * 0.12 : -GX * 0.04) + Math.sin(i * 2.3) * 40;
    const y = row * GY + Math.sin(i * 1.7 + 0.6) * 60;
    const w = it.isNew ? W * 0.7 : W, h = it.isNew ? H * 0.62 : H;
    const seed = hashStr(it.id || state.projectId + ":new");
    const cl = {
      kind: "chat", key: "chat:" + (it.id || "new"), id: it.id, isNew: !!it.isNew, item: it, x, y, w, h,
      puffs: cloudPuffs(seed, w, h), ph: (seed % 628) / 100, depth: 0.8 + (i % 3) * 0.15, hov: 0, ghost: !!it.isNew,
    };
    if (it.id) MAP.byId[it.id] = cl;
    else MAP.newCloud = cl;
    return cl;
  });
  // The project's cloud up in the sky sits right over the chats you see first.
  const f = framed();
  SKY.origin = { x: (f.minX + f.maxX) / 2, y: (f.minY + f.maxY) / 2 };
  renderMapLabels();
  buildSky();
}

// The chats you see first when you rise out of a chat: the newest three rows.
function framed() {
  if (!MAP.clouds.length) return { minX: -MAP.W, maxX: MAP.W, minY: -MAP.H, maxY: MAP.H };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of MAP.clouds.slice(0, MAP.cols * 3)) {
    minX = Math.min(minX, c.x - MAP.W * 0.62); maxX = Math.max(maxX, c.x + MAP.W * 0.62);
    minY = Math.min(minY, c.y - MAP.H * 0.85); maxY = Math.max(maxY, c.y + MAP.H * 0.75);
  }
  return { minX, maxX, minY, maxY };
}

function camForChats() {
  const { vw, vh, topH } = state.layout;
  const f = framed();
  const s = Math.min((vw - 60) / (f.maxX - f.minX), (vh - topH - 50) / (f.maxY - f.minY), 0.55);
  return { x: (f.minX + f.maxX) / 2, y: (f.minY + f.maxY) / 2, s, r: 0 };
}

function hoverable(el, key) {
  const on = () => (SKY.hover = key), off = () => { if (SKY.hover === key) SKY.hover = null; };
  el.addEventListener("pointerenter", on); el.addEventListener("focus", on);
  el.addEventListener("pointerleave", off); el.addEventListener("blur", off);
}

function renderMapLabels() {
  mapEl.innerHTML = "";
  for (const cl of MAP.clouds) {
    const el = document.createElement("button");
    el.className = "map-cloud" + (cl.isNew ? " new" : "") + (cl.id && cl.id === state.thread?.id ? " here" : "");
    el.style.cssText = `left:${cl.x - cl.w / 2}px;top:${cl.y - cl.h / 2}px;width:${cl.w}px;height:${cl.h}px`;
    el.innerHTML = `<span class="name"></span><span class="meta"></span>`;
    $(".name", el).textContent = cl.isNew ? "+ New chat" : cl.item.title || "Untitled";
    $(".meta", el).textContent = cl.isNew ? "start fresh" : when(cl.item.updated) + (cl.item.source === "claude" ? " · Claude app" : cl.item.source === "claude.ai" ? " · claude.ai" : "");
    el.setAttribute("aria-label", cl.isNew ? "New chat" : `${cl.item.title}, ${when(cl.item.updated)}`);
    el.addEventListener("click", () => openFromMap(cl.id));
    hoverable(el, cl.key);
    mapEl.appendChild(el);
  }
  const f = framed();
  const w = document.createElement("div");
  w.className = "sky-word map-word";
  w.style.cssText = `left:${f.minX + 40}px;top:${f.minY - 60}px`;
  w.textContent = `${projectName(state.projectId)}: ${MAP.clouds.length ? "your chats, newest first" : "no chats yet"}`;
  mapEl.appendChild(w);
}

// ---- two levels up: every project is a cloud

function buildSky() {
  if (!state.projects.length) return;
  SKY.g = skyLayout();
  const g = SKY.g;
  SKY.clouds = [...g.personal, ...g.bank].map((p) => {
    const [w, h] = g.size[p.id], seed = hashStr(p.id);
    return {
      kind: "proj", key: "proj:" + p.id, id: p.id, c: skyToWorld(g.pos[p.id]), ghost: !!p.ghost,
      puffs: cloudPuffs(seed, w * SKY.K, h * SKY.K), ph: (seed % 628) / 100,
      depth: p.group === "client" || p.ghost ? 1.3 : 0.85 + (seed % 3) * 0.12, hov: 0,
    };
  });
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
    $(".meta", el).textContent = p.ghost ? "add one in projects.json" : n ? `${n} chat${n === 1 ? "" : "s"} · ${when(p.threads[0].updated)}` : "start here";
    if (!p.ghost) {
      el.setAttribute("aria-label", `${p.name}, ${$(".meta", el).textContent}`);
      el.addEventListener("click", () => enterProject(p.id));
      hoverable(el, "proj:" + p.id);
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
#define MAXP 96
uniform vec2 uCell0; uniform float uPitch; uniform vec2 uRot;
uniform vec4 uA[MAXP]; uniform int uNA; uniform vec4 uB[MAXP]; uniform int uNB;
uniform float uW, uT, uDens, uOffA, uOffB; uniform vec2 uSh; uniform vec4 uMoon;
out vec4 o;
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
float puff(vec4 c, vec2 p) { vec2 d = (p - c.xy) / c.z; d.y *= 1.3; float q = dot(d, d); float k = max(0., 1. - q); return k * k * c.w; }
// billows meet in a soft crease, not a seam
float smax(float a, float b) { float h = max(.3 - abs(a - b), 0.) / .3; return max(a, b) + h * h * .075 * smoothstep(0., .15, min(a, b)); }
float fA(vec2 p) { float f = 0., m = 0.; for (int i = 0; i < MAXP; i++) { if (i >= uNA) break; float k = puff(uA[i], p); f += k; m = smax(m, k); } return m + .22 * max(0., f - m); }
float fB(vec2 p) { float f = 0., m = 0.; for (int i = 0; i < MAXP; i++) { if (i >= uNB) break; float k = puff(uB[i], p); f += k; m = smax(m, k); } return m + .22 * max(0., f - m); }
float F(int w, vec2 p) { return w == 0 ? fA(p) : fB(p); }
// a smooth version of the same heap, for lighting: no creases to catch the light
float sA(vec2 p) { float f = 0.; for (int i = 0; i < MAXP; i++) { if (i >= uNA) break; f += puff(uA[i], p); } return f; }
float sB(vec2 p) { float f = 0.; for (int i = 0; i < MAXP; i++) { if (i >= uNB) break; f += puff(uB[i], p); } return f; }
float S(int w, vec2 p) { return w == 0 ? sA(p) : sB(p); }
float wob(vec2 p) { return vn(p * .011 + vec2(uT * .013, uT * .004)) + .5 * vn(p * .033 - vec2(uT * .021, 0.)) - .75; }
float cov(float f, vec2 p) { return smoothstep(.07, .55, f + wob(p) * .3); }
// One level of clouds: how cloudy this cell is, how much of the cloud here
// turns away from the light, and whether a cloud's shadow falls on it.
void level(int w, vec2 p, float off, out float c, out float und, out float shd) {
  float f = F(w, p);
  c = cov(f, p);
  // the field is a heap of domes: its slope gives each billow a surface to light
  float h = max(2., off * .6), s0 = S(w, p);
  float gx = (S(w, p + vec2(h, 0.)) - s0) / h, gy = (S(w, p + vec2(0., h)) - s0) / h;
  vec3 n = normalize(vec3(-gx, -gy, 2.2 / max(off * 5., 1.)));
  vec3 L = normalize(vec3(-uSh, .85));
  float dif = dot(n, L);
  und = c * smoothstep(.75, -.4, dif);
  // the shadow it casts on the sky below, a soft blur of its own shape
  vec2 s = p - uSh * off * 3.2;
  shd = smoothstep(.0, .62, F(w, s) + wob(s) * .2);
}
void main() {
  if (uDens < .002) { o = vec4(0.); return; }
  vec2 q = (uCell0 + floor(gl_FragCoord.xy) + .5) * uPitch;
  vec2 p = vec2(uRot.x * q.x + uRot.y * q.y, -uRot.y * q.x + uRot.x * q.y);
  float a = 0., au = 0., ac = 0., b = 0., bu = 0., bc = 0.;
  if (uW > .002) level(0, p, uOffA, a, au, ac);
  if (uW < .998) level(1, p, uOffB, b, bu, bc);
  float c = mix(b, a, uW);
  float und = mix(bu, au, uW);
  float fade = min(1., uDens * 3.);
  float shd = mix(bc, ac, uW) * (1. - c) * fade;
  float ink = min(1., uDens * (1. - c) * (1. + .4 * shd));
  if (uMoon.w > 0.) ink *= 1. - uMoon.w * (1. - smoothstep(uMoon.z * .9, uMoon.z * 1.1, length(p - uMoon.xy)));
  o = vec4(ink, und * fade, c, shd);
}`;

// Pass 2: print. Washi, the cloud bodies lit and shaded, the blue screen at
// 15° (deeper where a cloud's shadow falls), the red sun, and the one light
// falling across it all.
const FS_PRINT = `#version 300 es
precision highp float;
uniform sampler2D uCells; uniform sampler2D uWashi;
uniform vec2 uRes, uRot, uCell0, uCellN; uniform float uDpr, uPitch, uDark;
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
  vec4 sm = texture(uCells, (q / uPitch - uCell0) / uCellN);   // the same, smoothed
  // cloud bodies: a soft highlight toward the light, a cool shade turning away
  vec3 shadeCol = mix(uPaper, uBlue, .5) * .8;
  col = mix(col, vec3(1., .995, .98), sm.b * (1. - sm.g) * .2);
  col = mix(col, shadeCol, sm.g * .4);
  // a cloud's shadow on the sky: a cool wash between the dots
  col = mix(col, uBlue * .8, sm.a * .16);
  float d = length(q - (cell + .5) * uPitch), aa = .7 / uDpr;
  float rb = uPitch * .6 * sqrt(c.r);
  vec3 dotCol = mix(uBlue, uBlue * .7, smoothstep(0., 1., sm.a));
  col = mix(col, dotCol, (1. - smoothstep(rb - aa, rb + aa, d)) * .94 * step(.004, c.r));
  if (uSun.w > 0.) {
    float disc = 1. - smoothstep(uSun.z - aa, uSun.z + aa, length(p - uSun.xy));
    col = mix(col, uRed, disc * uSun.w * (1. - sm.b));
  }
  float rg = uPitch * .5 * sqrt(c.g * .22);
  col = mix(col, uGraph, (1. - smoothstep(rg - aa, rg + aa, d)) * .38 * step(.03, c.g));
  float t = clamp(dot(p - uLg.xy, uLg.zw), 0., 1.);
  col = t < .5 ? mix(col, vec3(1., .988, .957), .2 * (1. - t * 2.)) : mix(col, vec3(.118, .094, .07), uDark * (t * 2. - 1.));
  o = vec4(col, 1.);
}`;

// In a chat the sky prints deeper, so white letters read even at noon, and a
// few clouds drift in the margins. Up among the clouds it is the day's own sky.
const DEEP = [38, 66, 122];
const AMBIENT = [
  { fx: 0.075, fy: 0.34, w: 0.19, seed: 3 },
  { fx: 0.93, fy: 0.6, w: 0.21, seed: 8 },
  { fx: 0.86, fy: 0.17, w: 0.11, seed: 13 },
  { fx: 0.13, fy: 0.83, w: 0.13, seed: 21 },
];
let ambient = [];
function buildAmbient() {
  const vw = innerWidth;
  // only where there is sky to spare beside the chat
  ambient = vw < 1180 ? [] : AMBIENT.map((a) => {
    const W = a.w * vw, H = W * 0.46;
    return { ...a, puffs: cloudPuffs(a.seed, W, H), ph: a.seed * 0.7 };
  });
}

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
  try { P1 = compile(FS_CELLS); P2 = compile(FS_PRINT); } catch (e) {
    console.warn("Sky shader failed, printing paper only:", e);
    const fresh = cv.cloneNode(); // this canvas is spoken for by WebGL now
    cv.replaceWith(fresh);
    return paperOnly(fresh);
  }

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
  // texelFetch reads one cell for the dots; texture() blends cells for smooth shading
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
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
    buildAmbient();
    last = "";
  };
  let scene, light, sceneT = -Infinity, last = "", lastDraw = 0, hour = 12, lastKey = -Infinity;
  addEventListener("keydown", () => (lastKey = performance.now()), { capture: true, passive: true });
  resize();
  addEventListener("resize", resize);
  cv.addEventListener("webglcontextlost", (e) => e.preventDefault());

  const A = new Float32Array(96 * 4), B = new Float32Array(96 * 4);

  const frame = (now) => {
    requestAnimationFrame(frame);
    if (now - sceneT > 30000) {
      hour = hourNow();
      scene = sceneAt(hour); light = lightAt(hour); sceneT = now; last = "";
      state.night = scene.dens > 0.6;
      syncChrome();
      const rs = document.documentElement.style;
      rs.setProperty("--sx", light.sx.toFixed(3));
      rs.setProperty("--sy", light.sy.toFixed(3));
      rs.setProperty("--sa", light.sa.toFixed(2));
    }
    const c = state.cam, L = state.layout, s = c.s, k = state.chatK;
    const lw = levelW(s);
    const dens = scene.sky * (1 - k) + Math.max(scene.sky, 0.72) * k;
    let hovering = false;
    for (const cl of [...MAP.clouds, ...SKY.clouds]) {
      const want = cl.key === SKY.hover ? 1 : 0;
      if (Math.abs(cl.hov - want) > 0.004) { cl.hov += (want - cl.hov) * (reduceMotion ? 1 : 0.12); hovering = true; }
    }
    const key = [c.x, c.y, c.s, c.r, L.cx, L.cy, k].map((v) => (v || 0).toFixed(3)).join();
    // The sky only drifts a pixel or two a second, so it needn't repaint every frame:
    // a few times a second up in the sky, once a second behind a page, and not at all
    // while you're typing (a full-screen repaint per frame was what made typing lag).
    const calm = document.body.classList.contains("doc-full") ? 1000 : 200;
    const alive = dens > 0.002 && !reduceMotion && now - lastDraw > calm && now - lastKey > 1500;
    if (key === last && !alive && !hovering) return;
    last = key; lastDraw = now;

    // world → screen, exactly as #world is transformed
    const th = (-c.r * Math.PI) / 180, co = Math.cos(th), si = Math.sin(th);
    const t = reduceMotion ? 0 : now / 1000, TAU = Math.PI * 2;
    const vw = L.vw, vh = L.vh;
    const put = (arr, st, x, y, r, w) => {
      if (st.n >= 96 || w < 0.004 || r < 0.8 || x < -r || y < -r || x > vw + r || y > vh + r) return;
      arr.set([x, y, r, w], st.n * 4);
      st.rs += r; st.n++;
    };
    const cloudAt = (arr, st, cl, cx0, cy0, infl, wgt) => {
      const kk = infl * (1 + 0.07 * cl.hov) * (1 + 0.012 * Math.sin((t * TAU) / 41 + cl.ph));
      const dx = 5 * cl.depth * Math.sin((t * TAU) / (200 * cl.depth) + cl.ph), dy = 2 * Math.sin((t * TAU) / 290 + cl.ph * 1.7);
      for (const pf of cl.puffs) {
        const wx = cx0 + pf.x * kk - c.x, wy = cy0 + pf.y * kk - c.y;
        put(arr, st, L.cx + s * (wx * co - wy * si) + dx, L.cy + s * (wx * si + wy * co) + dy, pf.r * kk * s, pf.w * (cl.ghost ? 0.72 : 1) * wgt);
      }
    };
    const stA = { n: 0, rs: 0 }, stB = { n: 0, rs: 0 };
    if (dens > 0.002) {
      const mapClouds = () => { if (k < 0.996 && lw > 0.002) for (const cl of MAP.clouds) cloudAt(A, stA, cl, cl.x, cl.y, 1 + 1.4 * smooth(0.5, 1.3, s), 1 - k); };
      const driftClouds = () => {
        if (k < 0.004) return;
        ambient.forEach((a, i) => {
          const x0 = a.fx * vw + 22 * Math.sin((t * TAU) / 140 + a.ph), y0 = a.fy * vh + 6 * Math.sin((t * TAU) / 230 + i);
          for (const pf of a.puffs) put(A, stA, x0 + pf.x, y0 + pf.y, pf.r, pf.w * k * 0.92);
        });
      };
      if (k > 0.5) { driftClouds(); mapClouds(); } else { mapClouds(); driftClouds(); }
      if (lw < 0.998) for (const cl of SKY.clouds) cloudAt(B, stB, cl, cl.c.x, cl.c.y, 1, 1);
    }
    const offA = stA.n ? (stA.rs / stA.n) * 0.2 : 0, offB = stB.n ? (stB.rs / stB.n) * 0.2 : 0;
    const sl = Math.hypot(light.sx, light.sy) || 1;
    const night = smooth(0.62, 0.8, scene.dens), skyOnly = (1 - lw) * (1 - k);
    // the sun crosses the sky with the hour; at night a moon is left unprinted
    const arc = Math.max(0, Math.min(1, (hour - 6) / 12.5)), topH = L.topH || 60;
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
    gl.uniform4fv(u1.uA, A); gl.uniform1i(u1.uNA, stA.n);
    gl.uniform4fv(u1.uB, B); gl.uniform1i(u1.uNB, stB.n);
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
    gl.uniform2f(u2.uCellN, cw, ch);
    gl.uniform1f(u2.uDpr, dpr);
    gl.uniform1f(u2.uPitch, PITCH);
    gl.uniform1f(u2.uDark, 0.13 + scene.dens * 0.12);
    gl.uniform3fv(u2.uPaper, mix(PAPER, scene.ink, scene.dens * 0.42).map((v) => v / 255));
    gl.uniform3fv(u2.uBlue, mix(scene.blue, DEEP, 0.4 * k).map((v) => v / 255));
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

// Without WebGL 2: flat paper up among the clouds, a flat blue in a chat.
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
      state.night = scene.dens > 0.6;
      syncChrome();
      const rs = document.documentElement.style;
      rs.setProperty("--sx", light.sx.toFixed(3)); rs.setProperty("--sy", light.sy.toFixed(3)); rs.setProperty("--sa", light.sa.toFixed(2));
    }
    const c = state.cam, { cx = 0, cy = 0 } = state.layout, k = state.chatK;
    const key = [c.x, c.y, c.s, c.r, cx, cy, k].map((v) => v.toFixed(2)).join();
    if (key === last) return;
    last = key;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const paper = mix(PAPER, scene.ink, scene.dens * 0.42);
    ctx.fillStyle = rgb(mix(mix(paper, scene.blue, scene.sky * 0.5), mix(scene.blue, DEEP, 0.4), k));
    ctx.fillRect(0, 0, W, H);
    const fs = Math.max(0.55, c.s);
    washiPat.setTransform(new DOMMatrix().translate(cx * dpr, cy * dpr).scale(fs * dpr).rotate(-c.r).translate(-c.x * (c.s / fs), -c.y * (c.s / fs)));
    ctx.globalAlpha = 0.35; ctx.fillStyle = washiPat; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- moving between levels
// O rises one level: a chat → this project's chats as clouds → every project.
// Clicking a cloud dives back down through the same camera.

async function loadProjects() {
  state.projects = await api("/api/projects");
  return state.projects;
}

const chatCloud = () => (state.thread?.id && state.thread.projectId === state.projectId && MAP.byId[state.thread.id]) || MAP.newCloud || MAP.clouds[0] || { x: 0, y: 0 };

function leaveChat() {
  if (pageIsOpen()) closePage();
  hidePopover();
  closeDrawer();
  $("#notes-panel").classList.remove("open");
  input.blur();
}

function zoomOut() {
  if (state.view === "chat") return showChats();
  if (state.view === "chats") return showSky();
}

async function showChats(pid = state.projectId) {
  if (state.view === "sky") return enterProject(pid);
  leaveChat();
  const fromChat = state.view === "chat";
  const switching = pid !== state.projectId;
  state.projectId = pid;
  await loadProjects().catch(() => {});
  buildMap();
  if (fromChat) {
    // start just over the chat you were in, then rise until its neighbours come into view
    const cl = switching ? MAP.newCloud : chatCloud();
    Object.assign(state.cam, { x: cl.x, y: cl.y, s: 1.1, r: 0 });
    applyCam();
  }
  setView("chats");
  await Promise.all([tweenChatK(0, 650), flyTo(camForChats(), { dip: !fromChat, duration: reduceMotion ? 1 : fromChat ? 1500 : undefined })]);
}

async function showSky() {
  if (state.view === "sky") return;
  leaveChat();
  const fromChat = state.view === "chat";
  await loadProjects().catch(() => {});
  buildMap();
  if (!SKY.g) return;
  if (fromChat) {
    const cl = chatCloud();
    Object.assign(state.cam, { x: cl.x, y: cl.y, s: 1.1, r: 0 });
    applyCam();
  }
  setView("sky");
  await Promise.all([tweenChatK(0, 650), flyTo(camForSky(), { dip: false, duration: reduceMotion ? 1 : 2400 })]);
}

// Drift over to a project's cloud, sink into it, and its chats open out below.
async function enterProject(pid) {
  const cl = SKY.clouds.find((x) => x.id === pid);
  if (cl && SKY.g && !reduceMotion) await flyTo({ x: cl.c.x, y: cl.c.y, s: SKY.g.sSky * 2.6, r: 0 }, { dip: false, duration: 1300 });
  const s = state.cam.s;
  state.projectId = pid;
  buildMap(); // the world re-centres: this project's cloud now sits over its chats
  Object.assign(state.cam, { x: SKY.origin.x, y: SKY.origin.y, s, r: 0 });
  applyCam();
  setView("chats");
  await flyTo(camForChats(), { dip: false, duration: reduceMotion ? 1 : 1700 });
}

// Dive into a chat's cloud (or the "new chat" cloud) and the chat opens around you.
async function openFromMap(id) {
  const cl = id ? MAP.byId[id] : MAP.newCloud;
  const load = id && id !== state.thread?.id ? api(`/api/threads/${id}`) : null;
  if (cl) await flyTo({ x: cl.x, y: cl.y, s: 1.1, r: 0 }, { dip: false, duration: reduceMotion ? 1 : 1100 });
  try {
    if (!id) draftThread(state.projectId);
    else if (load) {
      state.thread = await load;
      state.projectId = state.thread.projectId;
      remember(id);
      renderThread();
    }
  } catch (err) {
    toast("Couldn't open that chat: " + err.message, true);
    return;
  }
  setView("chat");
  await tweenChatK(1, 700);
  state.msgs.forEach(positionMarginalia);
  if (!id) input.focus({ preventScroll: true });
}

// Esc / Enter up among the clouds: go back down where you came from.
function diveBack() {
  if (state.view === "sky") return enterProject(state.projectId);
  if (state.view !== "chats") return;
  const t = state.thread;
  if (t && t.projectId === state.projectId) return openFromMap(t.id || null);
  const latest = state.projects.find((p) => p.id === state.projectId)?.threads?.[0];
  return openFromMap(latest?.id || null);
}

// A quick fade between chats without leaving the sky.
async function swapFeed(fn) {
  if (!reduceMotion) await feed.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(-12px)" }], { duration: 200, easing: "ease-in" }).finished;
  await fn();
  if (!reduceMotion) feed.animate([{ opacity: 0, transform: "translateY(16px)" }, { opacity: 1, transform: "none" }], { duration: 450, easing: "cubic-bezier(.25,.8,.25,1)" });
}

async function goToChat(id) {
  if (pageIsOpen()) await closePage();
  if (state.view === "chat") {
    if (id === state.thread?.id) return;
    return swapFeed(() => openThread(id).catch((e) => toast("Couldn't open that chat: " + e.message, true)));
  }
  const t = state.projects.flatMap((p) => p.threads || []).find((x) => x.id === id);
  if (state.view === "chats" && t?.projectId === state.projectId) return openFromMap(id);
  await openThread(id).catch((e) => toast("Couldn't open that chat: " + e.message, true));
  setView("chat");
  await tweenChatK(1, 700);
}

async function newChat(pid = state.projectId) {
  if (pageIsOpen()) await closePage();
  if (state.projects.find((p) => p.id === pid)?.fromClaude) {
    pid = state.projects.find((p) => !p.fromClaude)?.id || pid;
    toast(`New chats start in a Shell project: ${projectName(pid)}`);
  }
  if (state.view === "chat") await swapFeed(() => draftThread(pid));
  else if (state.view === "chats" && pid === state.projectId) return openFromMap(null);
  else {
    draftThread(pid);
    setView("chat");
    await tweenChatK(1, 700);
  }
  input.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- pan / zoom among the clouds

function overviewControls() {
  const far = () => state.view !== "chat";
  let drag = null, suppressClick = false;
  viewportEl.addEventListener("pointerdown", (e) => {
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
  viewportEl.addEventListener("click", (e) => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
  // Ordinary scrolling changes the overview camera. Pinch belongs to the browser.
  let settle;
  addEventListener("wheel", (e) => {
    if (e.ctrlKey || !far() || !viewportEl.contains(e.target)) return;
    e.preventDefault();
    if (flight) return;
    const c = state.cam, L = state.layout;
    const s1 = Math.max((SKY.g?.sSky || 0.02) * 0.75, Math.min(0.9, c.s * Math.exp(-e.deltaY * 0.0018)));
    // keep the point under the cursor still
    const th = (-c.r * Math.PI) / 180, mx = e.clientX - L.cx, my = e.clientY - L.cy;
    const wx = mx * Math.cos(th) + my * Math.sin(th), wy = -mx * Math.sin(th) + my * Math.cos(th);
    c.x += wx / c.s - wx / s1; c.y += wy / c.s - wy / s1; c.s = s1;
    applyCam();
    const up = levelW(s1) < 0.5;
    if (up && state.view === "chats") setView("sky");
    else if (!up && state.view === "sky") setView("chats");
    clearTimeout(settle);
    if (SKY.g && s1 < SKY.g.sSky * 1.25) settle = setTimeout(() => flyTo(camForSky(), { dip: false, duration: 900 }), 220);
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
$("#drawer-sky").addEventListener("click", () => { closeDrawer(); showSky(); });
$("#drawer-page").addEventListener("click", () => { closeDrawer(); startPage(); });
$("#drawer-file").addEventListener("click", () => {
  closeDrawer();
  if (state.view !== "chat") { leaveChat(); setView("chat"); tweenChatK(1, 700); }
  openPicker();
});
$("#btn-new").addEventListener("click", () => newChat());
$("#brand").addEventListener("click", () => (state.view === "sky" ? diveBack() : showSky()));
$("#crumb-project").addEventListener("click", () => (state.view === "chat" ? showChats() : diveBack()));
$("#btn-overview").addEventListener("click", () => (state.view === "sky" ? diveBack() : zoomOut()));
$("#attach-chip").addEventListener("click", () => $("#notes-panel").classList.toggle("open"));
$("#notes-close").addEventListener("click", () => $("#notes-panel").classList.remove("open"));
$("#attach-clear").addEventListener("click", () => {
  if (!confirm(`Discard ${state.notes.length} notes?`)) return;
  state.notes = [];
  saveNotes();
});

$("#btn-type").addEventListener("click", async () => {
  closeDrawer();
  dismissPageMenus();
  $("#notes-panel").classList.remove("open");
  hidePopover();
  if (state.view !== "chat") {
    if (state.thread?.projectId !== state.projectId && !pageIsOpen()) draftThread(shellProject());
    setView("chat");
    const cloud = chatCloud();
    flyTo({ x: cloud.x, y: cloud.y, s: 1.1, r: 0 }, { duration: 1, dip: false });
    tweenChatK(1, 700);
  }
  if (document.body.classList.contains("readonly")) {
    await newChat();
  } else {
    input.focus({ preventScroll: true });
  }
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
  if (e.key === "Escape" && $("#drawer").classList.contains("open")) return closeDrawer();
  if (pageIsOpen() && docFull()) {
    if (e.key === "Escape" || e.key === "o") return springDoc(0); // step back to talk it over
  } else if (pageIsOpen() && state.view === "chat") {
    if (e.key === "i" || e.key === "Enter") return springDoc(1); // back into the page
    if (e.key === "o") return closePage().then(zoomOut);
  }
  if (state.view !== "chat") {
    if (e.key === "o") zoomOut();
    else if (["Escape", "Enter", "i"].includes(e.key)) diveBack();
    else if (e.key === "n") newChat();
    else if (e.key === "t") openDrawer();
    else if (e.key === "p") showSky();
    return;
  }
  // Type anywhere to start writing. Lowercase o, p, t, n stay shortcuts; a
  // capital (the start of a sentence) always goes to the composer.
  if (e.key.length === 1 && !/^[otnp/]$/.test(e.key)) { input.focus({ preventScroll: true }); return; }
  if (e.key === "o") zoomOut();
  else if (e.key === "t") openDrawer();
  else if (e.key === "n") newChat();
  else if (e.key === "p") showSky();
  else if (e.key === "/") { e.preventDefault(); input.focus(); }
});

let resizeT;
addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    measure();
    if (state.projects.length) buildMap();
    if (state.view === "chats") Object.assign(state.cam, camForChats());
    else if (state.view === "sky" && SKY.g) Object.assign(state.cam, camForSky());
    else { const cl = chatCloud(); if (cl) Object.assign(state.cam, { x: cl.x, y: cl.y, s: 1.1, r: 0 }); }
    applyCam();
    state.msgs.forEach(positionMarginalia);
    DOC.anchor = null;
    renderDoc();
  }, 80);
});

// Chrome gets out of the way: after a few still seconds only the sky and the chat remain.
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

// ---------------------------------------------------------------- claude.ai sync
// Shell imports a claude.ai export the moment it lands in Downloads. If the last
// one is over a week old, a pencil line in the sky says so, with the way to a new one.

const EXPORT_URL = "https://claude.ai/settings/data-privacy-controls";
let lastImport = null;

function renderSyncNudge(info) {
  const el = $("#sync-nudge");
  const age = info?.importedAt ? Date.now() - info.importedAt : Infinity;
  const stale = age > 7 * 864e5;
  el.hidden = !stale;
  if (!stale) return;
  el.innerHTML = info?.importedAt
    ? `claude.ai chats last brought in ${esc(when(info.importedAt).toLowerCase())}. <a target="_blank" rel="noopener">Export a fresh copy</a>, then download it from the email.`
    : `Bring your claude.ai chats into the sky: <a target="_blank" rel="noopener">export them</a>, then download the zip from the email. Shell picks it up from Downloads.`;
  $("a", el).href = EXPORT_URL;
}

async function checkSync() {
  try {
    const s = await api("/api/status");
    const info = s.claudeAi;
    if (lastImport !== null && info.importedAt > lastImport) {
      toast(`Brought in ${info.chats} claude.ai chats`);
      await loadProjects().catch(() => {});
      if (state.view !== "chat") buildMap();
    }
    lastImport = info.importedAt;
    renderSyncNudge(info);
  } catch {}
}

async function boot() {
  initPage({ api, toast, esc, marked, DOMPurify, input, projectName, projectId: () => shellProject(), onOpen: pageOpened, onClose: pageClosed, onBack: () => springDoc(0) });
  $("#btn-page").addEventListener("click", startPage);
  if (innerWidth <= 760) input.placeholder = "Say something";
  if (window.visualViewport) {
    visualViewport.addEventListener("resize", measureVisibleViewport);
    visualViewport.addEventListener("scroll", measureVisibleViewport);
    addEventListener("resize", measureVisibleViewport);
    measureVisibleViewport();
  }
  new ResizeObserver(() => {
    const bar = $("#page-bar");
    document.documentElement.style.setProperty("--page-bar-h", `${bar.offsetHeight}px`);
  }).observe($("#page-bar"));
  new ResizeObserver(measureComposer).observe($("#composer"));
  measure();
  setChatK(0);
  setView("chat");
  quietChrome();
  ground();
  overviewControls();
  pinchControls();
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
  checkSync();
  setInterval(checkSync, 60_000);
  await loadProjects().catch(() => {});
  const list = await api("/api/threads").catch(() => []);
  let last = null;
  try { last = localStorage.getItem("shell.lastThread"); } catch {}
  const qs = new URLSearchParams(location.search);
  if (location.search) history.replaceState(null, "", location.pathname);
  // "Take it to the skeye": /?skeye=<Claude app session id>[&doc=<file>] (doc: start in that document)
  const skeye = qs.get("skeye"), doc = qs.get("doc");
  // /?thread=<id> opens that chat (the original chat links back to its skeye chat this way).
  const want = qs.get("thread");
  if (want) last = want;
  let pick = list.find((t) => t.id === last) || list[0];
  if (skeye) {
    try { const t = await api(`/api/skeye/${encodeURIComponent(skeye)}`, { method: "POST" }); await loadProjects().catch(() => {}); pick = t; } catch {}
  }
  state.projectId = pick?.projectId || state.projects[0]?.id;
  if (pick) await openThread(pick.id);
  else draftThread(state.projectId);
  // the skeye's document, /?page=<id>, or the page you had open when you left
  let pageId = qs.get("page");
  if (doc) {
    await openFile(doc, state.projectId, pick?.id).catch((e) => toast("Couldn't open " + doc.split("/").pop() + ": " + e.message, true));
  } else {
    if (!pageId) try { pageId = localStorage.getItem("shell.lastPage"); } catch {}
    if (pageId) openPage(pageId).catch(() => { try { localStorage.removeItem("shell.lastPage"); } catch {} });
  }
  buildMap();
  // Open just above this chat's cloud, then sink into it.
  const cl = chatCloud();
  if (cl) Object.assign(state.cam, { x: cl.x, y: cl.y, s: 1.1, r: 0 });
  applyCam();
  await tweenChatK(1, 1100);
  state.msgs.forEach(positionMarginalia);
}

boot();
