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

// Heiß: das hier läuft bei der Restflächen-Schätzung millionenfach. Deshalb ohne
// Objekt- und Closure-Allokation, mit einmal berechneten Projektionsfaktoren und
// Vergleich über Quadrate – die Wurzel fällt erst ganz am Ende an.
function lngDelta(a, b) {
  let d = a - b;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  return d;
}

export function distanceToSegment(p, a, b) {
  return Math.sqrt(sqDistToSegment(p, a, b, metersPerDegLng(p.lat)));
}

function metersPerDegLng(lat) {
  return D2R * EARTH_R * Math.cos(lat * D2R);
}

const M_PER_DEG_LAT = D2R * EARTH_R;

function sqDistToSegment(p, a, b, mLng) {
  const ax = lngDelta(a.lng, p.lng) * mLng, ay = (a.lat - p.lat) * M_PER_DEG_LAT;
  const bx = lngDelta(b.lng, p.lng) * mLng, by = (b.lat - p.lat) * M_PER_DEG_LAT;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return ax * ax + ay * ay;
  let t = -(ax * dx + ay * dy) / len2;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  const cx = ax + t * dx, cy = ay + t * dy;
  return cx * cx + cy * cy;
}

export function distanceToLine(p, points) {
  if (!points || !points.length) return Infinity;
  if (points.length === 1) return distance(p, points[0]);
  const mLng = metersPerDegLng(p.lat);
  let best = Infinity;
  let ax = lngDelta(points[0].lng, p.lng) * mLng;
  let ay = (points[0].lat - p.lat) * M_PER_DEG_LAT;
  for (let i = 1; i < points.length; i++) {
    const bx = lngDelta(points[i].lng, p.lng) * mLng;
    const by = (points[i].lat - p.lat) * M_PER_DEG_LAT;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let d2;
    if (len2 === 0) {
      d2 = ax * ax + ay * ay;
    } else {
      let t = -(ax * dx + ay * dy) / len2;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      const cx = ax + t * dx, cy = ay + t * dy;
      d2 = cx * cx + cy * cy;
    }
    if (d2 < best) best = d2;
    ax = bx; ay = by;
  }
  return Math.sqrt(best);
}

export function distanceToPolygon(p, ring) {
  if (!ring || ring.length < 3) return distanceToLine(p, ring);
  if (pointInPolygon(p, ring)) return 0;
  const mLng = metersPerDegLng(p.lat);
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const d2 = sqDistToSegment(p, ring[j], ring[i], mLng);
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

// Abstand zum Rand eines Rings, egal ob der Punkt innen oder außen liegt.
export function distanceToRing(p, ring) {
  if (!ring || ring.length < 2) return Infinity;
  const mLng = metersPerDegLng(p.lat);
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const d2 = sqDistToSegment(p, ring[j], ring[i], mLng);
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

// Umgebende Rechtecke je Objekt, damit weit entfernte Linien gar nicht erst
// durchgerechnet werden. In einer WeakMap, nicht am Objekt – sonst landeten sie
// im gespeicherten Spielstand.
const featureBoxes = new WeakMap();

function featureBox(f) {
  let b = featureBoxes.get(f);
  if (!b) {
    b = boundsOf(f.points);
    featureBoxes.set(f, b);
  }
  return b;
}

// Untere Schranke für den Abstand zum Rechteck – nie größer als der echte Abstand.
function boxLowerBound(p, b, mLng) {
  const dLat = p.lat < b.south ? b.south - p.lat : (p.lat > b.north ? p.lat - b.north : 0);
  const dLng = p.lng < b.west ? b.west - p.lng : (p.lng > b.east ? p.lng - b.east : 0);
  if (dLat === 0 && dLng === 0) return 0;
  const y = dLat * M_PER_DEG_LAT, x = dLng * mLng;
  return Math.sqrt(x * x + y * y) * 0.999;
}

// features: [{ type: 'point' | 'line' | 'polygon', points: [{lat,lng}, ...] }]
// limit: Objekte, die sicher mindestens so weit weg sind, werden übersprungen. Das
// Ergebnis ist dann nur als "nicht näher als limit" verlässlich – genau das braucht
// ein Argmin über viele Kandidaten.
export function distanceToFeatures(p, features, limit = Infinity) {
  if (!features || !features.length) return Infinity;
  const mLng = metersPerDegLng(p.lat);
  let best = Infinity;
  for (const f of features) {
    if (!f.points || !f.points.length) continue;
    if (f.points.length > 2 && boxLowerBound(p, featureBox(f), mLng) >= Math.min(best, limit)) continue;
    let d;
    if (f.type === 'polygon') d = distanceToPolygon(p, f.points);
    else if (f.type === 'line') d = distanceToLine(p, f.points);
    else d = distance(p, f.points[0]);
    if (d < best) best = d;
    if (best === 0) return 0;
  }
  return best;
}

/* ---------- Seite einer gerichteten Linie ---------- */
// "Bist du auf derselben Flussseite wie ich?" Flüsse sind in OpenStreetMap immer in
// Fließrichtung gezeichnet. Damit hat jeder Punkt eine eindeutige Seite: links oder
// rechts der nächstgelegenen Stelle des Flusses. Das gilt auch hinter Mäandern und
// neben Seitenarmen, solange die Richtung stimmt – deshalb nur für Linien mit
// verlässlicher Richtung (sources.js: directed).
//
// Liegt die nächste Stelle genau auf einem Knick (oder dem Übergang zwischen zwei
// Teilstücken), entscheidet die Summe der Richtungen aller dort anliegenden Stücke.
// Nur ein Stück zu nehmen ergäbe außen an jeder Kurve die falsche Seite.
//
// Ergebnis: side +1 = links, −1 = rechts (in Linienrichtung), distance in Metern.
export function sideOfLines(p, features) {
  if (!features || !features.length) return null;
  const mLng = metersPerDegLng(p.lat);
  let best = Infinity;
  // Kandidaten der aktuell besten Entfernung: Lotfußpunkt und Richtung je Stück
  let hits = [];
  for (const f of features) {
    const pts = f.points;
    if (f.type !== 'line' || !pts || pts.length < 2) continue;
    if (pts.length > 2 && boxLowerBound(p, featureBox(f), mLng) > Math.sqrt(best) + 0.01) continue;
    let ax = lngDelta(pts[0].lng, p.lng) * mLng;
    let ay = (pts[0].lat - p.lat) * M_PER_DEG_LAT;
    for (let i = 1; i < pts.length; i++) {
      const bx = lngDelta(pts[i].lng, p.lng) * mLng;
      const by = (pts[i].lat - p.lat) * M_PER_DEG_LAT;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 > 0) {
        let t = -(ax * dx + ay * dy) / len2;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        const cx = ax + t * dx, cy = ay + t * dy;
        const d2 = cx * cx + cy * cy;
        if (d2 < best - 1e-6) {
          best = d2;
          hits = [{ cx, cy, dx, dy, len: Math.sqrt(len2), t }];
        } else if (d2 <= best + 1e-6) {
          hits.push({ cx, cy, dx, dy, len: Math.sqrt(len2), t });
        }
      }
      ax = bx; ay = by;
    }
  }
  if (!hits.length) return null;

  const h = hits[0];
  const distanceM = Math.sqrt(best);
  // Vektor vom Lotfußpunkt zum Punkt p (p liegt im Ursprung)
  const vx = -h.cx, vy = -h.cy;
  let tx, ty;
  const amKnick = hits.length > 1 && hits.every((x) => (x.t === 0 || x.t === 1)
    && Math.abs(x.cx - h.cx) < 0.01 && Math.abs(x.cy - h.cy) < 0.01);
  if (amKnick) {
    tx = 0; ty = 0;
    for (const x of hits) { tx += x.dx / x.len; ty += x.dy / x.len; }
    if (Math.abs(tx) < 1e-9 && Math.abs(ty) < 1e-9) { tx = h.dx; ty = h.dy; }
  } else {
    tx = h.dx; ty = h.dy;
  }
  const cross = tx * vy - ty * vx;
  return {
    side: cross > 0 ? 1 : (cross < 0 ? -1 : 0),
    distance: distanceM,
    // Himmelsrichtung von der Linie zum Punkt – für "du bist östlich des Rheins"
    bearing: (Math.atan2(vx, vy) / D2R + 360) % 360,
  };
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

// Deutsche Schreibweise: Dezimalkomma
function de(n, digits) {
  return n.toFixed(digits).replace('.', ',');
}

// Unter einem Kilometer in Metern, darüber in Kilometern.
export function formatDistance(m) {
  if (!isFinite(m)) return '–';
  if (m < 1000) return `${Math.round(m)} m`;
  const km = m / 1000;
  // "1 km" statt "1,00 km": Nachkommastellen nur, wenn sie etwas aussagen
  return `${de(km, km < 10 ? 2 : 1).replace(/,?0+$/, '')} km`;
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

/* ---------- Rasterwerte (z. B. Geländehöhe) ---------- */

// grid: { south, north, west, east, rows, cols, values } – values zeilenweise ab Süden,
// Werte liegen auf den Gitterknoten. Bilinear interpoliert; außerhalb: null.
export function sampleGrid(grid, p) {
  if (!grid || !grid.values) return null;
  const { south, north, west, east, rows, cols, values } = grid;
  if (p.lat < south || p.lat > north || p.lng < west || p.lng > east) return null;
  const fy = rows > 1 ? ((p.lat - south) / (north - south)) * (rows - 1) : 0;
  const fx = cols > 1 ? ((p.lng - west) / (east - west)) * (cols - 1) : 0;
  const r0 = Math.min(rows - 1, Math.floor(fy)), c0 = Math.min(cols - 1, Math.floor(fx));
  const r1 = Math.min(rows - 1, r0 + 1), c1 = Math.min(cols - 1, c0 + 1);
  const ty = fy - r0, tx = fx - c0;
  const v = (r, c) => values[r * cols + c];
  const a = v(r0, c0), b = v(r0, c1), c = v(r1, c0), d = v(r1, c1);
  if ([a, b, c, d].some((x) => x == null || Number.isNaN(x))) return null;
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/* ---------- Räumlicher Index für viele Linien und Flächen ---------- */
// "Welche Buslinie ist dir am nächsten?" heißt für jeden Rasterpunkt und jede
// Stichprobe: Abstand zu Tausenden Wegstücken. Linear durchgezählt kostete das auf dem
// Handy Sekunden. Der Index legt die Stücke in ein Gitter und sucht nur in Ringen um den
// Punkt, bis nichts Näheres mehr kommen kann. Gemeinsame Abschnitte mehrerer Gruppen
// (zehn Buslinien auf derselben Straße) liegen nur einmal darin – mit allen Eigentümern.
//
// groups: Liste von Feature-Listen; classOf(i) ordnet Gruppe i der Klasse A (true) oder
// B (false) zu – für "gewählte Linie gegen alle anderen".

// Kompakt gespeicherte Geometrie: { t: 'l'|'p'|'n', c: [lat, lng, lat, lng, …] } statt
// Punktobjekten – etwa ein Drittel so groß im Spielstand. Entpackt wird bei Bedarf, einmal.
const entpackt = new WeakMap();
const KURZTYP = { l: 'line', p: 'polygon', n: 'point' };

export function pointsOf(f) {
  if (f.points) return f.points;
  let pts = entpackt.get(f);
  if (!pts) {
    pts = new Array(f.c.length / 2);
    for (let i = 0, j = 0; i < f.c.length; i += 2, j++) pts[j] = { lat: f.c[i], lng: f.c[i + 1] };
    entpackt.set(f, pts);
  }
  return pts;
}

export function typeOf(f) {
  return f.type || KURZTYP[f.t] || 'line';
}

export class SegmentIndex {
  constructor(groups, classOf = () => true) {
    let s = 90, n = -90, w = 180, e = -180;
    for (const g of groups) for (const f of g) for (const p of pointsOf(f)) {
      if (p.lat < s) s = p.lat; if (p.lat > n) n = p.lat;
      if (p.lng < w) w = p.lng; if (p.lng > e) e = p.lng;
    }
    this.empty = s > n;
    this.lat0 = this.empty ? 0 : (s + n) / 2;
    this.lng0 = this.empty ? 0 : (w + e) / 2;
    this.mLng = metersPerDegLng(this.lat0);

    const ax = [], ay = [], bx = [], by = [], cls = [];
    const seen = new Map();
    const polys = [];
    const xy = (p) => [lngDelta(p.lng, this.lng0) * this.mLng, (p.lat - this.lat0) * M_PER_DEG_LAT];
    const add = (a, b, isA) => {
      // Gleiche Strecke = gleicher Schlüssel, egal in welcher Richtung
      const k1 = `${Math.round(a[0] * 10)},${Math.round(a[1] * 10)}`, k2 = `${Math.round(b[0] * 10)},${Math.round(b[1] * 10)}`;
      const key = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
      const bit = isA ? 1 : 2;
      const i = seen.get(key);
      if (i != null) { cls[i] |= bit; return; }
      seen.set(key, ax.length);
      ax.push(a[0]); ay.push(a[1]); bx.push(b[0]); by.push(b[1]); cls.push(bit);
    };
    groups.forEach((g, gi) => {
      const isA = !!classOf(gi);
      for (const f of g) {
        const pts = pointsOf(f).map(xy);
        if (!pts.length) continue;
        if (pts.length === 1) { add(pts[0], pts[0], isA); continue; }
        for (let i = 1; i < pts.length; i++) add(pts[i - 1], pts[i], isA);
        if (typeOf(f) === 'polygon' && pts.length > 2) {
          add(pts[pts.length - 1], pts[0], isA);
          let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
          for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
          polys.push({ pts, isA, x0, x1, y0, y1 });
        }
      }
    });
    this.ax = Float64Array.from(ax); this.ay = Float64Array.from(ay);
    this.bx = Float64Array.from(bx); this.by = Float64Array.from(by);
    this.cls = Uint8Array.from(cls);
    this.stamp = new Uint32Array(ax.length);
    this.qid = 0;

    // Zellgröße nach Dichte: dichte Buslinien brauchen feine Zellen, wenige Autobahnen
    // grobe – sonst liefe die Ringsuche über Hunderte leere Zellen
    const breite = Math.max(1, lngDelta(e, w) * this.mLng), hoehe = Math.max(1, (n - s) * M_PER_DEG_LAT);
    const cell = Math.min(3000, Math.max(80, Math.sqrt((breite * hoehe) / Math.max(1, ax.length)) * 2));
    this.cell = cell;

    const grid = new Map();
    let gx0 = Infinity, gx1 = -Infinity, gy0 = Infinity, gy1 = -Infinity;
    const put = (map, x0, x1, y0, y1, v) => {
      const cx0 = Math.floor(x0 / cell), cx1 = Math.floor(x1 / cell);
      const cy0 = Math.floor(y0 / cell), cy1 = Math.floor(y1 / cell);
      for (let gx = cx0; gx <= cx1; gx++) {
        for (let gy = cy0; gy <= cy1; gy++) {
          const k = gx * 1048576 + gy;
          let list = map.get(k);
          if (!list) { list = []; map.set(k, list); }
          list.push(v);
        }
      }
      if (cx0 < gx0) gx0 = cx0; if (cx1 > gx1) gx1 = cx1; if (cy0 < gy0) gy0 = cy0; if (cy1 > gy1) gy1 = cy1;
    };
    for (let i = 0; i < ax.length; i++) {
      put(grid, Math.min(ax[i], bx[i]), Math.max(ax[i], bx[i]), Math.min(ay[i], by[i]), Math.max(ay[i], by[i]), i);
    }
    // Flächen ebenfalls ins Gitter: "liegt der Punkt drin?" nur für die, die es betrifft
    const polyGrid = new Map();
    polys.forEach((poly, i) => put(polyGrid, poly.x0, poly.x1, poly.y0, poly.y1, i));
    this.polys = polys;
    this.grid = grid;
    this.polyGrid = polyGrid;
    this.gx0 = gx0; this.gx1 = gx1; this.gy0 = gy0; this.gy1 = gy1;
  }

  // Nächster Abstand zur Klasse A und zur Klasse B. Gesucht wird, bis alles innerhalb
  // von min(dA, dB) + extra sicher erfasst ist, höchstens bis limit Meter; was dann noch
  // Infinity ist, liegt mindestens so weit weg.
  query(p, extra = 0, limit = Infinity) {
    let dA = Infinity, dB = Infinity;
    if (this.empty) return { dA, dB };
    const x = lngDelta(p.lng, this.lng0) * this.mLng, y = (p.lat - this.lat0) * M_PER_DEG_LAT;
    const cell = this.cell;
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);

    // In einer Fläche ist der Abstand null
    const inZelle = this.polyGrid.get(gx * 1048576 + gy);
    if (inZelle) {
      for (const i of inZelle) {
        const poly = this.polys[i];
        if (x < poly.x0 || x > poly.x1 || y < poly.y0 || y > poly.y1) continue;
        if ((poly.isA ? dA : dB) === 0) continue;
        if (inRingXY(x, y, poly.pts)) { if (poly.isA) dA = 0; else dB = 0; }
      }
    }

    const qid = ++this.qid;
    const { ax, ay, bx, by, cls, stamp, grid } = this;
    let best2A = dA === 0 ? 0 : Infinity, best2B = dB === 0 ? 0 : Infinity;
    // Weiter als bis zum Rand des Gitters braucht kein Ring zu reichen
    const maxR = Math.max(gx - this.gx0, this.gx1 - gx, gy - this.gy0, this.gy1 - gy, 0);
    // Bis zu diesem Abstand ist sicher alles gesehen; weiter gefundene Werte sind nur
    // untere Schranken und werden als "weiter weg" (Infinity) gemeldet
    let sicher = Infinity;
    for (let r = 0; r <= maxR; r++) {
      const naechste = (r - 1) * cell;
      if (r > 0 && (naechste > limit || naechste > Math.sqrt(Math.min(best2A, best2B)) + extra)) { sicher = naechste; break; }
      for (let ix = gx - r; ix <= gx + r; ix++) {
        const rand = r === 0 || ix === gx - r || ix === gx + r;
        const schritt = rand ? 1 : 2 * r;
        for (let iy = gy - r; iy <= gy + r; iy += schritt) {
          const list = grid.get(ix * 1048576 + iy);
          if (!list) continue;
          for (let k = 0; k < list.length; k++) {
            const i = list[k];
            if (stamp[i] === qid) continue;
            stamp[i] = qid;
            const c = cls[i];
            const d2 = segSq(x, y, ax[i], ay[i], bx[i], by[i]);
            if ((c & 1) && d2 < best2A) best2A = d2;
            if ((c & 2) && d2 < best2B) best2B = d2;
          }
        }
      }
    }
    const dA2 = Math.sqrt(best2A), dB2 = Math.sqrt(best2B);
    return { dA: dA2 <= sicher ? dA2 : Infinity, dB: dB2 <= sicher ? dB2 : Infinity };
  }

  // Abstand zum nächsten Objekt überhaupt
  nearest(p) {
    const { dA, dB } = this.query(p, 0);
    return Math.min(dA, dB);
  }
}

function segSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  const cx = ax + t * dx - px, cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

function inRingXY(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
