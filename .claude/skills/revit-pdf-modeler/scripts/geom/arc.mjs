// Arc tessellation helpers for the get_cad_geometry JSON format.
// Arc items look like { k:"a", c:[cx,cy], r, a:[x,y], m:[x,y], b:[x,y] }:
// start point a, a point m on the arc (disambiguates direction), end point b.
// Older exports may carry only a, m, b (centre derived from the 3 points).

/** Circle through three points. Returns { c:[x,y], r } or null if collinear. */
export function circleFrom3(a, m, b) {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, m2 = m[0] ** 2 + m[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2;
  const cx = (a2 * (m[1] - b[1]) + m2 * (b[1] - a[1]) + b2 * (a[1] - m[1])) / d;
  const cy = (a2 * (b[0] - m[0]) + m2 * (a[0] - b[0]) + b2 * (m[0] - a[0])) / d;
  return { c: [cx, cy], r: Math.hypot(a[0] - cx, a[1] - cy) };
}

/**
 * Tessellate an arc from start a, mid m, end b (and optional centre c / radius r).
 * Chord length is kept <= maxChord (mm); at least 2 segments. Endpoints are exact.
 * Degenerate (collinear) arcs fall back to the straight chord [a, b].
 */
export function arcPoints({ a, m, b, c, r }, maxChord = 600) {
  let C = c, R = r;
  if (!C || !(R > 0)) {
    const circ = circleFrom3(a, m, b);
    if (!circ) return [a, b];
    C = circ.c; R = circ.r;
  }
  const ang = (p) => Math.atan2(p[1] - C[1], p[0] - C[0]);
  const norm = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const a0 = ang(a), am = ang(m), a1 = ang(b);
  const ccw = norm(am - a0) < norm(a1 - a0);
  let sweep = ccw ? norm(a1 - a0) : -norm(a0 - a1);
  if (Math.abs(sweep) < 1e-12) sweep = ccw ? 2 * Math.PI : -2 * Math.PI; // full circle
  const n = Math.max(2, Math.ceil((Math.abs(sweep) * R) / maxChord));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + (sweep * i) / n;
    pts.push([C[0] + R * Math.cos(t), C[1] + R * Math.sin(t)]);
  }
  pts[0] = [a[0], a[1]];
  pts[n] = [b[0], b[1]];
  return pts;
}

/** Cubic Bezier flattening (used for PDF curves). Returns n+1 points. */
export function bezierPoints(p0, p1, p2, p3, n = 8) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}
