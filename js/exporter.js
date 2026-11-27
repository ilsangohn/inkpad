// Builds an annotated PDF: original pages are copied untouched and the strokes are added
// as vector paths on top, so text stays selectable and ink stays sharp at any zoom.
import {
  PDFDocument, LineCapStyle, LineJoinStyle,
  pushGraphicsState, popGraphicsState, setGraphicsState, setLineWidth, setLineCap, setLineJoin,
  setStrokingRgbColor, setFillingRgbColor, moveTo, lineTo, appendBezierCurve, stroke, fill, closePath,
} from '../vendor/pdf-lib.esm.min.js';
import { HL_ALPHA, count, piece, widthAt } from './ink.js';

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

// Appends one piece of the path; quadratics become cubics.
function appendPiece(ops, pc, map, first) {
  const a = map(pc.a[0], pc.a[1]);
  const b = map(pc.b[0], pc.b[1]);
  if (first) ops.push(moveTo(a[0], a[1]));
  if (pc.c) {
    const c = map(pc.c[0], pc.c[1]);
    ops.push(appendBezierCurve(
      a[0] + (2 / 3) * (c[0] - a[0]), a[1] + (2 / 3) * (c[1] - a[1]),
      b[0] + (2 / 3) * (c[0] - b[0]), b[1] + (2 / 3) * (c[1] - b[1]),
      b[0], b[1],
    ));
  } else {
    ops.push(lineTo(b[0], b[1]));
  }
}

// Filled circle approximated by four cubics.
function circleOps(ops, cx, cy, r) {
  const k = 0.5523 * r;
  ops.push(
    moveTo(cx + r, cy),
    appendBezierCurve(cx + r, cy + k, cx + k, cy + r, cx, cy + r),
    appendBezierCurve(cx - k, cy + r, cx - r, cy + k, cx - r, cy),
    appendBezierCurve(cx - r, cy - k, cx - k, cy - r, cx, cy - r),
    appendBezierCurve(cx + k, cy - r, cx + r, cy - k, cx + r, cy),
    closePath(),
    fill(),
  );
}

function strokeOps(ops, s, map, hlState) {
  const n = count(s);
  const [r, g, b] = hexToRgb(s.c);
  ops.push(pushGraphicsState());
  if (s.t === 'hl') ops.push(setGraphicsState(hlState));
  ops.push(setStrokingRgbColor(r, g, b), setFillingRgbColor(r, g, b));
  if (n === 1) {
    const c = map(s.p[0], s.p[1]);
    circleOps(ops, c[0], c[1], widthAt(s, 0) / 2);
  } else if (s.t === 'hl') {
    ops.push(setLineWidth(s.w));
    for (let k = 0; k < n; k++) appendPiece(ops, piece(s.p, n, k), map, k === 0);
    ops.push(stroke());
  } else {
    for (let k = 0; k < n; k++) {
      const pc = piece(s.p, n, k);
      ops.push(setLineWidth(widthAt(s, pc.i)));
      appendPiece(ops, pc, map, true);
      ops.push(stroke());
    }
  }
  ops.push(popGraphicsState());
}

// Wraps the page's existing content in q ... Q, so a transform it leaves behind
// does not displace the ink appended after it.
function isolateOriginal(page, out) {
  page.node.normalize();
  const start = out.context.register(page.createContentStream(pushGraphicsState()));
  const end = out.context.register(page.createContentStream(popGraphicsState()));
  page.node.wrapContentStreams(start, end);
}

/**
 * @param doc    app document ({ name, pages })
 * @param srcBytes original PDF bytes, or null for a notebook without a PDF
 * @param pdfjsDoc the pdf.js document of srcBytes, used to map page units to PDF user space
 */
export async function exportDocument(doc, srcBytes, pdfjsDoc) {
  const out = await PDFDocument.create();
  const src = srcBytes ? await PDFDocument.load(srcBytes, { ignoreEncryption: true }) : null;
  const pdfPages = doc.pages.filter((p) => p.kind === 'pdf');
  const copied = src && pdfPages.length ? await out.copyPages(src, pdfPages.map((p) => p.src)) : [];
  const hlRef = out.context.register(out.context.obj({ Type: 'ExtGState', CA: HL_ALPHA, ca: HL_ALPHA }));

  let ci = 0;
  for (const p of doc.pages) {
    let page, map;
    if (p.kind === 'pdf') {
      page = out.addPage(copied[ci++]);
      const vp = (await pdfjsDoc.getPage(p.src + 1)).getViewport({ scale: 1 });
      map = (x, y) => vp.convertToPdfPoint(x, y);
    } else {
      page = out.addPage([p.w, p.h]);
      map = (x, y) => [x, p.h - y];
    }
    if (!p.strokes.length) continue;
    if (p.kind === 'pdf') isolateOriginal(page, out);
    const hlState = page.node.newExtGState('GSHL', hlRef);
    const ops = [pushGraphicsState(), setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round)];
    for (const s of p.strokes) strokeOps(ops, s, map, hlState);
    ops.push(popGraphicsState());
    // Chunked: a single spread of a long operator list can exceed the engine's argument limit.
    for (let i = 0; i < ops.length; i += 5000) page.pushOperators(...ops.slice(i, i + 5000));
  }

  out.setTitle(doc.name);
  out.setProducer('강의 노트');
  out.setCreator('강의 노트');
  return out.save();
}

