// Endgame: Die Sucher haben die Station erkannt. Ab hier gilt ein Radius um diese
// Haltestelle, und jeder Weg wird aufgezeichnet – wie bei Strava, nur dass zusätzlich
// jede Straße im Radius offen oder abgelaufen ist. So lässt sich das Gebiet
// systematisch absuchen, ohne Straßen doppelt oder gar nicht zu gehen.
//
// Leichte Angaben (Haltestelle, Radius, läuft/pausiert) stehen im Spielstand, die
// Spur und das Straßennetz in einem eigenen Speicherplatz: die ändern sich mit jedem
// GPS-Punkt, und der ganze Spielstand soll dafür nicht ständig neu geschrieben werden.

import { getState, update, uid, subscribe } from './state.js';
import * as Loc from './location.js';
import * as MapMod from './map.js';
import * as Rules from './rules.js';
import { loadStreets, findStopsNear } from './overpass.js';
import * as S from './streets.js';
import { wantAwake } from './wakelock.js';
import { formatDistance, destination } from './geo.js';
import { activeRound, currentPhase } from './phases.js';
import { markPhase } from './rounds.js';
import { NATIVE, nativeTracker, APK_URL } from './native.js';
import {
  el, clear, append, openSheet, confirmSheet, toast, icon, group, row, toggleSwitch, formatClock, formatTime,
} from './ui/ui.js';

const KEY = 'jetlag.endgame.v1';
const ORANGE = '#fc5a1c';
const NETZ_RAND_M = 80;   // Straßennetz etwas über die Zone hinaus laden, damit Wege zusammenhängen
const LUECKE_FANG_M = 60; // so weit darf ein Punkt nach einer Lücke von der nächsten Straße entfernt sein

let store = null;   // { id, track: [[{lat,lng,t,a}]], guessed: [[{lat,lng}]], ways, states }
let net = null;
let states = null;
let recording = false;
let newSegment = true;
let rejected = 0;
let layer = null;
let renderer = null;
let drawTimer = null;
let saveTimer = null;
let pocket = null;
let lastSave = 0;

export function meta() {
  return getState().endgame || null;
}

export function isActive() {
  return !!meta();
}

/* ---------- Speichern ---------- */

function loadStore() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  lastSave = Date.now();
  if (!store) {
    try { localStorage.removeItem(KEY); } catch (e) { /* egal */ }
    return;
  }
  if (states) store.states = S.encodeStates(states);
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch (e) {
    toast('Speicher voll – Aufzeichnung wird nicht gesichert', 'error');
  }
}

// Bei jedem GPS-Punkt zu schreiben kostet auf alten Geräten spürbar Akku
function saveSoon() {
  if (!saveTimer) saveTimer = setTimeout(saveNow, 10000);
}

/* ---------- Start und Ende ---------- */

export async function startEndgame(stop, radius, { record = true } = {}) {
  const now = Date.now();
  const id = uid('eg');
  const constraintId = uid('q');
  const vorher = meta();
  // Speicherplatz zuerst anlegen: sync() erkennt daran, dass das Endgame von hier stammt
  store = { id, track: [], guessed: [], ways: null, states: '' };
  versuche = 0;
  net = null;
  states = null;
  newSegment = true;
  saveNow();
  update((s) => {
    if (vorher) s.constraints = s.constraints.filter((c) => c.id !== vorher.constraintId);
    s.endgame = {
      id, constraintId, radius, startedAt: now, recording: record,
      stop: { lat: stop.lat, lng: stop.lng, name: stop.name || 'Haltestelle' },
    };
    s.constraints.push({
      id: constraintId, type: 'radius', origin: 'endgame', active: true, at: now,
      center: { lat: stop.lat, lng: stop.lng }, centerName: stop.name || 'Haltestelle', radius, inside: true,
    });
    s.game.log.push({ id: uid('lg'), at: now, kind: 'round', text: `Endgame an ${stop.name || 'Haltestelle'} (${formatDistance(radius)})` });
  }, 'Endgame gestartet');

  const r = activeRound();
  if (r && ['roundStart', 'hidingEnd', 'searchStart'].includes(currentPhase(r))) markPhase('endgame');

  setRecording(record);
  MapMod.render();
  fitZone();
  draw();
  document.dispatchEvent(new CustomEvent('jetlag:changed', { detail: { announceStats: true } }));
  await loadNet();
}

export async function endEndgame() {
  const m = meta();
  if (!m) return;
  const ok = await confirmSheet('Endgame beenden?',
    'Spur, Straßenstand und der Endgame-Radius werden entfernt. Wer die Spur behalten will, exportiert sie vorher als GPX.',
    { danger: true, okLabel: 'Beenden' });
  if (!ok) return;
  update((s) => {
    s.constraints = s.constraints.filter((c) => c.id !== m.constraintId);
    s.endgame = null;
    s.game.log.push({ id: uid('lg'), at: Date.now(), kind: 'round', text: `Endgame beendet: ${m.stop.name}` });
  }, 'Endgame beendet');
  sync();
  MapMod.render();
  document.dispatchEvent(new CustomEvent('jetlag:changed'));
}

// Spielstand und Speicherplatz zusammenhalten – auch nach Rückgängig, Import oder
// Zurücksetzen, die den Spielstand von außen ändern.
function sync() {
  const m = meta();
  if (!m) {
    if (store) { store = null; net = null; states = null; saveNow(); }
    if (recording) applyRecording(false);
    exitPocket();
    clearDraw();
    updateChip();
    return;
  }
  if (!store || store.id !== m.id) {
    const saved = loadStore();
    const eigenes = saved && saved.id === m.id;
    store = eigenes ? saved : { id: m.id, track: [], guessed: [], ways: null, states: '' };
    rebuildNet();
    newSegment = true;
    // Nach Rückgängig oder Import fehlt das Netz – nachladen
    if (!store.ways) setTimeout(() => loadNet().catch(() => {}), 0);
    // Von einem anderen Handy übernommen oder zurückgeholt: GPS und Display-Sperre
    // nicht ungefragt starten
    if (!eigenes && m.recording) {
      setTimeout(() => update((s) => { if (s.endgame && s.endgame.id === m.id) s.endgame.recording = false; }), 0);
      drawSoon(0);
      updateChip();
      return;
    }
  }
  if (!!m.recording !== recording) applyRecording(!!m.recording);
  drawSoon(0);
  updateChip();
}

export function initEndgame() {
  Loc.onFix(onFix);
  subscribe(() => {
    const m = meta();
    if ((m ? m.id : null) !== (store ? store.id : null) || (m && !!m.recording !== recording)) sync();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') saveNow();
  });
  window.addEventListener('pagehide', saveNow);
  sync();
}

/* ---------- Straßennetz ---------- */

function rebuildNet() {
  const m = meta();
  if (!store || !store.ways || !m) { net = null; states = null; return; }
  net = S.buildNetwork(store.ways, { origin: m.stop });
  states = S.decodeStates(store.states, net.pieces.length);
  // Passt der gespeicherte Stand nicht zum Netz, aus der Spur neu rechnen
  if (store.states.length !== net.pieces.length) recompute();
}

// Läuft schon eine Abfrage, wird keine zweite gestartet
let netLaden = null;

export function loadNet() {
  if (!netLaden) netLaden = ladeNetz().finally(() => { netLaden = null; });
  return netLaden;
}

// Overpass ist geteilte Infrastruktur und antwortet nicht immer; im Funkloch schon gar
// nicht. Deshalb ein paar ruhige Wiederholungen, statt den Nutzer drücken zu lassen.
const WIEDERHOLUNG_MS = [20000, 60000, 180000];
let versuche = 0;
let wiederholung = null;

async function ladeNetz() {
  const m = meta();
  if (!m) return;
  clearTimeout(wiederholung);
  updateChip('Straßen laden …');
  try {
    const ways = await loadStreets(m.stop, m.radius + NETZ_RAND_M);
    if (!store || store.id !== m.id) { updateChip(); return; }
    store.ways = ways;
    store.states = '';
    rebuildNet();
    saveNow();
    drawSoon(0);
    versuche = 0;
    const c = stats();
    toast(`${ways.length} Wege geladen · ${formatDistance(c.total)} Straße in der Zone`, 'ok');
  } catch (e) {
    const pause = WIEDERHOLUNG_MS[versuche++];
    toast(`Straßennetz nicht geladen: ${e.message || e}. `
      + (pause ? `Neuer Versuch in ${Math.round(pause / 1000)} s – die Aufzeichnung läuft weiter.` : 'Die Aufzeichnung läuft weiter.'), 'error');
    if (pause) {
      wiederholung = setTimeout(() => {
        const jetzt = meta();
        if (jetzt && jetzt.id === m.id && store && !store.ways) loadNet().catch(() => {});
      }, pause);
    }
  }
  updateChip();
}

// Nach geänderter Erfassungsbreite oder neuem Netz alles aus der Spur neu ableiten
export function recompute() {
  if (!net || !store) return;
  states = S.emptyStates(net);
  const breite = widthM();
  for (const seg of store.track) S.markTrack(net, states, seg, breite);
  // Geschätzte Wege liegen genau auf Knoten des Netzes – schmal markieren, sonst
  // färbten sich an jeder Kreuzung die Querstraßen mit
  for (const path of store.guessed) S.markTrack(net, states, path, 2, S.GUESSED);
  saveSoon();
  drawSoon(0);
  updateChip();
}

function widthM() {
  return getState().settings.trackWidthM || 20;
}

/* ---------- Aufzeichnung ---------- */

export function setRecording(on) {
  if (!meta()) return;
  applyRecording(on);
  update((s) => { if (s.endgame) s.endgame.recording = on; });
  updateChip();
}

function applyRecording(on) {
  recording = on;
  if (on) {
    newSegment = true;
    // Der Android-Dienst liefert ab dem letzten gesicherten Punkt nach – auch Punkte aus
    // der Zeit, in der die App geschlossen war
    Loc.setNativeCursor(lastPointTime() || (meta() ? meta().startedAt : Date.now()));
  }
  Loc.keepAlive('endgame', on);
  // Im Browser ortet nur eine sichtbare Seite – in der Android-App darf das Display aus
  wantAwake('endgame', on && !NATIVE);
  if (!on) saveNow();
}

function lastPointTime() {
  const seg = store && store.track[store.track.length - 1];
  const p = seg && seg[seg.length - 1];
  return p ? p.t : 0;
}

function onFix(fix) {
  if (!recording || !store) return;
  const p = { lat: +fix.lat.toFixed(6), lng: +fix.lng.toFixed(6), t: fix.timestamp || Date.now(), a: fix.accuracy != null ? Math.round(fix.accuracy) : null };
  const seg = store.track[store.track.length - 1];
  const last = seg ? seg[seg.length - 1] : null;
  const action = S.classifyFix(newSegment ? null : last, { ...p, accuracy: p.a }, { rejected });

  if (action === 'skip') return;
  if (action === 'jump') { rejected++; return; }
  rejected = 0;

  if (newSegment || action === 'gap' || !seg) {
    if (action === 'gap' && last && getState().settings.trackFillGaps !== false) fillGap(last, p);
    store.track.push([p]);
    newSegment = false;
    if (net) S.markWalked(net, states, p, p, widthM());
  } else {
    seg.push(p);
    if (net) S.markWalked(net, states, last, p, widthM());
  }
  // Im Hintergrund laufen Zeitgeber nur noch sporadisch: dann direkt sichern, höchstens
  // alle 30 Sekunden
  if (document.visibilityState !== 'visible' && Date.now() - lastSave > 30000) saveNow();
  else saveSoon();
  drawSoon();
  updateChip();
}

// Der Bildschirm war aus, und der Browser hat nicht geortet. Wahrscheinlichster Weg
// zwischen den beiden Punkten ist der kürzeste übers Straßennetz – markiert als
// "vermutlich", nie als sicher abgelaufen.
function fillGap(a, b) {
  if (!net) return;
  const path = S.shortestPath(net, a, b, { snapM: LUECKE_FANG_M });
  if (!path) return;
  const luftlinie = S.metersBetween(a, b);
  if (path.length > Math.max(3 * luftlinie, luftlinie + 400)) return;
  const pts = [{ lat: a.lat, lng: a.lng }, ...path.points, { lat: b.lat, lng: b.lng }];
  store.guessed.push(pts);
  S.markGuessed(net, states, path.edges);
}

export function stats() {
  const m = meta();
  const track = store ? S.trackLength(store.track) : 0;
  if (!m || !net) return { total: 0, walked: 0, guessed: 0, fraction: 0, track, loaded: false };
  return { ...S.coverage(net, states, m.stop, m.radius), track, loaded: true };
}

/* ---------- GPX ---------- */

export function exportGpx() {
  if (!store || !store.track.length) return toast('Noch keine Spur aufgezeichnet', 'error');
  const m = meta();
  const name = `Endgame ${m ? m.stop.name : ''} ${new Date().toLocaleDateString('de-DE')}`.trim();
  const blob = new Blob([S.toGpx(store.track, name)], { type: 'application/gpx+xml' });
  const file = `endgame-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.gpx`;
  try {
    const f = new File([blob], file, { type: 'application/gpx+xml' });
    if (navigator.canShare && navigator.canShare({ files: [f] })) {
      navigator.share({ files: [f], title: name }).catch(() => {});
      return;
    }
  } catch (e) { /* weiter mit Download */ }
  const a = el('a', { href: URL.createObjectURL(blob), download: file });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// Spur aus einer anderen App übernehmen: Tracking-Apps zeichnen auch bei
// ausgeschaltetem Bildschirm auf, ein Browser kann das nicht. Ebenso lässt sich die
// Spur eines Mitspielers übernehmen.
export function importGpx() {
  const input = el('input', { type: 'file', accept: '.gpx,application/gpx+xml,application/xml,text/xml' });
  input.addEventListener('change', async () => {
    const f = input.files[0];
    if (!f || !store) return;
    try {
      const segs = S.parseGpx(await f.text());
      const start = meta().startedAt - 10 * 60000;
      let punkte = 0;
      for (const seg of segs) {
        // Ältere Punkte gehören nicht zu diesem Endgame
        const pts = seg.filter((p) => p.t == null || p.t >= start)
          .map((p) => ({ lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6), t: p.t || Date.now(), a: null }));
        if (!pts.length) continue;
        store.track.push(pts);
        punkte += pts.length;
        if (net) S.markTrack(net, states, pts, widthM());
      }
      newSegment = true;
      saveNow();
      drawSoon(0);
      updateChip();
      toast(punkte ? `${punkte} Punkte aus ${f.name} übernommen` : 'Keine passenden Punkte in der Datei', punkte ? 'ok' : 'error');
    } catch (e) {
      toast(`Nicht lesbar: ${e.message || e}`, 'error');
    }
  });
  input.click();
}

/* ---------- Karte ---------- */

function fitZone() {
  const m = meta();
  const map = MapMod.getMap();
  if (!m || !map) return;
  const n = destination(m.stop, 0, m.radius * 1.1), s = destination(m.stop, 180, m.radius * 1.1);
  const e = destination(m.stop, 90, m.radius * 1.1), w = destination(m.stop, 270, m.radius * 1.1);
  MapMod.setFollow(false);
  map.fitBounds([[s.lat, w.lng], [n.lat, e.lng]], { padding: [20, 20] });
}

function clearDraw() {
  if (layer) layer.clearLayers();
}

// Beim Aufzeichnen höchstens alle zwei Sekunden neu zeichnen – das Netz hat
// tausende Stücke, und GPS liefert jede Sekunde.
function drawSoon(delay = 2000) {
  if (drawTimer && delay) return;
  clearTimeout(drawTimer);
  drawTimer = setTimeout(() => { drawTimer = null; draw(); }, delay);
}

function draw() {
  const map = MapMod.getMap();
  if (!map) return;
  if (!layer) {
    renderer = L.canvas({ padding: 0.4 });
    layer = L.layerGroup().addTo(map);
  }
  layer.clearLayers();
  const m = meta();
  if (!m || pocket) return;

  L.circle([m.stop.lat, m.stop.lng], {
    radius: m.radius, color: ORANGE, weight: 1.5, dashArray: '6 6', fill: false, interactive: false, renderer,
  }).addTo(layer);

  if (net) {
    // Etwas über den Rand hinaus zeichnen, damit Straßen nicht abrupt am Kreis enden
    const lines = S.linesByState(net, states, m.stop, m.radius + 25);
    if (lines[S.OPEN].length) {
      // Dunkel statt weiß: auf den hellen Straßen der Kartenkacheln wäre Weiß unsichtbar
      L.polyline(lines[S.OPEN], { color: '#475569', weight: 3, opacity: 0.75, interactive: false, renderer }).addTo(layer);
    }
    if (lines[S.GUESSED].length) {
      L.polyline(lines[S.GUESSED], { color: ORANGE, weight: 4, opacity: 0.6, dashArray: '5 6', interactive: false, renderer }).addTo(layer);
    }
    if (lines[S.WALKED].length) {
      L.polyline(lines[S.WALKED], { color: ORANGE, weight: 5, opacity: 0.9, interactive: false, renderer }).addTo(layer);
    }
  }
  if (store && store.track.length) {
    L.polyline(store.track.map((seg) => seg.map((p) => [p.lat, p.lng])), {
      color: '#7c2d12', weight: 1.75, opacity: 0.9, interactive: false, renderer,
    }).addTo(layer);
  }
  L.circleMarker([m.stop.lat, m.stop.lng], {
    radius: 6, color: ORANGE, weight: 2.5, fillColor: '#ffffff', fillOpacity: 1, interactive: false, renderer,
  }).addTo(layer).bindTooltip(m.stop.name, { permanent: true, direction: 'top', offset: [0, -6], className: 'jl-label' });
}

/* ---------- Anzeige ---------- */

function pct(f) {
  return `${Math.round(f * 100)} %`;
}

export function summary() {
  const m = meta();
  if (!m) return null;
  const st = stats();
  return {
    title: m.stop.name,
    line: st.loaded ? `${pct(st.fraction)} der Straßen` : 'Straßennetz fehlt',
    track: formatDistance(st.track),
    recording,
    st,
  };
}

function updateChip(override) {
  const chip = document.getElementById('stat-endgame');
  if (!chip) return;
  const sum = summary();
  chip.hidden = !sum;
  if (!sum) return;
  chip.classList.toggle('rec', recording);
  chip.querySelector('b').textContent = override || (sum.st.loaded ? pct(sum.st.fraction) : 'Endgame');
  chip.querySelector('span').textContent = recording ? `Aufzeichnung · ${sum.track}` : `pausiert · ${sum.track}`;
  if (pocket) paintPocket();
}

/* ---------- Bedienung ---------- */

// Lange auf eine Haltestelle gedrückt: Radius vorschlagen und starten
export function openStartSheet(stop) {
  const vorgabe = Rules.hidingZoneRadius() || 400;
  const werte = [...new Set([150, 250, 300, 400, 500, 800, vorgabe])].sort((a, b) => a - b);
  let radius = vorgabe;
  let record = true;
  const laufend = meta();

  openSheet('Endgame starten', (body, close) => {
    const pills = el('div', { class: 'pills' });
    const paint = () => {
      clear(pills);
      for (const w of werte) {
        pills.append(el('button', {
          class: `pill ${w === radius ? 'on' : ''}`,
          onclick: () => { radius = w; paint(); },
        }, formatDistance(w) + (w === vorgabe ? ' · Regel' : '')));
      }
    };
    paint();
    append(body,
      el('div', { class: 'endgame-stop' },
        icon('endgame'),
        el('div', {},
          el('div', { class: 'row-title', text: stop.name || 'Haltestelle' }),
          el('div', { class: 'row-sub', text: [stop.kindLabel, stop.distance != null ? `${formatDistance(stop.distance)} vom angetippten Punkt` : null].filter(Boolean).join(' · ') }))),
      el('label', { class: 'field' }, 'Radius um die Haltestelle', pills),
      el('div', { class: 'list' },
        row({ icon: 'rec', title: 'Wege aufzeichnen', sub: 'Abgelaufene Straßen werden orange', control: toggleSwitch(record, (v) => { record = v; }) })),
      el('div', { class: 'hint', text: 'Alles außerhalb des Radius wird abgedunkelt. Die Straßen im Radius lädt die App einmal aus OpenStreetMap.' }),
      laufend ? el('div', { class: 'hint warn', text: `Das laufende Endgame an ${laufend.stop.name} wird dabei ersetzt.` }) : null,
    );
    return [
      el('button', { class: 'btn grow', onclick: () => close() }, 'Abbrechen'),
      el('button', {
        class: 'btn grow btn-primary',
        onclick: () => { close(); startEndgame(stop, radius, { record }); },
      }, 'Endgame starten'),
    ];
  });
}

// Ohne Karte: Haltestellen um die eigene Position anbieten
export function openStopPicker(center = Loc.current()) {
  if (!center) return toast('Erst eine Position – GPS oder Punkt auf der Karte', 'error');
  openSheet('An welcher Haltestelle?', (body, close) => {
    const out = el('div', { class: 'list' }, row({ icon: 'search', title: 'Suche Haltestellen …' }));
    body.append(
      el('div', { class: 'hint', text: 'Oder auf der Karte lange auf die Haltestelle drücken.' }),
      out);
    (async () => {
      try {
        let found = [];
        for (const r of [300, 800, 2000]) {
          found = await findStopsNear(center, r);
          if (found.length >= 3) break;
        }
        clear(out);
        if (!found.length) { out.append(row({ title: 'Keine Haltestellen gefunden' })); return; }
        for (const p of found.slice(0, 8)) {
          out.append(row({
            icon: stopIcon(p.kind), title: p.name, sub: [p.kindLabel, formatDistance(p.distance)].filter(Boolean).join(' · '),
            onClick: () => { close(); openStartSheet(p); },
          }));
        }
      } catch (e) {
        clear(out).append(row({ title: String(e.message || e) }));
      }
    })();
    return [el('button', { class: 'btn grow', onclick: () => close() }, 'Abbrechen')];
  });
}

export function stopIcon(kind) {
  return kind === 'bus' ? 'bus' : kind === 'tram_subway' ? 'tram' : 'train';
}

export function openEndgameSheet() {
  const m = meta();
  if (!m) return openStopPicker();
  openSheet('Endgame', (body, close) => {
    const st = stats();
    // Android: Manche Hersteller beenden Hintergrunddienste trotz Benachrichtigung, solange
    // die App der Akku-Optimierung unterliegt
    const akkuZeile = NATIVE ? row({ icon: 'battery', title: 'Akku-Optimierung', value: '…' }) : null;
    if (akkuZeile) {
      nativeTracker().status().then((s) => {
        const wert = akkuZeile.querySelector('.row-value');
        if (wert) wert.textContent = s.batteryOptimized ? 'an' : 'aus';
        const sub = el('div', { class: 'row-sub', text: s.batteryOptimized
          ? 'Tippen und „Zulassen“ wählen – sonst kann Android die Aufzeichnung beenden'
          : 'Die Aufzeichnung darf im Hintergrund weiterlaufen' });
        akkuZeile.querySelector('.row-title')?.after(sub);
        if (s.batteryOptimized) akkuZeile.addEventListener('click', () => { nativeTracker().requestBatteryExemption(); close(); });
      }).catch(() => {});
    }
    const km = (x) => formatDistance(x);
    append(body,
      el('div', { class: 'endgame-hero' },
        el('div', { class: 'endgame-pct', text: st.loaded ? pct(st.fraction) : '–' }),
        el('div', { class: 'row-sub', text: st.loaded
          ? `${km(st.walked + st.guessed)} von ${km(st.total)} Straße im Radius abgelaufen`
          : 'Straßennetz noch nicht geladen' }),
        el('div', { class: 'progress' },
          el('i', { style: { width: `${Math.round((st.total ? st.walked / st.total : 0) * 100)}%`, background: ORANGE } }),
          el('i', { class: 'guess', style: { width: `${Math.round((st.total ? st.guessed / st.total : 0) * 100)}%` } }))),
      group('Zone',
        row({ icon: 'endgame', title: m.stop.name, sub: `${km(m.radius)} Radius · seit ${formatTime(m.startedAt)}` }),
        row({ icon: 'map', title: 'Auf der Karte zeigen', onClick: () => { close(); goMap(); fitZone(); } }),
        row({ icon: 'refresh', title: 'Straßennetz neu laden', onClick: () => { close(); loadNet(); } })),
      group('Aufzeichnung',
        row({
          icon: 'rec', title: 'Wege aufzeichnen', sub: `${km(st.track)} gelaufen${st.guessed ? ` · ${km(st.guessed)} geschätzt` : ''}`,
          control: toggleSwitch(recording, (v) => setRecording(v)),
        }),
        NATIVE ? akkuZeile : row({ icon: 'pocket', title: 'Taschenmodus', sub: 'Schwarzer Bildschirm, Aufzeichnung läuft weiter', onClick: () => { close(); enterPocket(); } }),
        row({ icon: 'fileUp', title: 'GPX importieren', sub: 'Spur einer Tracking-App oder eines Mitspielers', onClick: () => importGpx() }),
        row({ icon: 'fileDown', title: 'GPX exportieren', onClick: () => exportGpx() })),
      el('div', { class: 'hint', text: NATIVE
        ? 'Die Aufzeichnung läuft als Android-Dienst – auch bei gesperrtem Bildschirm, in einer anderen App oder wenn die App geschlossen ist. Solange sie läuft, steht „Endgame-Aufzeichnung läuft“ in der Benachrichtigungsleiste.'
        : 'Bei ausgeschaltetem Bildschirm ortet kein Browser. Lücken schließt die App über den kürzesten Weg im Straßennetz (gestrichelt). Lückenlos geht es mit dem Taschenmodus, der Android-App oder einer Tracking-App plus GPX-Import.' }),
      NATIVE ? null : group(null, row({
        icon: 'download', title: 'Android-App', sub: 'Zeichnet auch bei gesperrtem Bildschirm auf',
        onClick: () => window.open(APK_URL, '_blank'),
      })),
      group(null, row({ icon: 'stop', title: 'Endgame beenden', danger: true, onClick: () => { close(); endEndgame(); } })),
    );
    return [];
  });
}

function goMap() {
  document.querySelector('.tabbar [data-go="map"]').click();
}

/* ---------- Taschenmodus ---------- */
// Der Bildschirm bleibt an, zeigt aber nur Schwarz: auf OLED-Displays kostet das kaum
// Strom, und der Browser ortet weiter, weil die Seite sichtbar bleibt. Berührungen in
// der Hosentasche fängt die Fläche ab; entsperrt wird durch langes Drücken.

export function enterPocket() {
  if (pocket) return;
  if (!recording) setRecording(true);
  const meter = el('div', { class: 'pocket-ring' });
  const text = el('div', { class: 'pocket-text' });
  const sub = el('div', { class: 'pocket-sub' });
  const node = el('div', { class: 'pocket', role: 'dialog', 'aria-label': 'Taschenmodus' },
    el('div', { class: 'pocket-body' }, text, sub),
    el('div', { class: 'pocket-unlock' }, meter, el('div', { class: 'pocket-sub', text: 'Zum Entsperren gedrückt halten' })));
  document.body.append(node);
  pocket = { node, text, sub, meter, hold: null, tick: setInterval(paintPocket, 15000) };
  wantAwake('pocket', true);
  MapMod.setSuspended(true);
  setThemeColor('#000000');
  paintPocket();

  const start = (e) => {
    e.preventDefault();
    meter.classList.add('holding');
    pocket.hold = setTimeout(exitPocket, 900);
  };
  const stop = () => {
    meter.classList.remove('holding');
    if (pocket) clearTimeout(pocket.hold);
  };
  meter.addEventListener('pointerdown', start);
  meter.addEventListener('pointerup', stop);
  meter.addEventListener('pointerleave', stop);
  meter.addEventListener('pointercancel', stop);
  node.addEventListener('contextmenu', (e) => e.preventDefault());
}

function paintPocket() {
  if (!pocket) return;
  const sum = summary();
  pocket.text.textContent = recording ? 'Aufzeichnung läuft' : 'Aufzeichnung pausiert';
  pocket.sub.textContent = sum ? `${sum.track} · ${sum.line}` : '';
}

export function exitPocket() {
  if (!pocket) return;
  clearInterval(pocket.tick);
  clearTimeout(pocket.hold);
  pocket.node.remove();
  pocket = null;
  wantAwake('pocket', false);
  MapMod.setSuspended(false);
  setThemeColor(null);
  draw();
}

function setThemeColor(color) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  if (!meta.dataset.base) meta.dataset.base = meta.getAttribute('content');
  meta.setAttribute('content', color || meta.dataset.base);
}

// Nur für die Statusanzeige anderer Module
export function formatElapsed() {
  const m = meta();
  return m ? formatClock(Date.now() - m.startedAt, { withHours: true }) : '';
}
