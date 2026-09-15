// Start und Verdrahtung: Tabs, Kartenknöpfe, Service Worker, geteilte Links.

import { getState, load, update, undo, undoLabel } from './state.js';
import * as MapMod from './map.js';
import * as Loc from './location.js';
import * as C from './constraints.js';
import * as Q from './questions.js';
import * as Timers from './timers.js';
import * as Rounds from './rounds.js';
import * as More from './more.js';
import { consumeHash } from './share.js';
import { el, openSheet, promptSheet, toast } from './ui/ui.js';
import { formatDistance, distance, bearing, formatBearing } from './geo.js';

window.__JL_VERSION__ = 'v1.1.0';

const PANELS = {
  map: 'panel-map', questions: 'panel-questions', timers: 'panel-timers',
  game: 'panel-game', more: 'panel-more',
};

function showTab(name) {
  for (const [key, id] of Object.entries(PANELS)) {
    document.getElementById(id).hidden = key !== name;
  }
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.go === name));
  update((s) => { s.ui.tab = name; });
  if (name === 'map') MapMod.invalidate();
  if (name === 'questions') Q.renderConstraintList();
  if (name === 'timers') Timers.renderTimers();
  if (name === 'game') Rounds.render();
  if (name === 'more') More.render();
}

/* ---------- Restgebiet-Anzeige ---------- */

let statsTimer = null;
function refreshStats(announce = false) {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => {
    const s = getState();
    const chip = document.getElementById('stat-remaining');
    const active = s.constraints.filter((c) => c.active !== false);
    if (!s.area || !active.length) { chip.hidden = true; return; }
    const st = C.remainingStats(s.area, active, 4000);
    const label = C.formatFraction(st);
    chip.hidden = label == null;
    if (label != null) {
      chip.querySelector('b').textContent = label;
      chip.querySelector('b').style.color = st.remaining === 0 ? 'var(--danger)' : '';
      if (announce) {
        toast(st.remaining === 0 ? 'Kein Gebiet mehr übrig – widersprechen sich zwei Antworten?' : `Restgebiet: ${label}`,
          st.remaining === 0 ? 'error' : 'ok');
      }
    }
  }, 120);
}

function refreshUndo() {
  const btn = document.getElementById('btn-undo');
  btn.hidden = !undoLabel();
  btn.title = undoLabel() || '';
}

/* ---------- Menü für einen Kartenpunkt ---------- */

function pointMenu(p) {
  const unit = getState().settings.unit;
  const me = Loc.current();
  openSheet('Punkt auf der Karte', (body, close) => {
    body.append(el('div', { class: 'hint mono', text: `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` }));
    if (me) {
      body.append(el('div', { class: 'card-sub', text: `von dir: ${formatDistance(distance(me, p), unit)} · ${formatBearing(bearing(me, p))}` }));
    }
    const action = (label, fn) => el('button', { class: 'btn btn-wide', onclick: () => { close(); fn(); } }, label);
    body.append(
      action('📍 Marker setzen', async () => {
        const name = await promptSheet('Marker', { label: 'Name', placeholder: 'Verdachtspunkt' });
        MapMod.addMarkerAt(p, name || 'Marker');
      }),
      action('⌖ Als meine Position setzen', () => { Loc.setManual(p); MapMod.render(); toast('Position manuell gesetzt'); syncLocButtons(); }),
      action('◎ Radius-Frage von hier', () => Q.openQuestionForm('radius', null, p)),
      action('▦ Spielgebiet um diesen Punkt', () => More.openAreaSheet()),
      action('📋 Koordinaten kopieren', async () => {
        try { await navigator.clipboard.writeText(`${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`); toast('Kopiert', 'ok'); }
        catch (e) { toast('Kopieren nicht erlaubt', 'error'); }
      }),
    );
    return [];
  });
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
    'Neue Version verfügbar ',
    el('button', {
      class: 'btn btn-small', style: { marginLeft: '8px' },
      onclick: () => { sw.postMessage({ type: 'SKIP_WAITING' }); location.reload(); },
    }, 'Neu laden'));
  root.append(t);
}

/* ---------- Start ---------- */

function boot() {
  load();
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
  document.getElementById('btn-game-menu').addEventListener('click', () => showTab('more'));

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
