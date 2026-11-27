import * as pdfjsLib from '../vendor/pdf.min.mjs';
import * as db from './db.js';
import { drawStroke, drawGrowth, hits, bbox } from './ink.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
const PDF_OPTS = {
  cMapUrl: new URL('../vendor/cmaps/', import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('../vendor/standard_fonts/', import.meta.url).href,
  isEvalSupported: false,
};

const PEN_COLORS = ['#1d1d1f', '#2557d6', '#d62828', '#1b8a4c'];
const HL_COLORS = ['#ffd60a', '#7ae582', '#ff8fab', '#7cc6ff'];
// Pen and highlighter widths are in page units (pt); eraser radii are in screen px.
const SIZES = { pen: [1.1, 2, 3.4], hl: [9, 15, 24], eraser: [8, 16, 32] };
const SIZE_DOTS = [5, 9, 14];
const A4 = [595.28, 841.89];
const MAX_CANVAS_PX = 8e6; // iOS Safari limits canvas area and total canvas memory
const MIN_Z = 0.3;
const MAX_Z = 6;
const PALM_WINDOW_MS = 1200;

const $ = (s) => document.querySelector(s);
const el = {
  library: $('#library'), editor: $('#editor'), docList: $('#doc-list'), libEmpty: $('#lib-empty'),
  fileInput: $('#file-input'), stage: $('#stage'), scroller: $('#scroller'), pages: $('#pages'),
  live: $('#live'), indicator: $('#page-indicator'), title: $('#doc-title'), saveState: $('#save-state'),
  swatches: $('#swatches'), sizes: $('#sizes'), undo: $('#btn-undo'), redo: $('#btn-redo'),
  menu: $('#menu'), more: $('#btn-more'), exportDialog: $('#export-dialog'), exportInfo: $('#export-info'),
  share: $('#btn-share'), toast: $('#toast'),
};
const liveCtx = el.live.getContext('2d');

const prefs = JSON.parse(localStorage.getItem('prefs') || '{}');
const S = {
  doc: null, pdf: null, pdfBytes: null,
  zoom: 1, fit: true,
  tool: prefs.tool || 'pen',
  color: { pen: prefs.penColor || PEN_COLORS[0], hl: prefs.hlColor || HL_COLORS[0] },
  size: { pen: prefs.penSize ?? 1, hl: prefs.hlSize ?? 1, eraser: prefs.eraserSize ?? 1 },
  finger: !!prefs.finger,
  undo: [], redo: [],
  views: [], current: 0,
  active: null, gesture: null, lastPen: 0,
  dirty: false, exported: null,
};

function savePrefs() {
  localStorage.setItem('prefs', JSON.stringify({
    tool: S.tool, penColor: S.color.pen, hlColor: S.color.hl,
    penSize: S.size.pen, hlSize: S.size.hl, eraserSize: S.size.eraser, finger: S.finger,
  }));
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

let toastTimer = 0;
function toast(msg, ms = 1800) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}
function hideToast() {
  clearTimeout(toastTimer);
  el.toast.classList.remove('show');
}

function fmtDate(t) {
  return new Date(t).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtSize(n) {
  return n > 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1e3))}KB`;
}

/* ================= library ================= */

async function showLibrary() {
  await closeEditor();
  el.editor.hidden = true;
  el.library.hidden = false;
  const metas = await db.listMeta();
  el.docList.replaceChildren(...metas.map(docCard));
  el.libEmpty.hidden = metas.length > 0;
}

function docCard(m) {
  const d = document.createElement('div');
  d.className = 'doc-card';
  d.innerHTML = `<button class="doc-open"><svg><use href="#i-${m.hasPdf ? 'doc' : 'note'}"/></svg>`
    + '<div><div class="name"></div><div class="info"></div></div></button>'
    + '<div class="card-actions"><button data-a="rename">이름 바꾸기</button><button data-a="delete" class="danger">삭제</button></div>';
  d.querySelector('.name').textContent = m.name;
  d.querySelector('.info').textContent = `${m.pageCount}쪽 · ${fmtDate(m.updated)}`;
  d.querySelector('.doc-open').onclick = () => openDoc(m.id);
  d.querySelector('[data-a=rename]').onclick = async () => {
    const name = prompt('문서 이름', m.name)?.trim();
    if (!name) return;
    await db.renameDoc(m.id, name);
    showLibrary();
  };
  d.querySelector('[data-a=delete]').onclick = async () => {
    if (!confirm(`"${m.name}"을(를) 삭제할까요? 필기도 함께 지워지고 되돌릴 수 없습니다.`)) return;
    await db.deleteDoc(m.id);
    showLibrary();
  };
  return d;
}

async function createDocFromPdf(name, bytes) {
  const pdf = await pdfjsLib.getDocument({ ...PDF_OPTS, data: bytes.slice() }).promise;
  const pages = [];
  for (let i = 0; i < pdf.numPages; i++) {
    const pg = await pdf.getPage(i + 1);
    const vp = pg.getViewport({ scale: 1 });
    pages.push({ id: uid(), kind: 'pdf', src: i, w: vp.width, h: vp.height, strokes: [] });
  }
  await pdf.destroy();
  const fileId = uid();
  await db.saveFile(fileId, bytes);
  const now = Date.now();
  const doc = { id: uid(), name, fileId, pages, created: now, updated: now };
  await db.saveDoc(doc);
  return doc;
}

async function createBlankNote() {
  const d = new Date();
  const now = Date.now();
  const doc = {
    id: uid(), name: `노트 ${d.getMonth() + 1}월 ${d.getDate()}일`, fileId: null,
    pages: [{ id: uid(), kind: 'blank', w: A4[0], h: A4[1], strokes: [] }],
    created: now, updated: now,
  };
  await db.saveDoc(doc);
  await openDoc(doc.id);
}

el.fileInput.addEventListener('change', async () => {
  const f = el.fileInput.files[0];
  el.fileInput.value = '';
  if (!f) return;
  toast('PDF 여는 중…', 60000);
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const doc = await createDocFromPdf(f.name.replace(/\.pdf$/i, ''), bytes);
    hideToast();
    await openDoc(doc.id);
  } catch (e) {
    console.error(e);
    toast('PDF를 열 수 없습니다');
  }
});
$('#btn-new-blank').onclick = createBlankNote;

/* ================= editor lifecycle ================= */

async function openDoc(id) {
  const doc = await db.loadDoc(id);
  if (!doc) return;
  S.doc = doc;
  S.undo = [];
  S.redo = [];
  S.current = 0;
  S.fit = true;
  S.dirty = false;
  if (doc.fileId) {
    S.pdfBytes = await db.loadFile(doc.fileId);
    S.pdf = await pdfjsLib.getDocument({ ...PDF_OPTS, data: S.pdfBytes.slice() }).promise;
  } else {
    S.pdfBytes = null;
    S.pdf = null;
  }
  el.library.hidden = true;
  el.editor.hidden = false;
  el.title.textContent = doc.name;
  setSaveState('');
  resizeLive();
  S.zoom = fitZoom();
  buildPages();
  el.scroller.scrollTop = 0;
  el.scroller.scrollLeft = 0;
  updateIndicator();
  updateUndoButtons();
  refreshToolbar();
}

async function closeEditor() {
  if (!S.doc) return;
  await flushSave();
  observer?.disconnect();
  for (const v of S.views) release(v);
  S.views = [];
  el.pages.replaceChildren();
  const pdf = S.pdf;
  S.doc = null;
  S.pdf = null;
  S.pdfBytes = null;
  S.undo = [];
  S.redo = [];
  await pdf?.destroy();
}

$('#btn-back').onclick = showLibrary;

/* ================= saving ================= */

let saveTimer = 0;
let saving = Promise.resolve();

function setSaveState(t) {
  el.saveState.textContent = t;
}

function markDirty() {
  S.dirty = true;
  setSaveState('');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 800);
}

function flushSave() {
  clearTimeout(saveTimer);
  if (!S.doc || !S.dirty) return saving;
  S.dirty = false;
  const doc = S.doc;
  saving = saving
    .then(() => db.saveDoc(doc))
    .then(() => { if (S.doc === doc && !S.dirty) setSaveState('저장됨'); })
    .catch((e) => {
      console.error(e);
      S.dirty = true;
      setSaveState('저장 실패');
      toast('저장하지 못했습니다. 저장 공간을 확인하세요.', 4000);
    });
  return saving;
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
window.addEventListener('pagehide', flushSave);

/* ================= pages and rendering ================= */

let observer = null;
let rerenderTimer = 0;

function buildPages() {
  observer?.disconnect();
  for (const v of S.views) release(v);
  el.pages.replaceChildren();
  S.views = S.doc.pages.map((page) => {
    const pageEl = document.createElement('div');
    pageEl.className = 'page';
    const pdfC = document.createElement('canvas');
    pdfC.className = 'pdf-layer';
    const inkC = document.createElement('canvas');
    inkC.className = 'ink-layer';
    pageEl.append(pdfC, inkC);
    const v = { page, el: pageEl, pdfC, inkC, visible: false, scale: 0, inkReady: false, task: null, token: null };
    pageEl._view = v;
    el.pages.append(pageEl);
    return v;
  });
  layout();
  observer = new IntersectionObserver(onIntersect, { root: el.scroller, rootMargin: '60% 0px' });
  for (const v of S.views) observer.observe(v.el);
}

function layout() {
  el.pages.style.setProperty('--z', S.zoom);
  for (const v of S.views) {
    v.el.style.width = `${v.page.w * S.zoom}px`;
    v.el.style.height = `${v.page.h * S.zoom}px`;
  }
}

function onIntersect(entries) {
  for (const e of entries) {
    const v = e.target._view;
    if (e.isIntersecting) {
      v.visible = true;
      renderView(v);
    } else if (v.visible) {
      release(v);
    }
  }
}

function computeScale(v) {
  let scale = S.zoom * (window.devicePixelRatio || 1);
  const area = v.page.w * v.page.h * scale * scale;
  if (area > MAX_CANVAS_PX) scale *= Math.sqrt(MAX_CANVAS_PX / area);
  v.scale = scale;
}

function renderView(v) {
  computeScale(v);
  if (v.page.strokes.length || v.inkReady) paintInk(v);
  if (v.page.kind === 'pdf') renderPdf(v);
}

function paintInk(v) {
  if (!v.scale) computeScale(v);
  const c = v.inkC;
  const W = Math.round(v.page.w * v.scale);
  const H = Math.round(v.page.h * v.scale);
  if (c.width !== W || c.height !== H) {
    c.width = W;
    c.height = H;
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.setTransform(v.scale, 0, 0, v.scale, 0, 0);
  for (const s of v.page.strokes) drawStroke(ctx, s);
  v.inkReady = true;
}

function inkAdd(v, s) {
  if (!v.inkReady) {
    paintInk(v);
    return;
  }
  const ctx = v.inkC.getContext('2d');
  ctx.setTransform(v.scale, 0, 0, v.scale, 0, 0);
  drawStroke(ctx, s);
}

async function renderPdf(v) {
  v.task?.cancel();
  v.task = null;
  const token = {};
  v.token = token;
  const pdf = S.pdf;
  try {
    const page = await pdf.getPage(v.page.src + 1);
    if (v.token !== token) return;
    const vp = page.getViewport({ scale: v.scale });
    const c = document.createElement('canvas');
    c.className = 'pdf-layer';
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const task = page.render({ canvasContext: c.getContext('2d'), viewport: vp });
    v.task = task;
    await task.promise;
    if (v.token !== token) {
      c.width = c.height = 0;
      return;
    }
    v.task = null;
    // Swap in the finished canvas, so a zoom never shows a blank page meanwhile.
    v.el.replaceChild(c, v.pdfC);
    v.pdfC.width = v.pdfC.height = 0;
    v.pdfC = c;
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException' && S.pdf === pdf) console.error(e);
  }
}

function release(v) {
  v.visible = false;
  v.token = null;
  v.task?.cancel();
  v.task = null;
  v.pdfC.width = v.pdfC.height = 0;
  v.inkC.width = v.inkC.height = 0;
  v.inkReady = false;
  v.scale = 0;
}

function scheduleRerender() {
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => {
    for (const v of S.views) if (v.visible) renderView(v);
  }, 150);
}

/* ================= zoom and scroll ================= */

function fitZoom() {
  const p = S.doc.pages[S.current] || S.doc.pages[0];
  return clamp(el.scroller.clientWidth / (p.w + 28), MIN_Z, MAX_Z);
}

// The page under viewport point (fx, fy) and the page-unit coordinates of that point.
function anchorAt(fx, fy) {
  const sr = el.scroller.getBoundingClientRect();
  const y = sr.top + fy;
  const v = S.views.find((w) => {
    const r = w.el.getBoundingClientRect();
    return y >= r.top && y <= r.bottom;
  }) || S.views[S.current];
  const r = v.el.getBoundingClientRect();
  return { v, ux: (sr.left + fx - r.left) / S.zoom, uy: (y - r.top) / S.zoom };
}

// Sets the zoom and scrolls so the anchored page point sits at viewport point (fx, fy).
function applyZoom(z, anchor, fx, fy) {
  S.zoom = clamp(z, MIN_Z, MAX_Z);
  layout();
  const sr = el.scroller.getBoundingClientRect();
  const r = anchor.v.el.getBoundingClientRect();
  el.scroller.scrollLeft += r.left + anchor.ux * S.zoom - (sr.left + fx);
  el.scroller.scrollTop += r.top + anchor.uy * S.zoom - (sr.top + fy);
  scheduleRerender();
}

// Zooms keeping the content under viewport point (fx, fy) in place.
function zoomAround(z, fx, fy) {
  if (!S.views.length) return;
  applyZoom(z, anchorAt(fx, fy), fx, fy);
}

function setFit() {
  S.fit = true;
  zoomAround(fitZoom(), 0, 0);
  el.scroller.scrollLeft = 0;
}

function zoomStep(f) {
  S.fit = false;
  zoomAround(S.zoom * f, el.scroller.clientWidth / 2, el.scroller.clientHeight / 2);
}

let scrollRaf = 0;
el.scroller.addEventListener('scroll', () => {
  if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; trackCurrent(); });
}, { passive: true });

function trackCurrent() {
  const probe = el.scroller.scrollTop + el.scroller.clientHeight * 0.4;
  let i = 0;
  while (i < S.views.length - 1 && S.views[i + 1].el.offsetTop <= probe) i++;
  if (i !== S.current) {
    S.current = i;
    updateIndicator();
  }
}

function updateIndicator() {
  el.indicator.textContent = S.views.length ? `${S.current + 1} / ${S.views.length}` : '';
}

function scrollToPage(i) {
  const v = S.views[i];
  if (!v) return;
  el.scroller.scrollTop = v.el.offsetTop - 14 * S.zoom;
  S.current = i;
  updateIndicator();
}

el.scroller.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const sr = el.scroller.getBoundingClientRect();
  S.fit = false;
  zoomAround(S.zoom * Math.exp(-e.deltaY * 0.01), e.clientX - sr.left, e.clientY - sr.top);
}, { passive: false });

document.addEventListener('gesturestart', (e) => e.preventDefault());

let liveDpr = 1;
function resizeLive() {
  const r = el.stage.getBoundingClientRect();
  liveDpr = window.devicePixelRatio || 1;
  el.live.width = Math.max(1, Math.round(r.width * liveDpr));
  el.live.height = Math.max(1, Math.round(r.height * liveDpr));
}

let lastStageW = 0;
new ResizeObserver(() => {
  if (el.editor.hidden || !S.doc) return;
  resizeLive();
  const w = el.stage.clientWidth;
  if (S.fit && w !== lastStageW) zoomAround(fitZoom(), 0, 0);
  lastStageW = w;
}).observe(el.stage);

/* ================= drawing ================= */

function canDraw(e) {
  if (S.gesture) return false;
  if (e.pointerType === 'pen') return true;
  if (e.pointerType === 'mouse') return e.button === 0;
  return e.pointerType === 'touch' && S.finger;
}

// Positions the live layer so page coordinates of v map onto the screen.
function liveTransform(v) {
  const pr = v.el.getBoundingClientRect();
  const sr = el.stage.getBoundingClientRect();
  const k = liveDpr * S.zoom;
  liveCtx.setTransform(k, 0, 0, k, liveDpr * (pr.left - sr.left), liveDpr * (pr.top - sr.top));
  return pr;
}

function clearLive() {
  liveCtx.setTransform(1, 0, 0, 1, 0, 0);
  liveCtx.clearRect(0, 0, el.live.width, el.live.height);
}

function pointerPressure(ev) {
  if (ev.pointerType !== 'pen') return 0.5;
  return ev.pressure > 0 ? ev.pressure : 0.3;
}

function addPoints(a, events) {
  const pr = liveTransform(a.v);
  const s = a.stroke;
  const minStep = 0.35 / S.zoom;
  for (const ev of events) {
    const x = (ev.clientX - pr.left) / S.zoom;
    const y = (ev.clientY - pr.top) / S.zoom;
    const n = s.p.length;
    if (n && Math.abs(x - s.p[n - 3]) < minStep && Math.abs(y - s.p[n - 2]) < minStep) continue;
    const raw = pointerPressure(ev);
    a.pr = a.pr == null ? raw : a.pr * 0.6 + raw * 0.4;
    s.p.push(x, y, a.pr);
    drawGrowth(liveCtx, s);
  }
}

function eraseAt(a, ev) {
  const v = a.v;
  const pr = v.el.getBoundingClientRect();
  const x = (ev.clientX - pr.left) / S.zoom;
  const y = (ev.clientY - pr.top) / S.zoom;
  const r = SIZES.eraser[S.size.eraser] / S.zoom;
  const strokes = v.page.strokes;
  // Sample the path since the previous event, so a fast swipe does not skip strokes.
  const [lx, ly] = a.last || [x, y];
  const steps = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / (r / 2)));
  a.last = [x, y];
  let changed = false;
  for (let i = strokes.length - 1; i >= 0; i--) {
    for (let k = 1; k <= steps; k++) {
      if (hits(strokes[i], lx + ((x - lx) * k) / steps, ly + ((y - ly) * k) / steps, r)) {
        a.removed.push({ stroke: strokes[i], idx: i });
        strokes.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  if (changed) paintInk(v);
  clearLive();
  liveTransform(v);
  liveCtx.lineWidth = 1 / S.zoom;
  liveCtx.strokeStyle = 'rgba(0,0,0,0.45)';
  liveCtx.fillStyle = 'rgba(255,255,255,0.35)';
  liveCtx.beginPath();
  liveCtx.arc(x, y, r, 0, Math.PI * 2);
  liveCtx.fill();
  liveCtx.stroke();
}

function coalesced(e) {
  const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  return list.length ? list : [e];
}

function onPointerDown(e) {
  if (e.pointerType === 'pen') S.lastPen = performance.now();
  if (S.active || !canDraw(e)) return;
  const pageEl = e.target.closest('.page');
  if (!pageEl) return;
  e.preventDefault();
  closeMenu();
  try {
    el.pages.setPointerCapture(e.pointerId);
  } catch {
    // capture is an optimization; drawing works without it
  }
  const a = { id: e.pointerId, type: e.pointerType, v: pageEl._view, tool: S.tool, pr: null };
  S.active = a;
  if (a.tool === 'eraser') {
    a.removed = [];
    eraseAt(a, e);
    return;
  }
  el.live.classList.toggle('hl', a.tool === 'hl');
  a.stroke = { t: a.tool, c: S.color[a.tool], w: SIZES[a.tool][S.size[a.tool]], p: [] };
  addPoints(a, [e]);
}

function onPointerMove(e) {
  if (e.pointerType === 'pen') S.lastPen = performance.now();
  const a = S.active;
  if (!a || e.pointerId !== a.id) return;
  e.preventDefault();
  const evs = coalesced(e);
  if (a.tool === 'eraser') for (const ev of evs) eraseAt(a, ev);
  else addPoints(a, evs);
}

function finishStroke() {
  const a = S.active;
  if (!a) return;
  S.active = null;
  clearLive();
  el.live.classList.remove('hl');
  if (a.tool === 'eraser') {
    if (a.removed.length) pushOp({ type: 'erase', page: a.v.page, items: a.removed });
    return;
  }
  const s = a.stroke;
  if (!s.p.length) return;
  s.p = Float32Array.from(s.p);
  s.bb = bbox(s);
  a.v.page.strokes.push(s);
  inkAdd(a.v, s);
  pushOp({ type: 'add', page: a.v.page, stroke: s });
}

function abortStroke() {
  const a = S.active;
  if (!a) return;
  if (a.tool === 'eraser') {
    finishStroke();
    return;
  }
  S.active = null;
  clearLive();
  el.live.classList.remove('hl');
}

function onPointerEnd(e) {
  if (e.pointerType === 'pen') S.lastPen = performance.now();
  if (S.active && e.pointerId === S.active.id) finishStroke();
}

el.pages.addEventListener('pointerdown', onPointerDown);
el.pages.addEventListener('pointermove', onPointerMove);
el.pages.addEventListener('pointerup', onPointerEnd);
el.pages.addEventListener('pointercancel', onPointerEnd);
el.editor.addEventListener('contextmenu', (e) => e.preventDefault());

/* ================= touch: palm rejection, pinch zoom ================= */

// Pencil input draws through pointer events and must never scroll the page; Safari marks
// it as touchType 'stylus'. Finger touches scroll natively, except a palm resting while
// writing: a touch that starts shortly after Pencil activity, or a broad contact, is ignored.
const palmIds = new Set();
const isStylus = (t) => t.touchType === 'stylus';
const fingersOf = (list) => [...list].filter((t) => !isStylus(t) && !palmIds.has(t.identifier));

function onTouchStart(e) {
  const now = performance.now();
  for (const t of e.changedTouches) {
    if (isStylus(t)) {
      S.lastPen = now;
      e.preventDefault();
      continue;
    }
    if (!S.finger && (now - S.lastPen < PALM_WINDOW_MS || (t.radiusX || 0) > 30)) palmIds.add(t.identifier);
  }
  const fingers = fingersOf(e.touches);
  if (fingers.length >= 2) {
    e.preventDefault();
    if (!S.gesture) startGesture(fingers);
    return;
  }
  if (S.finger && fingers.length === 1) e.preventDefault();
  if ([...e.changedTouches].some((t) => palmIds.has(t.identifier))) e.preventDefault();
}

function onTouchMove(e) {
  if (S.gesture) {
    if (!e.cancelable) {
      cancelGesture();
      return;
    }
    e.preventDefault();
    moveGesture(e);
    return;
  }
  if (S.finger || [...e.changedTouches].some((t) => isStylus(t) || palmIds.has(t.identifier))) {
    if (e.cancelable) e.preventDefault();
  }
}

function onTouchEnd(e) {
  for (const t of e.changedTouches) palmIds.delete(t.identifier);
  if (S.gesture && fingersOf(e.touches).length < 2) endGesture();
}

el.scroller.addEventListener('touchstart', onTouchStart, { passive: false });
el.scroller.addEventListener('touchmove', onTouchMove, { passive: false });
el.scroller.addEventListener('touchend', onTouchEnd);
el.scroller.addEventListener('touchcancel', onTouchEnd);

function touchPair(list, ids) {
  const a = [...list].find((t) => t.identifier === ids[0]);
  const b = [...list].find((t) => t.identifier === ids[1]);
  return a && b ? [a, b] : null;
}

function pairGeom([a, b]) {
  const sr = el.scroller.getBoundingClientRect();
  return {
    d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
    x: (a.clientX + b.clientX) / 2 - sr.left,
    y: (a.clientY + b.clientY) / 2 - sr.top,
  };
}

function startGesture(fingers) {
  if (S.active && S.active.type === 'touch') abortStroke();
  const pair = fingers.slice(0, 2);
  const g0 = pairGeom(pair);
  S.gesture = {
    ids: pair.map((t) => t.identifier), d0: g0.d, x0: g0.x, y0: g0.y, x: g0.x, y: g0.y, r: 1,
    sl: el.scroller.scrollLeft, st: el.scroller.scrollTop, z0: S.zoom, anchor: anchorAt(g0.x, g0.y),
  };
  el.pages.style.transformOrigin = `${S.gesture.sl + g0.x}px ${S.gesture.st + g0.y}px`;
}

function moveGesture(e) {
  const g = S.gesture;
  const pair = touchPair(e.touches, g.ids);
  if (!pair) return;
  const m = pairGeom(pair);
  g.r = clamp(g.z0 * (m.d / g.d0), MIN_Z, MAX_Z) / g.z0;
  g.x = m.x;
  g.y = m.y;
  el.pages.style.transform = `translate(${g.x - g.x0}px, ${g.y - g.y0}px) scale(${g.r})`;
}

function cancelGesture() {
  S.gesture = null;
  el.pages.style.transform = '';
}

function endGesture() {
  const g = S.gesture;
  cancelGesture();
  if (Math.abs(g.r - 1) > 0.01) S.fit = false;
  applyZoom(g.z0 * g.r, g.anchor, g.x, g.y);
}

/* ================= undo / redo and page operations ================= */

function viewOf(page) {
  return S.views.find((v) => v.page === page);
}

function showPage(page) {
  const v = viewOf(page);
  if (!v) return;
  if (v.visible) paintInk(v);
  else scrollToPage(S.views.indexOf(v));
}

function removeStroke(page, s) {
  const i = page.strokes.indexOf(s);
  if (i >= 0) page.strokes.splice(i, 1);
}

function applyOp(op) {
  const pages = S.doc.pages;
  switch (op.type) {
    case 'add':
      op.page.strokes.push(op.stroke);
      showPage(op.page);
      break;
    case 'erase':
      for (const it of op.items) removeStroke(op.page, it.stroke);
      showPage(op.page);
      break;
    case 'addPage':
      pages.splice(op.index, 0, op.page);
      buildPages();
      scrollToPage(op.index);
      break;
    case 'delPage':
      pages.splice(op.index, 1);
      buildPages();
      scrollToPage(Math.min(op.index, pages.length - 1));
      break;
  }
}

function revertOp(op) {
  const pages = S.doc.pages;
  switch (op.type) {
    case 'add':
      removeStroke(op.page, op.stroke);
      showPage(op.page);
      break;
    case 'erase':
      for (let i = op.items.length - 1; i >= 0; i--) op.page.strokes.splice(op.items[i].idx, 0, op.items[i].stroke);
      showPage(op.page);
      break;
    case 'addPage':
      pages.splice(op.index, 1);
      buildPages();
      scrollToPage(Math.max(0, op.index - 1));
      break;
    case 'delPage':
      pages.splice(op.index, 0, op.page);
      buildPages();
      scrollToPage(op.index);
      break;
  }
}

function pushOp(op) {
  S.undo.push(op);
  if (S.undo.length > 500) S.undo.shift();
  S.redo = [];
  markDirty();
  updateUndoButtons();
}

function undo() {
  if (S.active) return;
  const op = S.undo.pop();
  if (!op) return;
  revertOp(op);
  S.redo.push(op);
  markDirty();
  updateUndoButtons();
}

function redo() {
  if (S.active) return;
  const op = S.redo.pop();
  if (!op) return;
  applyOp(op);
  S.undo.push(op);
  markDirty();
  updateUndoButtons();
}

function updateUndoButtons() {
  el.undo.disabled = !S.undo.length;
  el.redo.disabled = !S.redo.length;
}

function addBlankPage() {
  const ref = S.doc.pages[S.current];
  const index = S.current + 1;
  const page = { id: uid(), kind: 'blank', w: ref ? ref.w : A4[0], h: ref ? ref.h : A4[1], strokes: [] };
  const op = { type: 'addPage', index, page };
  applyOp(op);
  pushOp(op);
  toast(`${index + 1}쪽에 빈 페이지를 추가했습니다`);
}

function deleteCurrentPage() {
  if (S.doc.pages.length <= 1) {
    toast('마지막 남은 페이지는 지울 수 없습니다');
    return;
  }
  if (!confirm(`${S.current + 1}쪽을 삭제할까요? 실행 취소로 되돌릴 수 있습니다.`)) return;
  const op = { type: 'delPage', index: S.current, page: S.doc.pages[S.current] };
  applyOp(op);
  pushOp(op);
}

function renameCurrent() {
  const name = prompt('문서 이름', S.doc.name)?.trim();
  if (!name) return;
  S.doc.name = name;
  el.title.textContent = name;
  markDirty();
}

el.undo.onclick = undo;
el.redo.onclick = redo;
$('#btn-addpage').onclick = addBlankPage;
el.title.onclick = renameCurrent;

/* ================= toolbar ================= */

function refreshToolbar() {
  for (const b of document.querySelectorAll('.tool')) b.classList.toggle('active', b.dataset.tool === S.tool);
  const colors = S.tool === 'pen' ? PEN_COLORS : S.tool === 'hl' ? HL_COLORS : [];
  el.swatches.replaceChildren(...colors.map((c) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (S.color[S.tool] === c ? ' active' : '');
    b.setAttribute('aria-label', `색 ${c}`);
    b.innerHTML = `<i style="background:${c}"></i>`;
    b.onclick = () => {
      S.color[S.tool] = c;
      savePrefs();
      refreshToolbar();
    };
    return b;
  }));
  el.swatches.hidden = !colors.length;
  el.swatches.previousElementSibling.hidden = !colors.length;
  el.sizes.replaceChildren(...SIZE_DOTS.map((d, i) => {
    const b = document.createElement('button');
    b.className = 'size' + (S.size[S.tool] === i ? ' active' : '');
    b.setAttribute('aria-label', `굵기 ${i + 1}`);
    b.innerHTML = `<i style="width:${d}px;height:${d}px"></i>`;
    b.onclick = () => {
      S.size[S.tool] = i;
      savePrefs();
      refreshToolbar();
    };
    return b;
  }));
}

for (const b of document.querySelectorAll('.tool')) {
  b.onclick = () => {
    S.tool = b.dataset.tool;
    savePrefs();
    refreshToolbar();
  };
}

document.addEventListener('keydown', (e) => {
  if (el.editor.hidden || e.target.closest?.('input, textarea')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
  } else if (!mod && ['p', 'h', 'e'].includes(e.key)) {
    S.tool = { p: 'pen', h: 'hl', e: 'eraser' }[e.key];
    savePrefs();
    refreshToolbar();
  }
});

/* ================= menu ================= */

function openMenu() {
  const r = el.more.getBoundingClientRect();
  el.menu.hidden = false;
  el.menu.style.top = `${r.bottom + 6}px`;
  el.menu.style.left = `${Math.max(8, r.right - el.menu.offsetWidth)}px`;
  const t = el.menu.querySelector('[data-act=finger]');
  t.classList.toggle('on', S.finger);
  t.querySelector('.state').textContent = S.finger ? '켬' : '끔';
}

function closeMenu() {
  el.menu.hidden = true;
}

el.more.onclick = (e) => {
  e.stopPropagation();
  if (el.menu.hidden) openMenu();
  else closeMenu();
};

document.addEventListener('pointerdown', (e) => {
  if (!el.menu.hidden && !el.menu.contains(e.target) && !el.more.contains(e.target)) closeMenu();
});

el.menu.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'zoom-in' || act === 'zoom-out') {
    zoomStep(act === 'zoom-in' ? 1.25 : 0.8);
    return; // keep the menu open for repeated steps
  }
  closeMenu();
  if (act === 'fit') setFit();
  else if (act === 'finger') {
    S.finger = !S.finger;
    savePrefs();
    toast(S.finger ? '손가락으로도 필기합니다. 두 손가락으로 이동·확대하세요.' : 'Pencil로만 필기합니다. 손가락은 스크롤에 쓰입니다.', 2600);
  } else if (act === 'add-page') addBlankPage();
  else if (act === 'delete-page') deleteCurrentPage();
  else if (act === 'rename') renameCurrent();
});

/* ================= export ================= */

function safeName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || '노트';
}

async function doExport() {
  if (!S.doc || S.active) return;
  toast('PDF 만드는 중…', 60000);
  try {
    await flushSave();
    const { exportDocument } = await import('./exporter.js');
    const bytes = await exportDocument(S.doc, S.pdfBytes, S.pdf);
    const name = `${safeName(S.doc.name)}.pdf`;
    S.exported = new File([bytes], name, { type: 'application/pdf' });
    hideToast();
    el.exportInfo.textContent = `${name} · ${S.doc.pages.length}쪽 · ${fmtSize(bytes.length)}`;
    el.share.hidden = !(navigator.canShare && navigator.canShare({ files: [S.exported] }));
    el.exportDialog.showModal();
  } catch (e) {
    console.error(e);
    toast('PDF를 만들지 못했습니다', 3000);
  }
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

$('#btn-export').onclick = doExport;

// Share runs directly in the click handler: Safari requires a fresh user gesture for it.
el.share.onclick = async (e) => {
  e.preventDefault();
  const f = S.exported;
  el.exportDialog.close();
  try {
    await navigator.share({ files: [f], title: f.name });
  } catch (err) {
    if (err.name !== 'AbortError') toast('공유하지 못했습니다', 2500);
  }
};
el.exportDialog.querySelector('[value=download]').onclick = (e) => {
  e.preventDefault();
  el.exportDialog.close();
  download(S.exported);
};

/* ================= start ================= */

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker', e));
}
navigator.storage?.persist?.();

refreshToolbar();
showLibrary();

// Test hooks.
window.__app = { S, openDoc, createDocFromPdf, showLibrary, exportCurrent: async () => {
  const { exportDocument } = await import('./exporter.js');
  return exportDocument(S.doc, S.pdfBytes, S.pdf);
} };
