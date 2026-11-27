// Stroke geometry and rendering, shared by the canvas view and the PDF exporter.
//
// A stroke is { t: 'pen' | 'hl', c: '#rrggbb', w: number, p: [x, y, pressure, ...] }
// with coordinates in page units (PDF points of the displayed, rotated page).
// The path runs through the midpoints of consecutive samples with the samples
// as quadratic control points, which smooths the jitter of raw input.

export const HL_ALPHA = 0.35;

export function count(s) {
  return s.p.length / 3;
}

export function widthAt(s, i) {
  if (s.t === 'hl') return s.w;
  return s.w * (0.6 + 0.8 * s.p[3 * i + 2]);
}

function pt(p, i) {
  return [p[3 * i], p[3 * i + 1]];
}

function mid(p, i, j) {
  return [(p[3 * i] + p[3 * j]) / 2, (p[3 * i + 1] + p[3 * j + 1]) / 2];
}

// Piece k of a stroke with n >= 2 samples: a line from P0 to the first midpoint (k = 0),
// a quadratic through P_k (0 < k < n - 1), or a line from the last midpoint to P_{n-1}.
export function piece(p, n, k) {
  if (k === 0) return { a: pt(p, 0), b: mid(p, 0, 1), i: 0 };
  if (k === n - 1) return { a: mid(p, n - 2, n - 1), b: pt(p, n - 1), i: n - 1 };
  return { a: mid(p, k - 1, k), c: pt(p, k), b: mid(p, k, k + 1), i: k };
}

function strokePiece(ctx, pc, w) {
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(pc.a[0], pc.a[1]);
  if (pc.c) ctx.quadraticCurveTo(pc.c[0], pc.c[1], pc.b[0], pc.b[1]);
  else ctx.lineTo(pc.b[0], pc.b[1]);
  ctx.stroke();
}

function dot(ctx, s) {
  ctx.beginPath();
  ctx.arc(s.p[0], s.p[1], widthAt(s, 0) / 2, 0, Math.PI * 2);
  ctx.fill();
}

function setup(ctx, s) {
  ctx.strokeStyle = s.c;
  ctx.fillStyle = s.c;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

// Full rendering of a finished stroke.
export function drawStroke(ctx, s) {
  const n = count(s);
  setup(ctx, s);
  if (s.t === 'hl') {
    ctx.save();
    ctx.globalAlpha = HL_ALPHA;
    if (n === 1) {
      dot(ctx, s);
    } else {
      ctx.lineWidth = s.w;
      ctx.beginPath();
      ctx.moveTo(s.p[0], s.p[1]);
      for (let k = 0; k < n; k++) {
        const pc = piece(s.p, n, k);
        if (pc.c) ctx.quadraticCurveTo(pc.c[0], pc.c[1], pc.b[0], pc.b[1]);
        else ctx.lineTo(pc.b[0], pc.b[1]);
      }
      ctx.stroke();
    }
    ctx.restore();
    return;
  }
  if (n === 1) {
    dot(ctx, s);
    return;
  }
  for (let k = 0; k < n; k++) strokePiece(ctx, piece(s.p, n, k), widthAt(s, piece(s.p, n, k).i));
}

// Live rendering after the stroke grew to n samples: draws the piece that just became final
// and a provisional tail to the newest sample. Drawn opaque; the live layer supplies the
// highlighter transparency through CSS opacity, so overlapping pieces do not darken.
export function drawGrowth(ctx, s) {
  const n = count(s);
  setup(ctx, s);
  if (n === 1) {
    dot(ctx, s);
    return;
  }
  const fixed = piece(s.p, n, n - 2);
  strokePiece(ctx, fixed, widthAt(s, fixed.i));
  const tail = piece(s.p, n, n - 1);
  strokePiece(ctx, tail, widthAt(s, tail.i));
}

export function bbox(s) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < s.p.length; i += 3) {
    const x = s.p[i], y = s.p[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

// Whether the eraser disc (x, y, r) touches the stroke.
export function hits(s, x, y, r) {
  const reach = r + (s.t === 'hl' ? s.w : s.w * 1.5) / 2;
  const b = s.bb || (s.bb = bbox(s));
  if (x < b[0] - reach || x > b[2] + reach || y < b[1] - reach || y > b[3] + reach) return false;
  const p = s.p, n = count(s), r2 = reach * reach;
  if (n === 1) return (p[0] - x) ** 2 + (p[1] - y) ** 2 <= r2;
  for (let i = 0; i < n - 1; i++) {
    if (segDist2(x, y, p[3 * i], p[3 * i + 1], p[3 * i + 3], p[3 * i + 4]) <= r2) return true;
  }
  return false;
}
