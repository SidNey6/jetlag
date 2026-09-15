// Geodäsie ohne Abhängigkeiten.
// Distanzen in Metern, Winkel in Grad, Punkte als {lat, lng}.

export const EARTH_R = 6371008.8; // mittlerer Erdradius (IUGG)
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function distance(a, b) {
  const p1 = a.lat * D2R, p2 = b.lat * D2R;
  const dp = (b.lat - a.lat) * D2R, dl = (b.lng - a.lng) * D2R;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearing(a, b) {
  const p1 = a.lat * D2R, p2 = b.lat * D2R, dl = (b.lng - a.lng) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

export function destination(a, brngDeg, dist) {
  const d = dist / EARTH_R, t = brngDeg * D2R;
  const p1 = a.lat * D2R, l1 = a.lng * D2R;
  const sp = Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t);
  const p2 = Math.asin(Math.min(1, Math.max(-1, sp)));
  const l2 = l1 + Math.atan2(
    Math.sin(t) * Math.sin(d) * Math.cos(p1),
    Math.cos(d) - Math.sin(p1) * sp
  );
  return { lat: p2 * R2D, lng: normLng(l2 * R2D) };
}

export function normLng(lng) {
  return ((lng + 540) % 360) - 180;
}

// Lokales ENU-Bezugssystem (Ost/Nord in Metern) um einen Ursprung.
// Gute Näherung bis ~200 km; exakte Feinkorrekturen laufen darüber per Iteration.
export function enu(origin) {
  const mPerDegLat = D2R * EARTH_R;
  const mPerDegLng = mPerDegLat * Math.cos(origin.lat * D2R);
  return {
    to(p) {
      return { x: normLng(p.lng - origin.lng) * mPerDegLng, y: (p.lat - origin.lat) * mPerDegLat };
    },
    from(x, y) {
      return { lat: origin.lat + y / mPerDegLat, lng: normLng(origin.lng + x / mPerDegLng) };
    },
  };
}

export function midpoint(a, b) {
  return destination(a, bearing(a, b), distance(a, b) / 2);
}

// Mittelsenkrechte zwischen a und b: alle Punkte mit gleichem Abstand zu beiden.
// Startwert aus der Näherung, dann Newton-Korrektur entlang des echten Gradienten von
// f(P) = d(P,a) - d(P,b). Ohne diese Korrektur läuft die Linie an den Enden um zweistellige
// Meterbeträge aus dem Ruder, weil die Achsenrichtung nur nahe der Mitte gilt.
export function bisector(a, b, halfLength, samples = 64) {
  const mid = midpoint(a, b);
  const axis = bearing(a, b);
  const out = [];
  const n = Math.max(2, samples);
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * 2 - 1; // -1 .. 1
    let p = destination(mid, axis + 90, t * halfLength);
    for (let k = 0; k < 8; k++) {
      const delta = distance(p, a) - distance(p, b);
      if (Math.abs(delta) < 0.02) break;
      // Gradient: Einheitsvektoren, die von a bzw. b wegzeigen
      const ba = (bearing(p, a) + 180) * D2R, bb = (bearing(p, b) + 180) * D2R;
      const gx = Math.sin(ba) - Math.sin(bb);
      const gy = Math.cos(ba) - Math.cos(bb);
      const g2 = gx * gx + gy * gy;
      if (g2 < 1e-9) break;
      const sx = (-delta * gx) / g2, sy = (-delta * gy) / g2;
      p = destination(p, Math.atan2(sx, sy) * R2D, Math.hypot(sx, sy));
    }
    out.push(p);
  }
  return out;
}

export function circle(center, radius, samples = 128) {
  const out = [];
  for (let i = 0; i < samples; i++) out.push(destination(center, (i * 360) / samples, radius));
  return out;
}

// Kreissektor als geschlossenes Polygon (Mittelpunkt + Bogen).
export function sector(center, radius, fromDeg, toDeg, samples = 64) {
  let span = (toDeg - fromDeg + 360) % 360;
  if (span === 0) span = 360;
  const out = span >= 359.99 ? [] : [center];
  for (let i = 0; i <= samples; i++) out.push(destination(center, fromDeg + (span * i) / samples, radius));
  return out;
}

// Ray-Casting in Längen-/Breitengraden; für Spielgebiete (keine Pol-/Datumsgrenzenfälle) ausreichend.
export function pointInPolygon(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].lat, xi = ring[i].lng, yj = ring[j].lat, xj = ring[j].lng;
    if ((yi > p.lat) !== (yj > p.lat) && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/* ---------- Abstand zu ausgedehnten Objekten ---------- */
// Autobahnen, Küsten, Grenzen, Flüsse und Parks sind Linien und Flächen.
// Für die gilt der Abstand zum nächstgelegenen Punkt des Objekts, nicht zu einem
// willkürlich gesetzten Mittelpunkt. Gerechnet wird im lokalen ENU-System mit dem
// Abfragepunkt als Ursprung – damit ist der gesuchte Abstand einfach die Länge des
// Lotfußpunkt-Vektors.

export function distanceToSegment(p, a, b) {
  const e = enu(p);
  const A = e.to(a), B = e.to(b);
  const dx = B.x - A.x, dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(A.x, A.y);
  let t = -(A.x * dx + A.y * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(A.x + t * dx, A.y + t * dy);
}

export function distanceToLine(p, points) {
  if (!points || !points.length) return Infinity;
  if (points.length === 1) return distance(p, points[0]);
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const d = distanceToSegment(p, points[i - 1], points[i]);
    if (d < best) best = d;
  }
  return best;
}

export function distanceToPolygon(p, ring) {
  if (!ring || ring.length < 3) return distanceToLine(p, ring);
  if (pointInPolygon(p, ring)) return 0;
  return distanceToLine(p, [...ring, ring[0]]);
}

// features: [{ type: 'point' | 'line' | 'polygon', points: [{lat,lng}, ...] }]
export function distanceToFeatures(p, features) {
  let best = Infinity;
  for (const f of features || []) {
    let d;
    if (f.type === 'polygon') d = distanceToPolygon(p, f.points);
    else if (f.type === 'line') d = distanceToLine(p, f.points);
    else d = distance(p, f.points[0] || f);
    if (d < best) best = d;
    if (best === 0) return 0;
  }
  return best;
}

export function boundsOf(points) {
  let s = 90, n = -90, w = 180, e = -180;
  for (const p of points) {
    if (p.lat < s) s = p.lat;
    if (p.lat > n) n = p.lat;
    if (p.lng < w) w = p.lng;
    if (p.lng > e) e = p.lng;
  }
  return { south: s, north: n, west: w, east: e };
}

export const MI = 1609.344;

// Deutsche Schreibweise: Dezimalkomma
function de(n, digits) {
  return n.toFixed(digits).replace('.', ',');
}

export function formatDistance(m, unit = 'metric') {
  if (!isFinite(m)) return '–';
  if (unit === 'imperial') {
    const mi = m / MI;
    if (mi < 0.2) return `${Math.round(m / 0.3048)} ft`;
    return `${de(mi, mi < 10 ? 2 : 1)} mi`;
  }
  if (m < 1000) return `${Math.round(m)} m`;
  const km = m / 1000;
  return `${de(km, km < 10 ? 2 : 1)} km`;
}

export function formatBearing(deg) {
  const names = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return `${Math.round(deg)}° ${names[Math.round(deg / 22.5) % 16]}`;
}

// Douglas-Peucker: Verwaltungsgrenzen haben oft Zehntausende Stützpunkte,
// die weder die Maske noch der Sync-Code braucht.
export function simplify(points, epsilon) {
  if (points.length < 3) return points;
  const sqEps = epsilon * epsilon;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const d = sqSegDist(points[i], points[i0], points[i1]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > sqEps && idx > 0) {
      keep[idx] = 1;
      stack.push([i0, idx], [idx, i1]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function sqSegDist(p, a, b) {
  let x = a.lng, y = a.lat;
  let dx = b.lng - x, dy = b.lat - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p.lng - x) * dx + (p.lat - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b.lng; y = b.lat; }
    else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = p.lng - x; dy = p.lat - y;
  return dx * dx + dy * dy;
}
