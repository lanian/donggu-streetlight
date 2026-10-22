/* Field calculations. Device coordinates follow W3C Device Orientation (Z-X'-Y'').
   Keep these functions independent of UI, storage, and network so geometry can be tested. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DongguField = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";
  const RAD = Math.PI / 180;
  const clamp = n => Math.max(-1, Math.min(1, n));
  const norm = v => Math.hypot(...v);
  const angle = (a, b) => Math.acos(clamp(Math.abs(a.reduce((s, x, i) => s + x * b[i], 0)) / (norm(a) * norm(b)))) / RAD;

  function gravityVector(beta, gamma) {
    if (![beta, gamma].every(Number.isFinite)) return null;
    const b = beta * RAD, g = gamma * RAD;
    return [-Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g)];
  }
  function longAxis(width, height, screenAngle = 0) {
    const quarterTurn = Math.abs(screenAngle % 180) === 90;
    return (quarterTurn ? width : height) >= (quarterTurn ? height : width) ? "y" : "x";
  }
  function longAxisTilt(beta, gamma, axis = "y") {
    const v = gravityVector(beta, gamma);
    return v ? angle(v, axis === "x" ? [1, 0, 0] : [0, 1, 0]) : null;
  }
  function tiltWindow(samples, zero = null, axis = "y") {
    if (!samples.length) return { value: null, spread: Infinity, stable: false, vector: null };
    const target = zero || (axis === "x" ? [1, 0, 0] : [0, 1, 0]);
    const values = samples.map(s => angle(s.v, target));
    const value = values.reduce((s, x) => s + x, 0) / values.length;
    const vector = [0, 1, 2].map(i => samples.reduce((s, x) => s + x.v[i], 0) / samples.length);
    const spread = Math.max(...values) - Math.min(...values);
    // Both enough samples and enough elapsed time are required on fast/slow sensor devices.
    const stable = samples.length >= 12 && samples.at(-1).at - samples[0].at >= 700 && spread <= .8 && norm(vector) > .98;
    return { value, spread, stable, vector };
  }
  function cameraHeading(alpha, beta, gamma) {
    if (![alpha, beta, gamma].every(Number.isFinite)) return null;
    const a = alpha * RAD, b = beta * RAD, g = gamma * RAD;
    const x = -Math.cos(a) * Math.sin(g) - Math.sin(a) * Math.sin(b) * Math.cos(g);
    const y = -Math.sin(a) * Math.sin(g) + Math.cos(a) * Math.sin(b) * Math.cos(g);
    // A camera pointed almost straight up/down has no useful horizontal azimuth.
    return Math.hypot(x, y) < .1 ? null : (Math.atan2(x, y) / RAD + 360) % 360;
  }
  function voiceIntent(text) {
    const t = String(text || "").replace(/\s/g, "");
    if (/취소|아니야|아니요/.test(t)) return "undo";
    if (/등없는지점|등이없는|조명없는지점|여기어두|어두운지점|^여기$|^지점$/.test(t)) return "spot";
    if (/꺼|고장|안켜|안들어|불이없|불없/.test(t)) return "고장";
    if (/깜빡|어두|흐리|약/.test(t)) return "점검필요";
    if (/켜져|정상|켜짐|들어/.test(t)) return "정상";
    return null;
  }

  function pointInRing(x, y, ring) {
    if (!Array.isArray(ring) || ring.length < 4) return false;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      const cross = (x - xi) * (yj - yi) - (y - yi) * (xj - xi);
      if (Math.abs(cross) < 1e-10 && x >= Math.min(xi, xj) && x <= Math.max(xi, xj) && y >= Math.min(yi, yj) && y <= Math.max(yi, yj)) return true;
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function inPolygon(x, y, polygon) {
    return pointInRing(x, y, polygon.outer) && !(polygon.holes || []).some(r => pointInRing(x, y, r));
  }
  const samePoint = (a, b) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
  function joinRings(segments) {
    const pending = segments.filter(p => p.length >= 2).map(p => p.map(x => x.slice()));
    const rings = [];
    let incomplete = 0;
    while (pending.length) {
      const ring = pending.shift();
      while (!samePoint(ring[0], ring.at(-1))) {
        const end = ring.at(-1);
        const i = pending.findIndex(p => samePoint(p[0], end) || samePoint(p.at(-1), end));
        if (i < 0) break;
        let next = pending.splice(i, 1)[0];
        if (!samePoint(next[0], end)) next.reverse();
        ring.push(...next.slice(1));
      }
      if (ring.length >= 4 && samePoint(ring[0], ring.at(-1))) rings.push(ring);
      else incomplete++;
    }
    return { rings, incomplete };
  }
  function relationPolygons(members) {
    const parts = { outer: [], inner: [] };
    let missing = 0;
    for (const m of members || []) {
      if (m.role && !["outer", "inner"].includes(m.role)) continue;
      if (m.type === "relation") { missing++; continue; } // Do not treat a partially expanded relation as a whole polygon.
      if (m.type !== "way") continue;
      if (!Array.isArray(m.geometry)) { missing++; continue; }
      const pts = m.geometry.map(p => [+p.lat, +p.lon]);
      if (pts.length >= 2 && pts.every(p => p.every(Number.isFinite))) parts[m.role === "inner" ? "inner" : "outer"].push(pts);
      else missing++;
    }
    const outer = joinRings(parts.outer), inner = joinRings(parts.inner);
    const polygons = outer.rings.map(r => ({ outer: r, holes: [] }));
    let orphanHoles = 0;
    for (const r of inner.rings) {
      const candidates = polygons.filter(p => pointInRing(r[0][0], r[0][1], p.outer));
      // Nested outer rings: assign the hole to the smallest containing outer.
      candidates.sort((a, b) => Math.abs(ringArea(a.outer)) - Math.abs(ringArea(b.outer)));
      if (candidates[0]) candidates[0].holes.push(r); else orphanHoles++;
    }
    return { polygons, incomplete: missing + outer.incomplete + inner.incomplete + orphanHoles };
  }
  function ringArea(ring) {
    let a = 0;
    for (let i = 1; i < ring.length; i++) a += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
    return a / 2;
  }
  function sampleLine(points, step = 8) {
    if (!(step > 0) || points.length < 2) return [];
    const segments = [];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length > 0) { segments.push({ a, b, start: total, length }); total += length; }
    }
    const at = distance => {
      let low = 0, high = segments.length - 1;
      while (low < high) { const mid = (low + high) >> 1; if (distance <= segments[mid].start + segments[mid].length) high = mid; else low = mid + 1; }
      const s = segments[low];
      const t = Math.max(0, Math.min(1, (distance - s.start) / s.length));
      return { x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t };
    };
    const samples = [];
    for (let start = 0; start < total - 1e-8; start += step) {
      const end = Math.min(total, start + step);
      samples.push({ ...at((start + end) / 2), length: end - start, start: at(start), end: at(end) });
    }
    return samples;
  }
  return { gravityVector, longAxis, longAxisTilt, tiltWindow, cameraHeading, voiceIntent, pointInRing, inPolygon, joinRings, relationPolygons, sampleLine };
});
