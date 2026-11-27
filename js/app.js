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

// Version shown in the app: bump the minor number for fixes, the major for features.
const APP_VERSION = '6.1';
const PEN_COLORS = [
  '#1d1d1f', '#2557d6', '#1e9bd7', '#0f9d8f', '#d62828', '#e64980', '#f08c00', '#7b3fe4', '#8b5a2b',
];
const HL_COLORS = ['#ffd60a', '#7ae582', '#ff8fab', '#7cc6ff', '#ffb347', '#c9a7ff'];
// Pen and highlighter widths are in page units (pt); eraser radii are in screen px.
const SIZES = { pen: [1.1, 2, 3.4], hl: [9, 15, 24], eraser: [8, 16, 32] };
const SIZE_DOTS = [5, 9, 14];
const A4 = [595.28, 841.89];
const MAX_CANVAS_PX = 8e6; // iOS Safari limits canvas area and total canvas memory
const MIN_Z = 0.3;
const MAX_Z = 6;
const PALM_WINDOW_MS = 600;

const $ = (s) => document.querySelector(s);
const el = {
  library: $('#library'), editor: $('#editor'), docList: $('#doc-list'), libEmpty: $('#lib-empty'),
  fileInput: $('#file-input'), stage: $('#stage'), scroller: $('#scroller'), pages: $('#pages'),
  live: $('#live'), indicator: $('#page-indicator'), title: $('#doc-title'), saveState: $('#save-state'),
  swatches: $('#swatches'), sizes: $('#sizes'), undo: $('#btn-undo'), redo: $('#btn-redo'),
  menu: $('#menu'), more: $('#btn-more'), exportDialog: $('#export-dialog'), exportInfo: $('#export-info'),
  share: $('#btn-share'), toast: $('#toast'),
  scrub: $('#scrub'), thumb: $('#scrub-thumb'),
};
const liveCtx = el.live.getContext('2d');

const prefs = JSON.parse(localStorage.getItem('prefs') || '{}');
const S = {
  doc: null, pdf: null, pdfBytes: null,
  zoom: 1, fit: true,
  tool: prefs.tool || 'pen',
  color: {
    pen: PEN_COLORS.includes(prefs.penColor) ? prefs.penColor : PEN_COLORS[0],
    hl: HL_COLORS.includes(prefs.hlColor) ? prefs.hlColor : HL_COLORS[0],
  },
  size: { pen: prefs.penSize ?? 1, hl: prefs.hlSize ?? 1, eraser: prefs.eraserSize ?? 1 },
  finger: !!prefs.finger,
  undo: [], redo: [],
  views: [], current: 0,
  active: null, gesture: null, lastPen: 0, sel: null, clipboard: null,
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
  S.sel = null;
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
  S.sel = null;
  pasteBubble = null;
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
  updateScrub();
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
  if (v.page.strokes.length || v.page.images?.length || v.inkReady) paintInk(v);
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
  const lifted = S.sel && S.sel.v === v ? S.sel.set : null;
  if (v.page.images?.length) drawImages(ctx, v.page.images, lifted);
  for (const s of v.page.strokes) if (!lifted?.has(s)) drawStroke(ctx, s);
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
  if (S.sel?.v === v) {
    S.sel.el.remove();
    S.sel = null;
  }
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
  if (Math.abs(clamp(z, MIN_Z, MAX_Z) - S.zoom) > 1e-6) {
    dropSelection();
    removePasteBubble();
  }
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
  if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; trackCurrent(); updateScrub(); });
}, { passive: true });

// Always-visible scroll bar on the right edge (iOS hides native scroll bars); drag it or tap the track.
function updateScrub() {
  const sc = el.scroller;
  const max = sc.scrollHeight - sc.clientHeight;
  el.scrub.hidden = !S.doc || max <= 1;
  if (el.scrub.hidden) return;
  const track = el.scrub.clientHeight;
  const h = Math.max(48, (track * sc.clientHeight) / sc.scrollHeight);
  el.thumb.style.height = `${h}px`;
  el.thumb.style.transform = `translateY(${((track - h) * sc.scrollTop) / max}px)`;
}

let scrubDrag = null;
el.scrub.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const sc = el.scroller;
  const track = el.scrub.clientHeight;
  const h = el.thumb.offsetHeight;
  const max = sc.scrollHeight - sc.clientHeight;
  const tr = el.thumb.getBoundingClientRect();
  if (e.clientY < tr.top || e.clientY > tr.bottom) {
    const top = el.scrub.getBoundingClientRect().top;
    sc.scrollTop = clamp((e.clientY - top - h / 2) / (track - h), 0, 1) * max;
  }
  scrubDrag = { id: e.pointerId, y0: e.clientY, s0: sc.scrollTop, k: max / Math.max(1, track - h) };
  try {
    el.scrub.setPointerCapture(e.pointerId);
  } catch {
    // dragging still works while the finger stays on the bar
  }
  el.scrub.classList.add('active');
});
el.scrub.addEventListener('pointermove', (e) => {
  if (!scrubDrag || e.pointerId !== scrubDrag.id) return;
  el.scroller.scrollTop = scrubDrag.s0 + (e.clientY - scrubDrag.y0) * scrubDrag.k;
});
for (const type of ['pointerup', 'pointercancel']) {
  el.scrub.addEventListener(type, (e) => {
    if (!scrubDrag || e.pointerId !== scrubDrag.id) return;
    scrubDrag = null;
    el.scrub.classList.remove('active');
  });
}

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
  // A touch right after Pencil use is a resting palm, even in finger mode.
  return e.pointerType === 'touch' && S.finger && performance.now() - S.lastPen > PALM_WINDOW_MS;
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

function capture(id) {
  try {
    el.pages.setPointerCapture(id);
  } catch {
    // capture is an optimization; drawing works without it
  }
}

function onPointerDown(e) {
  if (e.pointerType === 'pen') S.lastPen = performance.now();
  if (S.active || e.target.closest('.sel-bar, .paste-bubble')) return;
  removePasteBubble();
  // A selection can be dragged with the Pencil or a finger.
  if (S.sel && e.target.closest('.sel') && !S.gesture
    && (e.pointerType !== 'touch' || performance.now() - S.lastPen > PALM_WINDOW_MS)) {
    startMove(e, !!e.target.closest('.sel-handle'));
    return;
  }
  if (!canDraw(e)) return;
  const pageEl = e.target.closest('.page');
  if (!pageEl) return;
  e.preventDefault();
  closeMenu();
  capture(e.pointerId);
  const a = { id: e.pointerId, type: e.pointerType, v: pageEl._view, tool: S.tool, pr: null };
  S.active = a;
  if (a.tool === 'lasso' || a.tool === 'clip') {
    a.path = [];
    lassoAdd(a, [e]);
    return;
  }
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
  // Hover (Pencil near the screen without touching) does not count as writing.
  if (e.pointerType === 'pen' && e.buttons) S.lastPen = performance.now();
  const a = S.active;
  if (!a || e.pointerId !== a.id) return;
  e.preventDefault();
  if (a.tool === 'move' || a.tool === 'scale') {
    moveSelection(a, e);
    return;
  }
  const evs = coalesced(e);
  if (a.tool === 'eraser') for (const ev of evs) eraseAt(a, ev);
  else if (a.tool === 'lasso' || a.tool === 'clip') lassoAdd(a, evs);
  else addPoints(a, evs);
}

function finishStroke() {
  const a = S.active;
  if (!a) return;
  S.active = null;
  clearLive();
  el.live.classList.remove('hl');
  if (a.tool === 'move' || a.tool === 'scale') {
    finishMove(a);
    return;
  }
  if (a.tool === 'lasso') {
    finishLasso(a);
    return;
  }
  if (a.tool === 'clip') {
    finishCapture(a);
    return;
  }
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
  if (a.tool === 'eraser' || a.tool === 'move' || a.tool === 'scale') {
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

/* ================= selection, capture, copy and paste ================= */

// Page content is ink strokes (page.strokes) and pasted image clippings (page.images:
// { id, x, y, w, h, data: PNG ArrayBuffer }), all in page units. A selection lifts its items
// off the ink layer into a box of its own, so dragging moves one small element; the items
// stay in the page arrays throughout (saving and export see them unchanged) and are
// transformed only when a drag ends.

const imagesOf = (page) => page.images || (page.images = []);

// Decoded images, by id; decoding is asynchronous, so pages repaint when one is ready.
const bitmaps = new Map();
function bitmapFor(img) {
  let entry = bitmaps.get(img.id);
  if (!entry) {
    entry = { bmp: null };
    bitmaps.set(img.id, entry);
    createImageBitmap(new Blob([img.data], { type: 'image/png' }))
      .then((bmp) => {
        entry.bmp = bmp;
        for (const v of S.views) if (v.visible && v.page.images?.includes(img)) paintInk(v);
        if (S.sel?.images.includes(img)) select(S.sel.v, S.sel.strokes, S.sel.images);
      })
      .catch((e) => console.error(e));
  }
  return entry.bmp;
}

function drawImages(ctx, images, skip) {
  for (const img of images) {
    if (skip?.has(img)) continue;
    const bmp = bitmapFor(img);
    if (bmp) ctx.drawImage(bmp, img.x, img.y, img.w, img.h);
  }
}

// Buttons placed on a page react to pointer events, not click: Pencil touches there are
// canceled (so the Pencil never scrolls), and Safari then sends no click for them.
function onTap(node, fn) {
  let down = null;
  node.addEventListener('pointerdown', (e) => {
    down = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  node.addEventListener('pointerup', (e) => {
    if (!down || e.pointerId !== down.id) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved < 12) fn(e);
  });
}

function pagePoint(v, ev) {
  const pr = v.el.getBoundingClientRect();
  return [(ev.clientX - pr.left) / S.zoom, (ev.clientY - pr.top) / S.zoom];
}

function lassoAdd(a, events) {
  for (const ev of events) a.path.push(pagePoint(a.v, ev));
  clearLive();
  liveTransform(a.v);
  liveCtx.lineWidth = 1.5 / S.zoom;
  liveCtx.setLineDash([6 / S.zoom, 4 / S.zoom]);
  liveCtx.strokeStyle = '#2557d6';
  liveCtx.fillStyle = 'rgba(37, 87, 214, 0.08)';
  liveCtx.beginPath();
  if (a.tool === 'clip') {
    const [x0, y0] = a.path[0];
    const [x1, y1] = a.path[a.path.length - 1];
    liveCtx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  } else {
    a.path.forEach(([x, y], i) => (i ? liveCtx.lineTo(x, y) : liveCtx.moveTo(x, y)));
    if (a.path.length > 2) liveCtx.closePath();
  }
  liveCtx.fill();
  liveCtx.stroke();
  liveCtx.setLineDash([]);
}

function insidePolygon(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pathBox(path) {
  const xs = path.map((p) => p[0]);
  const ys = path.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// A tap with the lasso or capture tool clears the selection, or offers to paste there.
function isTap(lb) {
  return (lb[2] - lb[0]) * S.zoom < 10 && (lb[3] - lb[1]) * S.zoom < 10;
}

function tapAt(a) {
  dropSelection();
  if (S.clipboard) showPasteBubble(a.v, a.path[0][0], a.path[0][1]);
}

function finishLasso(a) {
  const lb = pathBox(a.path);
  if (isTap(lb)) {
    tapAt(a);
    return;
  }
  // A stroke is selected when its center or a third of its samples lie inside the loop.
  const strokes = a.v.page.strokes.filter((s) => {
    const b = s.bb || (s.bb = bbox(s));
    if (b[2] < lb[0] || b[0] > lb[2] || b[3] < lb[1] || b[1] > lb[3]) return false;
    if (insidePolygon(a.path, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2)) return true;
    let n = 0;
    let inside = 0;
    for (let i = 0; i < s.p.length; i += 3) {
      n++;
      if (insidePolygon(a.path, s.p[i], s.p[i + 1])) inside++;
    }
    return inside * 3 >= n;
  });
  const images = imagesOf(a.v.page).filter((m) => insidePolygon(a.path, m.x + m.w / 2, m.y + m.h / 2));
  if (strokes.length || images.length) {
    select(a.v, strokes, images);
  } else {
    dropSelection();
    toast('올가미 안에 필기가 없습니다. 인쇄된 내용은 캡처 도구로 복사하세요.', 3000);
  }
}

// Renders a rectangle of the page (PDF, images and ink) to a PNG and puts it on the clipboard.
async function finishCapture(a) {
  const lb = pathBox([a.path[0], a.path[a.path.length - 1]]);
  if (isTap(lb)) {
    tapAt(a);
    return;
  }
  const v = a.v;
  const x0 = clamp(lb[0], 0, v.page.w);
  const y0 = clamp(lb[1], 0, v.page.h);
  const w = clamp(lb[2], 0, v.page.w) - x0;
  const h = clamp(lb[3], 0, v.page.h) - y0;
  if (w < 2 || h < 2) return;
  const k = Math.min(4, Math.sqrt(4e6 / (w * h))); // about 290 dpi, at most 4 megapixels
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  try {
    if (v.page.kind === 'pdf') {
      const page = await S.pdf.getPage(v.page.src + 1);
      const vp = page.getViewport({ scale: k, offsetX: -x0 * k, offsetY: -y0 * k });
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
    }
    ctx.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
    drawImages(ctx, imagesOf(v.page));
    for (const s of v.page.strokes) drawStroke(ctx, s);
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    const data = await blob.arrayBuffer();
    const id = uid();
    bitmaps.set(id, { bmp: await createImageBitmap(c) });
    S.clipboard = { strokes: [], images: [{ id, x: -w / 2, y: -h / 2, w, h, data }] };
    c.width = c.height = 0;
    flashRect(v, x0, y0, w, h);
    toast('캡처했습니다. 붙일 곳을 한 번 누르세요.', 2600);
  } catch (e) {
    console.error(e);
    toast('캡처하지 못했습니다', 2500);
  }
}

function flashRect(v, x, y, w, h) {
  const f = document.createElement('div');
  f.className = 'flash';
  f.style.left = `${x * S.zoom}px`;
  f.style.top = `${y * S.zoom}px`;
  f.style.width = `${w * S.zoom}px`;
  f.style.height = `${h * S.zoom}px`;
  v.el.append(f);
  setTimeout(() => f.remove(), 450);
}

function itemsBox(strokes, images) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    const b = s.bb || (s.bb = bbox(s));
    const r = (s.t === 'hl' ? s.w : s.w * 1.4) / 2;
    x0 = Math.min(x0, b[0] - r);
    y0 = Math.min(y0, b[1] - r);
    x1 = Math.max(x1, b[2] + r);
    y1 = Math.max(y1, b[3] + r);
  }
  for (const m of images) {
    x0 = Math.min(x0, m.x);
    y0 = Math.min(y0, m.y);
    x1 = Math.max(x1, m.x + m.w);
    y1 = Math.max(y1, m.y + m.h);
  }
  return [x0, y0, x1, y1];
}

function select(v, strokes, images = []) {
  dropSelection();
  const sel = { v, strokes, images, set: new Set([...strokes, ...images]) };
  const b = itemsBox(strokes, images);
  const pad = 6;
  sel.box = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
  S.sel = sel;
  paintInk(v);
  if (!v.scale) computeScale(v);
  const [x0, y0, x1, y1] = sel.box;
  const z = S.zoom;
  const box = document.createElement('div');
  box.className = 'sel';
  box.style.left = `${x0 * z}px`;
  box.style.top = `${y0 * z}px`;
  box.style.width = `${(x1 - x0) * z}px`;
  box.style.height = `${(y1 - y0) * z}px`;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round((x1 - x0) * v.scale));
  c.height = Math.max(1, Math.round((y1 - y0) * v.scale));
  const ctx = c.getContext('2d');
  ctx.setTransform(v.scale, 0, 0, v.scale, -x0 * v.scale, -y0 * v.scale);
  drawImages(ctx, images);
  for (const s of strokes) drawStroke(ctx, s);
  const bar = document.createElement('div');
  bar.className = 'sel-bar' + (y0 * z < 60 ? ' below' : '');
  bar.innerHTML = '<button data-a="copy">복사</button><button data-a="cut">잘라내기</button><button data-a="delete">삭제</button>';
  onTap(bar, (e) => {
    const act = e.target.closest('[data-a]')?.dataset.a;
    if (act === 'copy') copySelection();
    else if (act === 'cut') cutSelection();
    else if (act === 'delete') deleteSelection();
  });
  const handle = document.createElement('div');
  handle.className = 'sel-handle';
  box.append(c, bar, handle);
  v.el.append(box);
  sel.el = box;
}

// Puts the lifted items back on the ink layer.
function dropSelection() {
  const sel = S.sel;
  if (!sel) return;
  S.sel = null;
  sel.el?.remove();
  if (sel.v.visible) paintInk(sel.v);
}

function startMove(e, scaling) {
  e.preventDefault();
  capture(e.pointerId);
  const r = S.sel.el.getBoundingClientRect();
  S.active = {
    id: e.pointerId, type: e.pointerType, tool: scaling ? 'scale' : 'move', v: S.sel.v,
    x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, left: r.left, top: r.top, w: r.width, h: r.height, k: 1,
  };
  if (scaling) S.sel.el.classList.add('scaling');
}

function moveSelection(a, e) {
  a.x = e.clientX;
  a.y = e.clientY;
  if (a.tool === 'move') {
    S.sel.el.style.transform = `translate(${a.x - a.x0}px, ${a.y - a.y0}px)`;
    return;
  }
  // Uniform scale about the box's top-left corner, following the handle along the diagonal.
  const px = a.x - a.left;
  const py = a.y - a.top;
  a.k = clamp((px * a.w + py * a.h) / (a.w * a.w + a.h * a.h), 0.1, 10);
  S.sel.el.style.transformOrigin = '0 0';
  S.sel.el.style.transform = `scale(${a.k})`;
}

function transformItems(strokes, images, f) {
  for (const s of strokes) {
    for (let i = 0; i < s.p.length; i += 3) {
      const [x, y] = f.point(s.p[i], s.p[i + 1]);
      s.p[i] = x;
      s.p[i + 1] = y;
    }
    s.w *= f.k;
    s.bb = bbox(s);
  }
  for (const m of images) {
    [m.x, m.y] = f.point(m.x, m.y);
    m.w *= f.k;
    m.h *= f.k;
  }
}

const shiftBy = (dx, dy) => ({ k: 1, point: (x, y) => [x + dx, y + dy] });
const scaleAbout = (k, ox, oy) => ({ k, point: (x, y) => [ox + (x - ox) * k, oy + (y - oy) * k] });

function finishMove(a) {
  const sel = S.sel;
  if (!sel) return;
  sel.el.style.transform = '';
  sel.el.classList.remove('scaling');
  if (a.tool === 'move') {
    const dx = (a.x - a.x0) / S.zoom;
    const dy = (a.y - a.y0) / S.zoom;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;
    transformItems(sel.strokes, sel.images, shiftBy(dx, dy));
    pushOp({ type: 'move', page: sel.v.page, strokes: sel.strokes, images: sel.images, dx, dy });
  } else {
    if (Math.abs(a.k - 1) < 0.005) return;
    const [ox, oy] = sel.box;
    transformItems(sel.strokes, sel.images, scaleAbout(a.k, ox, oy));
    pushOp({ type: 'scale', page: sel.v.page, strokes: sel.strokes, images: sel.images, k: a.k, ox, oy });
  }
  select(sel.v, sel.strokes, sel.images);
}

// The clipboard holds copies positioned relative to the selection's center.
function copySelection() {
  const sel = S.sel;
  if (!sel) return;
  const [x0, y0, x1, y1] = sel.box;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  S.clipboard = {
    strokes: sel.strokes.map((s) => {
      const p = Float32Array.from(s.p);
      for (let i = 0; i < p.length; i += 3) {
        p[i] -= cx;
        p[i + 1] -= cy;
      }
      return { t: s.t, c: s.c, w: s.w, p };
    }),
    images: sel.images.map((m) => ({ id: m.id, x: m.x - cx, y: m.y - cy, w: m.w, h: m.h, data: m.data })),
  };
  toast('복사했습니다. 붙일 곳을 올가미로 한 번 누르세요.', 2600);
}

function removeSelected() {
  const sel = S.sel;
  const page = sel.v.page;
  const take = (arr, items) => {
    const idx = items.map((x) => arr.indexOf(x)).filter((i) => i >= 0).sort((p, q) => q - p);
    const out = idx.map((i) => ({ item: arr[i], idx: i }));
    for (const i of idx) arr.splice(i, 1);
    return out;
  };
  const strokes = take(page.strokes, sel.strokes);
  const images = take(imagesOf(page), sel.images);
  S.sel = null;
  sel.el.remove();
  paintInk(sel.v);
  pushOp({ type: 'removeItems', page, strokes, images });
}

function cutSelection() {
  if (!S.sel) return;
  copySelection();
  removeSelected();
  toast('잘라냈습니다. 붙일 곳을 올가미로 한 번 누르세요.', 2600);
}

function deleteSelection() {
  if (S.sel) removeSelected();
}

function pasteAt(v, cx, cy) {
  const clip = S.clipboard;
  if (!clip) return;
  dropSelection();
  const strokes = clip.strokes.map((s) => {
    const p = Float32Array.from(s.p);
    for (let i = 0; i < p.length; i += 3) {
      p[i] += cx;
      p[i + 1] += cy;
    }
    const t = { t: s.t, c: s.c, w: s.w, p };
    t.bb = bbox(t);
    return t;
  });
  // Each pasted image is its own object; the decoded bitmap is shared through the cache.
  const images = clip.images.map((m) => {
    const id = uid();
    const cached = bitmaps.get(m.id);
    if (cached) bitmaps.set(id, cached);
    return { id, x: m.x + cx, y: m.y + cy, w: m.w, h: m.h, data: m.data };
  });
  v.page.strokes.push(...strokes);
  imagesOf(v.page).push(...images);
  pushOp({ type: 'addMany', page: v.page, strokes, images });
  select(v, strokes, images);
}

// Pastes at the middle of the visible part of the current page.
function pasteVisible() {
  if (!S.clipboard) {
    toast('복사한 내용이 없습니다');
    return;
  }
  const v = S.views[S.current];
  const pr = v.el.getBoundingClientRect();
  const sr = el.scroller.getBoundingClientRect();
  const top = Math.max(pr.top, sr.top);
  const bottom = Math.min(pr.bottom, sr.bottom);
  pasteAt(v, v.page.w / 2, ((top + bottom) / 2 - pr.top) / S.zoom);
}

let pasteBubble = null;
function showPasteBubble(v, x, y) {
  removePasteBubble();
  const b = document.createElement('button');
  b.className = 'paste-bubble';
  b.textContent = '붙여넣기';
  b.style.left = `${x * S.zoom}px`;
  b.style.top = `${y * S.zoom}px`;
  onTap(b, () => {
    removePasteBubble();
    pasteAt(v, x, y);
  });
  v.el.append(b);
  pasteBubble = b;
}

function removePasteBubble() {
  pasteBubble?.remove();
  pasteBubble = null;
}

/* ================= touch: palm rejection, pinch zoom ================= */

// Pencil input draws through pointer events and must never scroll the page; Safari marks
// it as touchType 'stylus'. Finger touches scroll natively, except a palm resting while
// writing: a touch that starts while the Pencil is down or right after a stroke is ignored.
// (Contact radius is not used: iOS reports fingertips above 30px, which blocked scrolling.)
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
    if (!S.finger && (S.active?.type === 'pen' || now - S.lastPen < PALM_WINDOW_MS)) palmIds.add(t.identifier);
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
    // If one finger already started a native scroll the event is not cancelable; keep
    // tracking anyway: endGesture re-anchors from live positions, so the result is still right.
    if (e.cancelable) e.preventDefault();
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

function removeFrom(arr, x) {
  const i = arr.indexOf(x);
  if (i >= 0) arr.splice(i, 1);
}

function removeStroke(page, s) {
  removeFrom(page.strokes, s);
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
    case 'addMany':
      op.page.strokes.push(...op.strokes);
      imagesOf(op.page).push(...(op.images || []));
      showPage(op.page);
      break;
    case 'removeItems':
      for (const it of op.strokes) removeFrom(op.page.strokes, it.item);
      for (const it of op.images) removeFrom(imagesOf(op.page), it.item);
      showPage(op.page);
      break;
    case 'move':
      transformItems(op.strokes, op.images || [], shiftBy(op.dx, op.dy));
      showPage(op.page);
      break;
    case 'scale':
      transformItems(op.strokes, op.images, scaleAbout(op.k, op.ox, op.oy));
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
    case 'addMany':
      for (const s of op.strokes) removeFrom(op.page.strokes, s);
      for (const m of op.images || []) removeFrom(imagesOf(op.page), m);
      showPage(op.page);
      break;
    case 'removeItems':
      for (let i = op.strokes.length - 1; i >= 0; i--) op.page.strokes.splice(op.strokes[i].idx, 0, op.strokes[i].item);
      for (let i = op.images.length - 1; i >= 0; i--) imagesOf(op.page).splice(op.images[i].idx, 0, op.images[i].item);
      showPage(op.page);
      break;
    case 'move':
      transformItems(op.strokes, op.images || [], shiftBy(-op.dx, -op.dy));
      showPage(op.page);
      break;
    case 'scale':
      transformItems(op.strokes, op.images, scaleAbout(1 / op.k, op.ox, op.oy));
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
  dropSelection();
  const op = S.undo.pop();
  if (!op) return;
  revertOp(op);
  S.redo.push(op);
  markDirty();
  updateUndoButtons();
}

function redo() {
  if (S.active) return;
  dropSelection();
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
  const sized = S.tool !== 'lasso' && S.tool !== 'clip';
  el.sizes.hidden = !sized;
  el.sizes.previousElementSibling.hidden = !sized;
  el.sizes.replaceChildren(...(sized ? SIZE_DOTS : []).map((d, i) => {
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

function setTool(tool) {
  if (tool !== 'lasso' && tool !== 'clip') dropSelection();
  removePasteBubble();
  S.tool = tool;
  savePrefs();
  refreshToolbar();
}

for (const b of document.querySelectorAll('.tool')) b.onclick = () => setTool(b.dataset.tool);

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
  } else if (mod && e.key.toLowerCase() === 'c' && S.sel) {
    e.preventDefault();
    copySelection();
  } else if (mod && e.key.toLowerCase() === 'x' && S.sel) {
    e.preventDefault();
    cutSelection();
  } else if (mod && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    pasteVisible();
  } else if (!mod && (e.key === 'Backspace' || e.key === 'Delete') && S.sel) {
    e.preventDefault();
    deleteSelection();
  } else if (e.key === 'Escape') {
    dropSelection();
    removePasteBubble();
  } else if (!mod && ['p', 'h', 'e', 'l', 'c'].includes(e.key)) {
    setTool({ p: 'pen', h: 'hl', e: 'eraser', l: 'lasso', c: 'clip' }[e.key]);
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
  else if (act === 'paste') pasteVisible();
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
  // When an updated service worker takes over, reload once so the new code runs right away.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    flushSave().then(() => location.reload());
  });
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker', e));
}
for (const n of document.querySelectorAll('.app-version')) n.textContent = `inkpad 버전 ${APP_VERSION}`;
navigator.storage?.persist?.();

// Show unexpected errors on screen: there is no console on the iPad.
window.addEventListener('error', (e) => toast(`오류: ${e.message}`, 6000));
window.addEventListener('unhandledrejection', (e) => toast(`오류: ${e.reason?.message || e.reason}`, 6000));

refreshToolbar();
showLibrary();

// Test hooks.
window.__app = { S, openDoc, createDocFromPdf, showLibrary, exportCurrent: async () => {
  const { exportDocument } = await import('./exporter.js');
  return exportDocument(S.doc, S.pdfBytes, S.pdf);
} };
