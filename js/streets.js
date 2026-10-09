// Straßennetz für das Endgame: welche Straßen im Umkreis der Haltestelle schon
// abgelaufen sind. Ohne DOM, damit die Tests dieselbe Rechnung prüfen wie die App.
//
// Das Netz besteht aus OSM-Wegen, die in kurze Stücke (≈15 m) zerlegt werden. Ein Stück
// gilt als abgelaufen, sobald die aufgezeichnete Spur nah genug an seiner Mitte
// vorbeiführt. Kurze Stücke statt ganzer Straßen: eine Straße, in die man nur
// hineingeschaut hat, soll nicht komplett als erledigt gelten.
//
// Zustand je Stück: 0 = offen, 1 = abgelaufen, 2 = vermutlich abgelaufen (Lücke in der
// Aufzeichnung, über den kürzesten Weg geschätzt).

const D2R = Math.PI / 180;
const M_LAT = 111320;
const CELL_M = 40;

export const OPEN = 0, WALKED = 1, GUESSED = 2;

/* ---------- Aufbau ---------- */

// ways: [{ id, nodes: [OSM-Knoten-IDs] | null, pts: [[lat, lng], …] }]
export function buildNetwork(ways, { pieceM = 15, origin = null } = {}) {
  const first = origin || (ways[0] && ways[0].pts[0] ? { lat: ways[0].pts[0][0], lng: ways[0].pts[0][1] } : { lat: 0, lng: 0 });
  const mLng = M_LAT * Math.cos(first.lat * D2R);
  const xy = (lat, lng) => [(lng - first.lng) * mLng, (lat - first.lat) * M_LAT];

  const nodeIndex = new Map();
  const nodes = [];
  const adj = [];
  const edges = [];
  const pieces = [];
  const grid = new Map();

  const nodeOf = (key, lat, lng) => {
    let i = nodeIndex.get(key);
    if (i == null) {
      i = nodes.length;
      nodeIndex.set(key, i);
      const [x, y] = xy(lat, lng);
      nodes.push({ lat, lng, x, y });
      adj.push([]);
    }
    return i;
  };

  for (const w of ways) {
    if (!w.pts || w.pts.length < 2) continue;
    let prev = null;
    w.pts.forEach(([lat, lng], k) => {
      const key = w.nodes && w.nodes[k] != null ? `n${w.nodes[k]}` : `${lat.toFixed(7)},${lng.toFixed(7)}`;
      const cur = nodeOf(key, lat, lng);
      if (prev != null && prev !== cur) addEdge(prev, cur, w.id);
      prev = cur;
    });
  }

  function addEdge(u, v, wayId) {
    const a = nodes[u], b = nodes[v];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const e = edges.length;
    const count = Math.max(1, Math.ceil(len / pieceM));
    edges.push({ u, v, len, first: pieces.length, count, way: wayId });
    adj[u].push({ to: v, edge: e, len });
    adj[v].push({ to: u, edge: e, len });
    for (let i = 0; i < count; i++) {
      const t0 = i / count, t1 = (i + 1) / count, tm = (t0 + t1) / 2;
      const p = {
        edge: e,
        len: len / count,
        a: lerp(a, b, t0), b: lerp(a, b, t1),
        mx: a.x + (b.x - a.x) * tm, my: a.y + (b.y - a.y) * tm,
      };
      const idx = pieces.length;
      pieces.push(p);
      const key = cellKey(p.mx, p.my);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(idx);
    }
  }

  return { origin: first, mLng, nodes, adj, edges, pieces, grid };
}

function lerp(a, b, t) {
  return [a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t];
}

function cellKey(x, y) {
  return `${Math.floor(x / CELL_M)},${Math.floor(y / CELL_M)}`;
}

export function toXY(net, p) {
  return [(p.lng - net.origin.lng) * net.mLng, (p.lat - net.origin.lat) * M_LAT];
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  const cx = ax + t * dx - px, cy = ay + t * dy - py;
  return Math.sqrt(cx * cx + cy * cy);
}

/* ---------- Abgelaufen markieren ---------- */

export function emptyStates(net) {
  return new Uint8Array(net.pieces.length);
}

// Spurstück a→b (Lat/Lng) ablaufen: alle Stücke, deren Mitte höchstens widthM entfernt
// liegt. Gibt die Zahl der neu markierten Stücke zurück. Mit value = GUESSED werden nur
// offene Stücke markiert – eine Schätzung überschreibt nie echte Aufzeichnung.
export function markWalked(net, states, a, b, widthM, value = WALKED) {
  const [ax, ay] = toXY(net, a);
  const [bx, by] = toXY(net, b);
  const x0 = Math.floor((Math.min(ax, bx) - widthM) / CELL_M), x1 = Math.floor((Math.max(ax, bx) + widthM) / CELL_M);
  const y0 = Math.floor((Math.min(ay, by) - widthM) / CELL_M), y1 = Math.floor((Math.max(ay, by) + widthM) / CELL_M);
  // Ein GPS-Sprung über Hunderte Meter soll nicht das halbe Viertel markieren
  if ((x1 - x0) * (y1 - y0) > 400) return 0;
  let changed = 0;
  for (let gx = x0; gx <= x1; gx++) {
    for (let gy = y0; gy <= y1; gy++) {
      const cell = net.grid.get(`${gx},${gy}`);
      if (!cell) continue;
      for (const i of cell) {
        if (states[i] === WALKED || (value === GUESSED && states[i] !== OPEN)) continue;
        const p = net.pieces[i];
        if (distToSeg(p.mx, p.my, ax, ay, bx, by) <= widthM) {
          states[i] = value;
          changed++;
        }
      }
    }
  }
  return changed;
}

export function markTrack(net, states, points, widthM, value = WALKED) {
  let changed = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)], b = points[i];
    changed += markWalked(net, states, a, b, widthM, value);
  }
  return changed;
}

// Ganze Kanten (aus einem geschätzten Weg) als "vermutlich abgelaufen" markieren
export function markGuessed(net, states, edgeIds) {
  let changed = 0;
  for (const e of edgeIds) {
    const edge = net.edges[e];
    for (let i = edge.first; i < edge.first + edge.count; i++) {
      if (states[i] === OPEN) { states[i] = GUESSED; changed++; }
    }
  }
  return changed;
}

/* ---------- Kürzester Weg für Aufzeichnungslücken ---------- */

export function nearestNode(net, p, maxM = Infinity) {
  const [x, y] = toXY(net, p);
  let best = -1, bd = Infinity;
  for (let i = 0; i < net.nodes.length; i++) {
    const n = net.nodes[i];
    if (!net.adj[i].length) continue;
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < bd) { bd = d; best = i; }
  }
  return best >= 0 && bd <= maxM ? { node: best, distance: bd } : null;
}

// Dijkstra mit Binärheap; das Netz um eine Haltestelle hat wenige tausend Knoten.
export function shortestPath(net, from, to, { snapM = 60 } = {}) {
  const s = nearestNode(net, from, snapM);
  const t = nearestNode(net, to, snapM);
  if (!s || !t) return null;
  const n = net.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const via = new Int32Array(n).fill(-1);
  dist[s.node] = 0;
  const heap = [[0, s.node]];
  while (heap.length) {
    const [d, u] = heapPop(heap);
    if (d > dist[u]) continue;
    if (u === t.node) break;
    for (const { to: v, edge, len } of net.adj[u]) {
      const nd = d + len;
      if (nd < dist[v]) {
        dist[v] = nd;
        via[v] = edge;
        heapPush(heap, [nd, v]);
      }
    }
  }
  if (!isFinite(dist[t.node])) return null;
  const edgeIds = [];
  const nodeSeq = [t.node];
  for (let v = t.node; v !== s.node;) {
    const e = net.edges[via[v]];
    edgeIds.push(via[v]);
    v = e.u === v ? e.v : e.u;
    nodeSeq.push(v);
  }
  nodeSeq.reverse();
  return {
    edges: edgeIds.reverse(),
    length: dist[t.node] + s.distance + t.distance,
    points: nodeSeq.map((i) => ({ lat: net.nodes[i].lat, lng: net.nodes[i].lng })),
  };
}

function heapPush(h, item) {
  h.push(item);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h[p][0] <= h[i][0]) break;
    [h[p], h[i]] = [h[i], h[p]];
    i = p;
  }
}

function heapPop(h) {
  const top = h[0];
  const last = h.pop();
  if (h.length) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < h.length && h[l][0] < h[m][0]) m = l;
      if (r < h.length && h[r][0] < h[m][0]) m = r;
      if (m === i) break;
      [h[m], h[i]] = [h[i], h[m]];
      i = m;
    }
  }
  return top;
}

/* ---------- Auswertung ---------- */

// Nur Stücke innerhalb der Zone zählen; das Netz wird etwas weiter geladen, damit
// Wege an der Grenze zusammenhängen.
export function coverage(net, states, center, radiusM) {
  const [cx, cy] = toXY(net, center);
  let total = 0, walked = 0, guessed = 0;
  for (let i = 0; i < net.pieces.length; i++) {
    const p = net.pieces[i];
    if (Math.hypot(p.mx - cx, p.my - cy) > radiusM) continue;
    total += p.len;
    if (states[i] === WALKED) walked += p.len;
    else if (states[i] === GUESSED) guessed += p.len;
  }
  return { total, walked, guessed, fraction: total ? (walked + guessed) / total : 0 };
}

// Stücke zu durchgehenden Linien je Zustand zusammenfassen – fürs Zeichnen.
// Benachbarte Stücke derselben Kante mit gleichem Zustand werden eine Linie.
// Mit center/radiusM nur, was in der Zone liegt: Overpass liefert ganze Wege, und
// die reichen oft weit über den Rand hinaus.
export function linesByState(net, states, center = null, radiusM = Infinity) {
  const out = { [OPEN]: [], [WALKED]: [], [GUESSED]: [] };
  const [cx, cy] = center ? toXY(net, center) : [0, 0];
  for (const e of net.edges) {
    let run = null, runState = -1;
    for (let i = e.first; i < e.first + e.count; i++) {
      const p = net.pieces[i];
      const drin = !center || Math.hypot(p.mx - cx, p.my - cy) <= radiusM;
      const st = drin ? states[i] : -1;
      if (!run || st !== runState) {
        if (run && runState >= 0) out[runState].push(run);
        run = [p.a, p.b];
        runState = st;
      } else {
        run.push(p.b);
      }
    }
    if (run && runState >= 0) out[runState].push(run);
  }
  return out;
}

export function encodeStates(states) {
  let s = '';
  for (let i = 0; i < states.length; i++) s += states[i];
  return s;
}

export function decodeStates(text, length) {
  const st = new Uint8Array(length);
  if (typeof text === 'string' && text.length === length) {
    for (let i = 0; i < length; i++) st[i] = text.charCodeAt(i) - 48;
  }
  return st;
}

/* ---------- Spur filtern ---------- */

// Entscheidet, was mit einem neuen GPS-Punkt passiert:
//   'skip'   zu nah am letzten Punkt oder zu ungenau
//   'jump'   unplausibler Sprung (Reflexion an Hauswänden) – verwerfen
//   'gap'    lange keine Punkte (Bildschirm aus) – neues Teilstück beginnen
//   'append' normal anhängen
export function classifyFix(last, fix, { maxAccuracyM = 40, minStepM = 5, gapMs = 30000, maxSpeed = 12, rejected = 0 } = {}) {
  if (fix.accuracy != null && fix.accuracy > maxAccuracyM) return 'skip';
  if (!last) return 'append';
  const d = metersBetween(last, fix);
  const dt = Math.max(1, fix.t - last.t);
  if (dt > gapMs) return d > 25 ? 'gap' : 'append';
  if (d < minStepM) return 'skip';
  // Nach drei verworfenen Sprüngen hintereinander war es wohl doch echte Bewegung
  if (d / (dt / 1000) > maxSpeed && rejected < 3) return 'jump';
  return 'append';
}

export function metersBetween(a, b) {
  const x = (b.lng - a.lng) * M_LAT * Math.cos(((a.lat + b.lat) / 2) * D2R);
  const y = (b.lat - a.lat) * M_LAT;
  return Math.sqrt(x * x + y * y);
}

export function trackLength(segments) {
  let sum = 0;
  for (const seg of segments) {
    for (let i = 1; i < seg.length; i++) sum += metersBetween(seg[i - 1], seg[i]);
  }
  return sum;
}

/* ---------- GPX ---------- */

// Bewusst ohne DOMParser: GPX ist einfach genug, und so läuft es auch in den Tests.
export function parseGpx(text) {
  const segments = [];
  const segRe = /<(trkseg|rte)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = segRe.exec(text))) {
    const pts = parsePoints(m[2], m[1] === 'rte' ? 'rtept' : 'trkpt');
    if (pts.length) segments.push(pts);
  }
  if (!segments.length) {
    const pts = parsePoints(text, 'trkpt');
    if (pts.length) segments.push(pts);
  }
  return segments;
}

function parsePoints(chunk, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, 'g');
  let m;
  while ((m = re.exec(chunk))) {
    const lat = parseFloat((/\blat\s*=\s*["']([^"']+)["']/.exec(m[1]) || [])[1]);
    const lng = parseFloat((/\blon\s*=\s*["']([^"']+)["']/.exec(m[1]) || [])[1]);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    const time = m[2] ? (/<time>([^<]+)<\/time>/.exec(m[2]) || [])[1] : null;
    const t = time ? Date.parse(time) : NaN;
    out.push({ lat, lng, t: isFinite(t) ? t : null });
  }
  return out;
}

export function toGpx(segments, name = 'Jetlag Endgame') {
  const esc = (x) => String(x).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const segs = segments.map((seg) => '    <trkseg>\n' + seg.map((p) => `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}">`
    + (p.t ? `<time>${new Date(p.t).toISOString()}</time>` : '') + '</trkpt>').join('\n') + '\n    </trkseg>').join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<gpx version="1.1" creator="Jetlag Toolkit" xmlns="http://www.topografix.com/GPX/1/1">\n'
    + `  <trk>\n    <name>${esc(name)}</name>\n${segs}\n  </trk>\n</gpx>\n`;
}
