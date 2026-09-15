// OpenStreetMap-Abfragen über Overpass: Orte im Umkreis, nächstgelegenes Objekt,
// Verwaltungsgrenzen. Alles optional – ohne Netz bleibt die App voll bedienbar,
// die Dialoge sagen dann nur klar, dass hier Empfang nötig ist.

import { getState } from './state.js';
import { distance, formatDistance, simplify, destination, circle } from './geo.js';
import { el, clear, openSheet, toast } from './ui/ui.js';

// Reihenfolge = Vorzug. overpass.osm.jp fiel raus: ungültiges Zertifikat.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

export const CATEGORIES = [
  { id: 'station',    label: 'Bahnhöfe',      filter: '["railway"="station"]' },
  { id: 'tram',       label: 'Tram/U-Bahn',   filter: '["railway"~"^(tram_stop|subway_entrance)$"]' },
  { id: 'bus',        label: 'Bushaltestellen', filter: '["highway"="bus_stop"]' },
  { id: 'museum',     label: 'Museen',        filter: '["tourism"="museum"]' },
  { id: 'park',       label: 'Parks',         filter: '["leisure"="park"]' },
  { id: 'hospital',   label: 'Krankenhäuser', filter: '["amenity"="hospital"]' },
  { id: 'worship',    label: 'Kirchen',       filter: '["amenity"="place_of_worship"]' },
  { id: 'school',     label: 'Schulen',       filter: '["amenity"="school"]' },
  { id: 'university', label: 'Hochschulen',   filter: '["amenity"="university"]' },
  { id: 'library',    label: 'Bibliotheken',  filter: '["amenity"="library"]' },
  { id: 'supermarket',label: 'Supermärkte',   filter: '["shop"="supermarket"]' },
  { id: 'zoo',        label: 'Zoos',          filter: '["tourism"="zoo"]' },
  { id: 'viewpoint',  label: 'Aussichtspunkte', filter: '["tourism"="viewpoint"]' },
  { id: 'tower',      label: 'Türme',         filter: '["man_made"="tower"]' },
  { id: 'stadium',    label: 'Stadien',       filter: '["leisure"="stadium"]' },
  { id: 'airport',    label: 'Flughäfen',     filter: '["aeroway"="aerodrome"]' },
  { id: 'townhall',   label: 'Rathäuser',     filter: '["amenity"="townhall"]' },
  { id: 'castle',     label: 'Burgen/Schlösser', filter: '["historic"="castle"]' },
];

const cache = new Map();
const STAGGER_MS = 6000; // so lange bekommt ein Spiegel Vorsprung, bevor der nächste mitläuft

// Spiegel gestaffelt statt nacheinander abfragen: ein hängender Server hat sonst
// bis zu drei volle Zeitlimits blockiert, bevor überhaupt eine Antwort kam.
// Der erste brauchbare Treffer gewinnt, die übrigen Anfragen werden abgebrochen.
// Overpass ist geteilte Infrastruktur und drosselt; die Meldung soll das sagen,
// statt nur eine Statusnummer zu zeigen.
function httpHint(status) {
  if (status === 429) return 'Zu viele Anfragen – Overpass bittet um eine kurze Pause';
  if (status === 504) return 'Overpass ist gerade überlastet';
  if (status === 400) return 'Abfrage wurde abgelehnt (HTTP 400)';
  return `HTTP ${status}`;
}

function query(ql) {
  if (cache.has(ql)) return Promise.resolve(cache.get(ql));
  const timeout = (getState().settings.overpassTimeout || 25) * 1000;

  return new Promise((resolve, reject) => {
    const controllers = [];
    const timers = [];
    let started = 0, failures = 0, settled = false, lastErr = null;

    const cleanup = (winner) => {
      timers.forEach(clearTimeout);
      controllers.forEach((c) => { if (c !== winner) c.abort(); });
    };

    const startNext = () => {
      if (settled || started >= ENDPOINTS.length) return;
      const url = ENDPOINTS[started++];
      const ctrl = new AbortController();
      controllers.push(ctrl);
      timers.push(setTimeout(() => ctrl.abort(), timeout));
      timers.push(setTimeout(startNext, STAGGER_MS));

      fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(ql), signal: ctrl.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(httpHint(res.status));
          const json = await res.json();
          if (settled) return;
          settled = true;
          cleanup(ctrl);
          cache.set(ql, json);
          resolve(json);
        })
        .catch((err) => {
          if (settled) return;
          failures++;
          lastErr = err;
          if (failures >= ENDPOINTS.length) {
            settled = true;
            cleanup(null);
            reject(new Error(lastErr?.name === 'AbortError'
              ? 'Zeitüberschreitung – Overpass antwortet gerade nicht (oft Drosselung nach vielen Abfragen)'
              : String(lastErr?.message || lastErr)));
          } else {
            startNext();
          }
        });
    };

    startNext();
  });
}

function toPoints(json, { namedOnly = true } = {}) {
  const out = [];
  for (const e of json.elements || []) {
    const lat = e.lat ?? e.center?.lat;
    const lng = e.lon ?? e.center?.lon;
    if (lat == null || lng == null) continue;
    const name = e.tags?.name || null;
    if (namedOnly && !name) continue;
    out.push({ id: `${e.type[0]}${e.id}`, lat, lng, name: name || 'ohne Namen' });
  }
  // Gleichnamige Einträge zusammenfassen: OSM führt dieselbe Station oft mehrfach
  // (Relation, Node, zwei Bahnsteige). Zwei Einträge „Alexanderplatz" in einer
  // Auswahlliste wären für eine Frage nach dem nächsten Ort nicht beantwortbar.
  const seen = [];
  return out.filter((p) => {
    const dup = seen.find((q) => q.name === p.name && distance(p, q) < 400);
    if (dup) return false;
    seen.push(p);
    return true;
  });
}

export async function findPois(center, categoryId, radiusM, namedOnly = true) {
  const cat = CATEGORIES.find((c) => c.id === categoryId);
  if (!cat) throw new Error('Unbekannte Kategorie');
  const ql = `[out:json][timeout:${getState().settings.overpassTimeout || 25}];`
    + `nwr${cat.filter}(around:${Math.round(radiusM)},${center.lat.toFixed(6)},${center.lng.toFixed(6)});out center tags;`;
  const json = await query(ql);
  return toPoints(json, { namedOnly })
    .map((p) => ({ ...p, distance: distance(center, p) }))
    .sort((a, b) => a.distance - b.distance);
}

/* ---------- Gebiete: Verwaltungsgrenzen, Orte, Ortsteile, Dörfer ---------- */

// Nicht jedes Dorf ist eine Verwaltungsgrenze. In OSM stecken kleine Orte je nach
// Gegend als boundary=administrative (Ebene 9–11), als place-Fläche oder nur als
// place-Knoten ohne Umriss. Gesucht wird deshalb über beide Schienen.
const PLACE_RE = '^(city|borough|town|suburb|village|quarter|neighbourhood|hamlet|isolated_dwelling)$';
const ADMIN_RE = '^(4|5|6|7|8|9|10|11|12)$';

const ADMIN_LABEL = {
  4: 'Bundesland', 5: 'Regierungsbezirk', 6: 'Kreis', 7: 'Amt / Verbandsgemeinde',
  8: 'Gemeinde / Stadt', 9: 'Stadtbezirk', 10: 'Ortsteil', 11: 'Stadtviertel', 12: 'Quartier',
};
const PLACE_LABEL = {
  city: 'Großstadt', borough: 'Stadtbezirk', town: 'Stadt', suburb: 'Stadtteil', village: 'Dorf',
  quarter: 'Quartier', neighbourhood: 'Nachbarschaft', hamlet: 'Weiler',
  isolated_dwelling: 'Einzellage',
};
// Je höher der Rang, desto kleiner das Gebiet – danach wird sortiert, damit Dörfer
// und Ortsteile oben stehen und nicht hinter Bundesland und Kreis verschwinden.
const PLACE_RANK = {
  city: 8, borough: 9, town: 9, suburb: 10, village: 10,
  quarter: 11, neighbourhood: 12, hamlet: 11, isolated_dwelling: 12,
};

const SETTLEMENT = new Set(['city', 'borough', 'town', 'suburb', 'village', 'quarter', 'neighbourhood', 'hamlet', 'isolated_dwelling']);

export const GROUPS = [
  null,
  'Orte, Ortsteile und Viertel',
  'Ganze Gemeinden und Städte',
  'Nur als Punkt erfasst – wird zum Kreis',
  'Größere Gebiete',
];

// Sortiert wird danach, was für eine Spielfrage taugt, nicht danach, was klein ist:
// ein Dorf mit Umriss schlägt einen bloßen Ortspunkt, und Kreis oder Bundesland
// gehören ans Ende statt dazwischen.
export function areaTier(c) {
  const lvl = c.tags.admin_level ? parseInt(c.tags.admin_level, 10) : null;
  const settlement = SETTLEMENT.has(c.tags.place);
  const wide = c.tags.place === 'city' || c.tags.place === 'town';
  const small = (lvl != null && lvl >= 9) || (settlement && !wide);
  if (c.hasGeometry && small) return 1;
  if (c.hasGeometry && (lvl === 8 || wide)) return 2;
  if (!c.hasGeometry && settlement) return 3;
  return 4;
}

export function areaRank(tags = {}) {
  if (tags.admin_level) return parseInt(tags.admin_level, 10) || 13;
  return PLACE_RANK[tags.place] ?? 13;
}

export function areaKindLabel(tags = {}) {
  const parts = [];
  if (PLACE_LABEL[tags.place]) parts.push(PLACE_LABEL[tags.place]);
  if (ADMIN_LABEL[tags.admin_level]) parts.push(ADMIN_LABEL[tags.admin_level]);
  else if (tags.admin_level) parts.push(`Ebene ${tags.admin_level}`);
  return parts.join(' · ') || 'Gebiet';
}

function bboxAround(center, radius) {
  const n = destination(center, 0, radius), e = destination(center, 90, radius);
  const sth = destination(center, 180, radius), w = destination(center, 270, radius);
  return { south: sth.lat, north: n.lat, west: w.lng, east: e.lng };
}

// Alle Gebiete im Umkreis – nicht nur die, in denen man gerade steht.
// Genau daran scheiterte das Auswählen einzelner Dörfer vorher.
export async function findAreas(center, radius) {
  const b = bboxAround(center, radius);
  const box = `(${b.south.toFixed(6)},${b.west.toFixed(6)},${b.north.toFixed(6)},${b.east.toFixed(6)})`;
  const ql = `[out:json][timeout:${getState().settings.overpassTimeout || 25}];`
    + '('
    + `relation["boundary"="administrative"]["admin_level"~"${ADMIN_RE}"]${box};`
    + `relation["place"~"${PLACE_RE}"]${box};`
    + `way["place"~"${PLACE_RE}"]${box};`
    + `node["place"~"${PLACE_RE}"]${box};`
    + ');out tags center;';
  const json = await query(ql);

  const list = [];
  for (const e of json.elements || []) {
    const tags = e.tags || {};
    if (!tags.name) continue;
    const lat = e.lat ?? e.center?.lat;
    const lng = e.lon ?? e.center?.lon;
    if (lat == null || lng == null) continue;
    const c = {
      key: `${e.type}/${e.id}`, type: e.type, id: e.id, tags,
      name: tags.name, kind: areaKindLabel(tags), rank: areaRank(tags),
      lat, lng, distance: distance(center, { lat, lng }),
      hasGeometry: e.type !== 'node',
    };
    c.tier = areaTier(c);
    list.push(c);
  }

  // Derselbe Ort taucht oft doppelt auf (Grenzrelation + place-Knoten).
  // Der Eintrag mit Umriss gewinnt, sonst wäre nur der Kreis-Notbehelf übrig.
  const preference = { relation: 3, way: 2, node: 1 };
  const kept = [];
  for (const c of list.sort((a, b2) => preference[b2.type] - preference[a.type])) {
    const dup = kept.find((k) => k.name === c.name && Math.abs(k.rank - c.rank) <= 1 && distance(k, c) < 3000);
    if (!dup) kept.push(c);
  }
  return kept.sort((a, b2) => (a.tier - b2.tier) || (a.distance - b2.distance)).slice(0, 120);
}

// Welche Gebiete enthalten den Punkt? Nur zum Markieren in der Liste.
export async function areaKeysAt(point) {
  const ql = `[out:json][timeout:${getState().settings.overpassTimeout || 25}];`
    + `is_in(${point.lat.toFixed(6)},${point.lng.toFixed(6)})->.a;`
    + '(relation(pivot.a);way(pivot.a););out ids;';
  const json = await query(ql);
  return new Set((json.elements || []).map((e) => `${e.type}/${e.id}`));
}

export async function areaGeometry(cand) {
  if (cand.type === 'node') return null;
  const ql = `[out:json][timeout:60];${cand.type}(${cand.id});out geom;`;
  const json = await query(ql);
  const el0 = (json.elements || []).find((e) => e.type === cand.type);
  if (!el0) throw new Error('Keine Geometrie erhalten');

  const ring = el0.type === 'way'
    ? (el0.geometry || []).map((g) => ({ lat: g.lat, lng: g.lon }))
    : stitchOuterRing(el0.members || []);
  if (!ring || ring.length < 3) throw new Error('Umriss ließ sich nicht zusammensetzen');

  // Fein genug für ein Dorf, grob genug für ein Bundesland: erst scharf vereinfachen,
  // dann nur so weit nachlassen, bis die Punktzahl handhabbar ist.
  let eps = 0.00005;
  let out = simplify(ring, eps);
  while (out.length > 1200 && eps < 0.01) { eps *= 2; out = simplify(ring, eps); }
  return out;
}

// Die Grenzwege einer Relation kommen unsortiert und teils verdreht.
// Hier werden sie an den Endpunkten aneinandergehängt; von mehreren geschlossenen
// Ringen (Exklaven) gewinnt der flächenmäßig größte.
function stitchOuterRing(members) {
  const segs = members
    .filter((m) => m.type === 'way' && Array.isArray(m.geometry) && (m.role === 'outer' || !m.role))
    .map((m) => m.geometry.map((g) => ({ lat: g.lat, lng: g.lon })));
  if (!segs.length) return null;

  const rings = [];
  const pool = segs.slice();
  const near = (a, b) => Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lng - b.lng) < 1e-7;

  while (pool.length) {
    let ring = pool.shift().slice();
    let extended = true;
    while (extended) {
      extended = false;
      for (let i = 0; i < pool.length; i++) {
        const seg = pool[i];
        const head = ring[0], tail = ring[ring.length - 1];
        if (near(tail, seg[0])) { ring = ring.concat(seg.slice(1)); pool.splice(i, 1); extended = true; break; }
        if (near(tail, seg[seg.length - 1])) { ring = ring.concat(seg.slice().reverse().slice(1)); pool.splice(i, 1); extended = true; break; }
        if (near(head, seg[seg.length - 1])) { ring = seg.slice(0, -1).concat(ring); pool.splice(i, 1); extended = true; break; }
        if (near(head, seg[0])) { ring = seg.slice().reverse().slice(0, -1).concat(ring); pool.splice(i, 1); extended = true; break; }
      }
    }
    rings.push(ring);
  }
  rings.sort((a, b) => bboxArea(b) - bboxArea(a));
  return rings[0];
}

function bboxArea(ring) {
  let s = 90, n = -90, w = 180, e = -180;
  for (const p of ring) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lng); e = Math.max(e, p.lng); }
  return (n - s) * (e - w);
}

/* ---------- Dialoge ---------- */

function busyBox(text) {
  return el('div', { class: 'card' }, el('div', { class: 'card-title', text }), el('div', { class: 'progress' }, el('i', { style: { width: '35%' } })));
}

function netErrorBox(e) {
  return el('div', { class: 'card' },
    el('div', { class: 'card-title', text: 'Abfrage fehlgeschlagen' }),
    el('div', { class: 'card-sub', text: String(e && e.message || e) }),
    el('div', { class: 'hint', text: 'Ohne Empfang: Punkte per „Auf Karte" selbst setzen – alles andere funktioniert offline.' }));
}

export function poiSheet(center, onResult) {
  if (!center) return toast('Erst einen Standort brauchen', 'error');
  let category = 'station';
  let radius = 3000;
  openSheet('Orte im Umkreis laden', (body, close) => {
    const cats = el('div', { class: 'pills' }, CATEGORIES.map((c) => el('button', {
      class: `pill ${c.id === category ? 'on' : ''}`,
      onclick: (e) => {
        category = c.id;
        body.querySelectorAll('.pills .pill').forEach((p) => p.classList.remove('on'));
        e.target.classList.add('on');
      },
    }, c.label)));
    const radiusSel = el('select', {}, [300, 500, 1000, 2000, 3000, 5000, 10000, 15000, 25000, 50000].map((r) =>
      el('option', { value: String(r), selected: r === radius }, formatDistance(r, getState().settings.unit))));
    radiusSel.addEventListener('change', () => { radius = parseInt(radiusSel.value, 10); });
    const out = el('div', { class: 'panel-body', style: { padding: '0', maxHeight: '40vh' } });

    body.append(
      el('label', { class: 'field' }, 'Kategorie', cats),
      el('label', { class: 'field' }, 'Umkreis', radiusSel),
      out,
    );

    return [
      el('button', { class: 'btn grow', onclick: () => close() }, 'Schließen'),
      el('button', {
        class: 'btn grow btn-primary',
        onclick: async (ev) => {
          const btn = ev.target;
          btn.disabled = true;
          clear(out).append(busyBox('Suche läuft …'));
          try {
            const found = await findPois(center, category, radius);
            clear(out);
            if (!found.length) { out.append(el('div', { class: 'empty', text: 'Nichts gefunden – größeren Umkreis probieren.' })); return; }
            out.append(el('div', { class: 'hint', text: `${found.length} Orte gefunden` }));
            for (const p of found.slice(0, 60)) {
              out.append(el('div', { class: 'row' },
                el('div', { class: 'grow' }, el('div', { text: p.name }), el('div', { class: 'card-sub', text: formatDistance(p.distance, getState().settings.unit) }))));
            }
            out.append(el('button', {
              class: 'btn btn-primary btn-wide', style: { marginTop: '10px' },
              onclick: () => { close(); onResult(found.slice(0, 60).map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, name: p.name }))); },
            }, `${Math.min(found.length, 60)} Orte übernehmen`));
          } catch (e) {
            clear(out).append(netErrorBox(e));
          } finally {
            btn.disabled = false;
          }
        },
      }, 'Suchen'),
    ];
  });
}

export function nearestPoiSheet(center, onPick) {
  if (!center) return toast('Erst einen Standort brauchen', 'error');
  openSheet('Nächstgelegenes Objekt', (body, close) => {
    const out = el('div', {});
    const cats = el('div', { class: 'pills' }, CATEGORIES.map((c) => el('button', {
      class: 'pill',
      onclick: async () => {
        clear(out).append(busyBox(`Suche ${c.label} …`));
        try {
          let found = [];
          for (const r of [800, 2000, 6000, 20000, 60000]) {
            found = await findPois(center, c.id, r);
            if (found.length) break;
          }
          clear(out);
          if (!found.length) { out.append(el('div', { class: 'empty', text: 'Nichts gefunden.' })); return; }
          for (const p of found.slice(0, 15)) {
            out.append(el('button', {
              class: 'card', style: { textAlign: 'left' },
              onclick: () => { close(); onPick(p); },
            },
              el('div', { class: 'card-title', text: p.name }),
              el('div', { class: 'card-sub', text: formatDistance(p.distance, getState().settings.unit) })));
          }
        } catch (e) {
          clear(out).append(netErrorBox(e));
        }
      },
    }, c.label)));
    body.append(el('label', { class: 'field' }, 'Kategorie wählen', cats), out);
    return [el('button', { class: 'btn grow', onclick: () => close() }, 'Schließen')];
  });
}

export function areaPickerSheet(center, onPick) {
  if (!center) return toast('Erst einen Standort brauchen', 'error');
  let radius = 5000;
  let filter = '';
  let found = [];
  let here = new Set();

  openSheet('Gebiet wählen', (body, close) => {
    const out = el('div', { class: 'panel-body', style: { padding: '0', maxHeight: '46vh' } });

    const radiusSel = el('select', {}, [1000, 2000, 3000, 5000, 10000, 20000, 50000].map((r) =>
      el('option', { value: String(r), selected: r === radius }, formatDistance(r, getState().settings.unit))));
    radiusSel.addEventListener('change', () => { radius = parseInt(radiusSel.value, 10); run(); });

    const search = el('input', { placeholder: 'Name filtern …' });
    search.addEventListener('input', () => { filter = search.value.trim().toLowerCase(); paint(); });

    function paint() {
      clear(out);
      const rows = found.filter((c) => !filter || c.name.toLowerCase().includes(filter));
      if (!rows.length) {
        out.append(el('div', { class: 'empty', text: found.length ? 'Kein Treffer für den Filter.' : 'Nichts gefunden – größeren Umkreis wählen.' }));
        return;
      }
      let tier = null;
      for (const c of rows) {
        if (c.tier !== tier) {
          tier = c.tier;
          out.append(el('div', { class: 'hint', style: { marginTop: '10px', fontWeight: '600' }, text: GROUPS[tier] || 'Weitere' }));
        }
        const inside = here.has(c.key);
        out.append(el('button', {
          class: 'card', style: { textAlign: 'left' },
          onclick: (ev) => choose(c, ev.currentTarget),
        },
          el('div', { class: 'card-title' },
            el('span', { class: 'grow', text: c.name }),
            inside ? el('span', { class: 'card-sub', text: 'hier' }) : null),
          el('div', { class: 'card-sub', text: `${c.kind} · ${formatDistance(c.distance, getState().settings.unit)}${c.hasGeometry ? '' : ' · ohne Umriss'}` })));
      }
    }

    async function choose(c, card) {
      if (!c.hasGeometry) { close(); circleForPlace(c, onPick); return; }
      card.style.opacity = '.5';
      try {
        const ring = await areaGeometry(c);
        close();
        onPick({ ring, name: c.name, level: c.kind });
        toast(`${c.name} geladen (${ring.length} Punkte)`, 'ok');
      } catch (e) {
        card.style.opacity = '';
        toast(String(e.message || e), 'error');
      }
    }

    async function run() {
      clear(out).append(busyBox('Frage OpenStreetMap …'));
      const [a, h] = await Promise.allSettled([findAreas(center, radius), areaKeysAt(center)]);
      if (a.status === 'rejected') { clear(out).append(netErrorBox(a.reason)); return; }
      found = a.value;
      here = h.status === 'fulfilled' ? h.value : new Set();
      paint();
    }

    body.append(
      el('div', { class: 'hint', text: 'Dörfer, Ortsteile und Stadtviertel stehen oben, größere Gebiete darunter.' }),
      el('label', { class: 'field' }, 'Umkreis', radiusSel),
      el('label', { class: 'field' }, 'Suchen', search),
      out,
    );
    run();

    return [el('button', { class: 'btn grow', onclick: () => close() }, 'Schließen')];
  });
}

// Kleine Orte stehen in OSM oft nur als Punkt ohne Umriss. Statt sie wegzulassen,
// wird daraus ein Kreis – für eine Frage nach „bist du in X?" reicht das meist.
function circleForPlace(c, onPick) {
  let radius = 800;
  openSheet(c.name, (body, close) => {
    body.append(
      el('div', { class: 'card-sub', text: `${c.kind} – in OpenStreetMap ohne Umriss hinterlegt. Als Kreis um den Ortsmittelpunkt verwenden?` }),
      el('label', { class: 'field' }, 'Radius',
        el('div', { class: 'pills' }, [300, 500, 800, 1200, 2000, 3000, 5000].map((r) => el('button', {
          class: `pill ${r === radius ? 'on' : ''}`,
          onclick: (ev) => {
            radius = r;
            ev.target.parentElement.querySelectorAll('.pill').forEach((p) => p.classList.remove('on'));
            ev.target.classList.add('on');
          },
        }, formatDistance(r, getState().settings.unit))))),
    );
    return [
      el('button', { class: 'btn grow', onclick: () => close() }, 'Abbrechen'),
      el('button', {
        class: 'btn grow btn-primary',
        onclick: () => {
          close();
          onPick({ ring: circle({ lat: c.lat, lng: c.lng }, radius, 64), name: c.name, level: `${c.kind} (Kreis)` });
        },
      }, 'Übernehmen'),
    ];
  });
}
