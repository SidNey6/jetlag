// Start und Verdrahtung: Tabs, Kartenknöpfe, Service Worker, geteilte Links.

import { getState, load, update, undo, undoLabel, powerSaving } from './state.js';
import * as MapMod from './map.js';
import * as Loc from './location.js';
import * as C from './constraints.js';
import * as Compute from './compute.js';
import * as Q from './questions.js';
import * as Timers from './timers.js';
import * as Rounds from './rounds.js';
import * as More from './more.js';
import { consumeHash } from './share.js';
import * as Rules from './rules.js';
import * as Zone from './zone.js';
import * as Endgame from './endgame.js';
import { findStopsNear } from './overpass.js';
import { initBundle } from './bundle.js';
import { initRegions } from './region.js';
import { el, clear, openSheet, promptSheet, toast, icon, row } from './ui/ui.js';
import { formatDistance, distance, bearing, formatBearing } from './geo.js';

window.__JL_VERSION__ = 'v1.9.1';

const PANELS = {
  map: 'panel-map', questions: 'panel-questions', timers: 'panel-timers',
  game: 'panel-game', more: 'panel-more',
};

function showTab(name) {
  // Nochmal auf "Mehr" tippen führt zurück zur Übersicht
  if (name === 'more' && getState().ui.tab === 'more') More.resetPage();
  for (const [key, id] of Object.entries(PANELS)) {
    document.getElementById(id).hidden = key !== name;
  }
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.go === name));
  update((s) => { s.ui.tab = name; });
  // Kopfzeile mitziehen: Restgebiet und Zähler hingen sonst am letzten Ereignis fest
  refreshStats();
  refreshUndo();
  refreshQuestionBadge();
  if (name === 'map') MapMod.invalidate();
  if (name === 'questions') Q.renderConstraintList();
  if (name === 'timers') Timers.renderTimers();
  if (name === 'game') Rounds.render();
  if (name === 'more') More.render();
}

/* ---------- Restgebiet-Anzeige ---------- */

let statsTimer = null;
let statsZug = 0;

// Restfläche im Hintergrund-Thread (compute.js); dort auch gemerkt – ein Tabwechsel
// allein ist kein Grund für 4000 neue Stichproben.
function refreshStats(announce = false) {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => {
    const s = getState();
    const chip = document.getElementById('stat-remaining');
    const active = s.constraints.filter((c) => c.active !== false);
    if (!s.area || !active.length) { chip.hidden = true; return; }
    const zug = ++statsZug;
    const sparsam = powerSaving();
    const b = chip.querySelector('b');
    if (chip.hidden) { chip.hidden = false; b.textContent = '…'; }
    Compute.remaining(s.area, active, sparsam ? 2000 : 4000, sparsam ? 2 : 3).then((st) => {
      if (zug !== statsZug) return; // inzwischen neue Lage
      const label = C.formatFraction(st);
      chip.hidden = label == null;
      if (label == null) return;
      b.textContent = label;
      b.style.color = st.remaining === 0 ? 'var(--danger)' : '';
      if (announce) {
        toast(st.remaining === 0 ? 'Kein Gebiet mehr übrig – widersprechen sich zwei Antworten?' : `Restgebiet: ${label}`,
          st.remaining === 0 ? 'error' : 'ok');
      }
    });
  }, 120);
}

function refreshUndo() {
  const btn = document.getElementById('btn-undo');
  btn.hidden = !undoLabel();
  btn.title = undoLabel() || '';
}

/* ---------- Menü für einen Kartenpunkt ---------- */

// Langes Drücken auf die Karte. Liegt dort eine Haltestelle, steht ganz oben der
// Endgame-Start: genau dann, wenn man die Station des Versteckenden erkannt hat.
function pointMenu(p) {
  const me = Loc.current();
  openSheet('Punkt auf der Karte', (body, close) => {
    body.append(el('div', { class: 'coords' },
      `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`,
      me ? ` · ${formatDistance(distance(me, p))} ${formatBearing(bearing(me, p))} von dir` : ''));

    // Die Suche kann bei ausgelastetem Overpass dauern; "hier starten" geht sofort
    const searching = row({ icon: 'search', title: 'Suche Haltestellen hier …' });
    const stops = el('div', { class: 'list' }, searching,
      row({
        icon: 'endgame', title: 'Endgame an diesem Punkt', sub: 'Wenn die Haltestelle genau hier liegt',
        onClick: () => { close(); Endgame.openStartSheet({ lat: p.lat, lng: p.lng, name: 'Haltestelle', distance: 0 }); },
      }));
    body.append(el('section', { class: 'group' }, el('div', { class: 'group-title', text: 'Endgame' }), stops));
    findStops(p).then((found) => {
      if (!found.length) {
        searching.replaceWith(row({ icon: 'search', title: 'Keine Haltestelle in der Nähe' }));
        return;
      }
      searching.replaceWith(...found.slice(0, 3).map((st) => row({
        icon: Endgame.stopIcon(st.kind), title: `Endgame an ${st.name}`,
        sub: [st.kindLabel, `${formatDistance(st.distance)} entfernt`].filter(Boolean).join(' · '),
        onClick: () => { close(); Endgame.openStartSheet(st); },
      })));
    }).catch((e) => searching.replaceWith(row({ icon: 'info', title: 'Haltestellen nicht ladbar', sub: String(e.message || e) })));

    const action = (ic, title, fn, sub) => row({ icon: ic, title, sub, onClick: () => { close(); fn(); } });
    body.append(el('div', { class: 'list' },
      action('pin', 'Marker setzen', async () => {
        const name = await promptSheet('Marker', { label: 'Name', placeholder: 'Verdachtspunkt' });
        MapMod.addMarkerAt(p, name || 'Marker');
      }),
      action('crosshair', 'Als meine Position setzen', () => { Loc.setManual(p); MapMod.render(); toast('Position manuell gesetzt'); syncLocButtons(); }),
      action('radius', 'Radius-Frage von hier', () => Q.openQuestionForm('radius', null, { at: p })),
      action('layers', 'Spielgebiet festlegen', () => More.openAreaSheet()),
      action('zone', 'Versteckzone hier', () => Zone.setHidingZone(p), zoneLabel()),
      action('mapPinned', 'Versteckpunkt hier', () => Zone.setHidingSpot(p)),
      action('copy', 'Koordinaten kopieren', async () => {
        try { await navigator.clipboard.writeText(`${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`); toast('Kopiert', 'ok'); }
        catch (e) { toast('Kopieren nicht erlaubt', 'error'); }
      })));
    return [];
  });
}

// Fangradius nach Zoomstufe: etwa ein Fingerbreit auf dem Bildschirm
function findStops(p) {
  const map = MapMod.getMap();
  const mProPixel = 156543.03 * Math.cos(p.lat * Math.PI / 180) / 2 ** map.getZoom();
  const radius = Math.max(40, Math.min(250, mProPixel * 48));
  return findStopsNear(p, radius);
}

function zoneLabel() {
  const r = Rules.hidingZoneRadius();
  return r ? Zone.zoneSummary(r) : null;
}

function syncLocButtons() {
  document.getElementById('btn-freeze').classList.toggle('on', Loc.isOverridden());
  document.getElementById('btn-follow').classList.toggle('on', MapMod.isFollowing());
}

/* ---------- Service Worker ---------- */

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    // Ein Update aus einem früheren Öffnen wartet schon (iOS beendet installierte Apps
    // selten ganz) – dann gleich anbieten, statt bei der alten Version zu bleiben
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateToast(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) showUpdateToast(sw);
      });
    });
  } catch (e) {
    console.warn('Service Worker nicht registriert', e);
  }
}

function showUpdateToast(sw) {
  const root = document.getElementById('toast-root');
  const t = el('div', { class: 'toast' },
    icon('refresh'), 'Neue Version verfügbar',
    el('button', {
      class: 'btn btn-small btn-primary', style: { marginLeft: '6px' },
      onclick: () => { sw.postMessage({ type: 'SKIP_WAITING' }); location.reload(); },
    }, 'Neu laden'));
  root.append(t);
}

// Symbole in die statische Oberfläche einsetzen (data-icon im HTML)
function placeIcons() {
  document.querySelectorAll('[data-icon]').forEach((n) => n.prepend(icon(n.dataset.icon)));
}

/* ---------- Start ---------- */

function boot() {
  load();
  placeIcons();
  MapMod.initMap();
  MapMod.setPointMenuHandler(pointMenu);
  Loc.start();
  Timers.startEngine();

  document.querySelectorAll('.tabbar button').forEach((b) => {
    b.addEventListener('click', () => showTab(b.dataset.go));
  });

  document.getElementById('btn-ask').addEventListener('click', () => Q.openQuestionPicker());
  document.getElementById('btn-ask-2').addEventListener('click', () => Q.openQuestionPicker());
  document.getElementById('btn-new-timer').addEventListener('click', () => Timers.openNewTimerSheet());
  document.getElementById('stat-endgame').addEventListener('click', () => Endgame.openEndgameSheet());

  document.getElementById('btn-follow').addEventListener('click', () => {
    MapMod.setFollow(!MapMod.isFollowing());
    syncLocButtons();
  });
  document.getElementById('btn-freeze').addEventListener('click', () => {
    if (Loc.isOverridden()) { Loc.release(); toast('Position folgt wieder dem GPS'); }
    else if (Loc.freeze()) toast('Position eingefroren');
    else toast('Noch keine Position', 'error');
    syncLocButtons();
    MapMod.render();
  });
  document.getElementById('btn-measure').addEventListener('click', () => MapMod.toggleMeasure());
  document.getElementById('btn-mask').addEventListener('click', () => {
    update((s) => { s.ui.showMask = s.ui.showMask === false; });
    document.getElementById('btn-mask').classList.toggle('on', getState().ui.showMask !== false);
    MapMod.render();
  });
  document.getElementById('btn-layers').addEventListener('click', () => More.openAreaSheet());
  document.getElementById('btn-undo').addEventListener('click', () => {
    const label = undo();
    if (label) toast(`Rückgängig: ${label}`);
    MapMod.render();
    rerenderActive();
  });

  document.addEventListener('jetlag:changed', (e) => { MapMod.render(); rerenderActive(e.detail?.announceStats); });
  document.addEventListener('click', () => Timers.primeAudio(), { once: true });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.__JL_INSTALL_PROMPT__ = e;
  });

  Loc.setAccuracyMode(getState().settings.gpsAccuracy || 'high');

  // Offline-Vorrat und vorgebaute Regionen kennen, bevor die erste Abfrage losläuft
  initBundle().catch(() => {});
  initRegions().catch(() => {});
  Endgame.initEndgame();

  // Regelwerk nachladen; die Oberfläche läuft auch an, bevor es da ist
  Rules.loadRules()
    .then(() => rerenderActive())
    .catch((e) => toast(`Regelwerk nicht ladbar: ${e.message || e}`, 'error'));

  MapMod.render();
  showTab(getState().ui.tab || 'map');
  document.getElementById('btn-mask').classList.toggle('on', getState().ui.showMask !== false);
  syncLocButtons();
  rerenderActive();

  registerSW();
  consumeHash();

  // Erstbesuch: kurz erklären, was zuerst zu tun ist
  if (!getState().area && !getState().constraints.length) {
    setTimeout(welcome, 700);
  }
}

function refreshQuestionBadge() {
  const badge = document.getElementById('badge-questions');
  const n = getState().constraints.filter((c) => c.active !== false).length;
  badge.hidden = n === 0;
  badge.textContent = String(n);
}

function rerenderActive(announceStats = false) {
  refreshStats(announceStats);
  refreshUndo();
  refreshQuestionBadge();
  const tab = getState().ui.tab;
  if (tab === 'questions') Q.renderConstraintList();
  if (tab === 'timers') Timers.renderTimers();
  if (tab === 'game') Rounds.render();
  if (tab === 'more') More.render();
}

function welcome() {
  if (sessionStorage.getItem('jl.welcomed')) return;
  sessionStorage.setItem('jl.welcomed', '1');
  openSheet('Willkommen', (body, close) => {
    body.append(
      el('div', { class: 'card-sub', text: 'Der Werkzeugkasten für Verstecken-und-Suchen-Runden. In dieser Reihenfolge fängt man an:' }),
      el('ol', { style: { paddingLeft: '20px', margin: '4px 0', lineHeight: '1.7' } },
        el('li', { html: '<b>Spielgebiet</b> festlegen (Mehr → Spielgebiet) – nur damit gibt es eine Restflächen-Anzeige.' }),
        el('li', { html: 'Jede beantwortete Frage über <b>Frage auswerten</b> eintragen.' }),
        el('li', { html: 'Die Karte dunkelt sofort alles ab, was nicht mehr in Frage kommt.' })),
      el('div', { class: 'hint', text: 'Langes Tippen auf die Karte öffnet das Punktmenü.' }),
    );
    return [
      el('button', { class: 'btn grow', onclick: () => close() }, 'Später'),
      el('button', { class: 'btn grow btn-primary', onclick: () => { close(); More.openAreaSheet(); } }, 'Spielgebiet festlegen'),
    ];
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
