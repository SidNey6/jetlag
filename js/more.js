// "Mehr": Regelwerk, Spielgebiet, Endgame, Offline-Vorrat, Werkzeuge, Spielstand und
// Einstellungen – als gruppierte Liste mit Unterseiten statt einer Wand aus Knöpfen.

import { getState, update, replaceState, emptyState, uid, powerSaving } from './state.js';
import * as C from './constraints.js';
import * as Loc from './location.js';
import * as MapMod from './map.js';
import { drawPolygon, pointField, distanceField } from './questions.js';
import { areaPickerSheet } from './overpass.js';
import { formatDistance } from './geo.js';
import {
  el, clear, append, openSheet, confirmSheet, promptSheet, toast, icon, group, row, toggleSwitch, button,
} from './ui/ui.js';
import { openDiceSheet, openListsSheet } from './random.js';
import { openShareSheet, openImportSheet } from './share.js';
import { openTilesSheet, clearTileCache, cacheStats } from './tiles.js';
import { bundleMeta, bundleStats, clearBundle } from './bundle.js';
import { prepareArea, planSteps, estimateTiles, regionFor } from './prefetch.js';
import { listRegions, cachedCount, REGION_CACHE, hasMap, mapStored, downloadMap, forgetMaps } from './region.js';
import { exportText } from './rounds.js';
import * as Rules from './rules.js';
import * as Endgame from './endgame.js';
import { zoneSummary } from './zone.js';
import { PHASE_LABEL } from './phases.js';
import { createTimer } from './timers.js';

/* ---------- Seiten ---------- */

const PAGES = {
  root: { title: 'Mehr', build: rootPage },
  settings: { title: 'Einstellungen', build: settingsPage },
  rules: { title: 'Regelwerk', build: rulesPage },
  offline: { title: 'Offline-Vorrat', build: offlinePage },
};
let page = 'root';

export function openPage(name) {
  page = PAGES[name] ? name : 'root';
  render();
  const body = document.getElementById('more-body');
  if (body) body.scrollTop = 0;
}

export function resetPage() {
  page = 'root';
}

export function render() {
  const host = document.getElementById('more-body');
  if (!host || document.getElementById('panel-more').hidden) return;
  const head = document.getElementById('more-head');
  clear(head);
  if (page !== 'root') {
    head.append(el('div', { style: { display: 'flex', flexDirection: 'column', flex: '1' } },
      el('button', { class: 'back', onclick: () => openPage('root') }, icon('chevronLeft'), 'Mehr'),
      el('h1', { text: PAGES[page].title })));
  } else {
    head.append(el('h1', { text: 'Mehr' }));
  }
  clear(host);
  PAGES[page].build(host);
}

function rootPage(host) {
  const s = getState();
  const rules = Rules.getRules();
  const size = Rules.currentSize();
  const eg = Endgame.summary();
  const meta = bundleMeta();

  host.append(
    group('Spiel',
      row({
        icon: 'book', title: 'Regelwerk',
        sub: rules ? `${rules.name}${size ? ` · ${size.label}` : ''}${Rules.isCustom() ? ' · eigenes' : ''}` : 'wird geladen …',
        onClick: () => openPage('rules'),
      }),
      row({ icon: 'layers', title: 'Spielgebiet', sub: areaLabel(s.area), onClick: () => openAreaSheet() }),
      row({
        icon: 'endgame', title: 'Endgame',
        sub: eg ? `${eg.title} · ${eg.line}` : 'Haltestelle erkannt? Lange auf der Karte drücken',
        onClick: () => (eg ? Endgame.openEndgameSheet() : Endgame.openStopPicker()),
      }),
      row({
        icon: 'offline', title: 'Offline-Vorrat',
        sub: meta ? `bereit seit ${new Date(meta.at).toLocaleDateString('de-DE')}` : 'nichts vorbereitet',
        onClick: () => openPage('offline'),
      })),
    group('Werkzeuge',
      row({ icon: 'dice', title: 'Würfel und Münze', onClick: openDiceSheet }),
      row({ icon: 'cards', title: 'Eigene Listen', sub: 'Karten, Flüche, Aufgaben', onClick: openListsSheet }),
      row({ icon: 'shuffle', title: 'Zufallspunkt im Restgebiet', onClick: randomSpot }),
      row({ icon: 'chart', title: 'Fragen-Analyse', sub: 'Welcher Radius teilt das Restgebiet am besten?', onClick: openAnalysis })),
    group('Spielstand',
      row({ icon: 'share', title: 'Teilen oder QR-Code', onClick: openShareSheet }),
      row({ icon: 'download', title: 'Spielstand importieren', onClick: openImportSheet }),
      row({
        icon: 'log', title: 'Protokoll kopieren',
        onClick: async () => {
          try { await navigator.clipboard.writeText(exportText()); toast('Protokoll kopiert', 'ok'); }
          catch (e) { openSheet('Protokoll', (body) => { body.append(el('textarea', { style: { minHeight: '50vh' } }, exportText())); return []; }); }
        },
      })),
    group(null,
      row({ icon: 'settings', title: 'Einstellungen', onClick: () => openPage('settings') })),
  );
}

/* ---------- Einstellungen ---------- */

function settingsPage(host) {
  const s = getState();
  const st = s.settings;
  const set = (fn, label = null) => update((x) => fn(x.settings), label);

  const kacheln = st.tileUrl ? 'eigene' : 'OpenStreetMap';
  const regionKarten = listRegions().filter(hasMap);
  const meter = (list) => list.map((m) => formatDistance(m)).join(', ');
  const notif = !('Notification' in window) ? 'nicht verfügbar'
    : Notification.permission === 'granted' ? 'erlaubt'
      : Notification.permission === 'denied' ? 'blockiert' : 'aus';

  host.append(
    group('Karte',
      row({
        icon: 'radius', title: 'Mittelpunkte anzeigen', sub: 'Kleiner Marker in der Mitte jeder Kreisfrage',
        control: toggleSwitch(st.showCenters !== false, (v) => { set((x) => { x.showCenters = v; }); MapMod.render(); }),
      }),
      row({
        icon: 'mask', title: 'Abdunkelung', sub: 'Wie stark ausgeschlossene Flächen verdeckt werden',
        below: rangeInput(st.maskOpacity, 0.2, 0.92, 0.02, (v) => { set((x) => { x.maskOpacity = v; }); MapMod.render(); }),
      }),
      row({
        icon: 'map', title: 'Kartenquelle', value: kacheln,
        onClick: async () => {
          const v = await promptSheet('Kartenquelle', {
            label: 'URL-Vorlage mit {z}/{x}/{y}, leer = OpenStreetMap',
            value: st.tileUrl, placeholder: 'https://…/{z}/{x}/{y}.png',
          });
          if (v === null && !st.tileUrl) return;
          set((x) => { x.tileUrl = v || ''; }, 'Kartenquelle geändert');
          MapMod.setTileSource(v || '');
          render();
          toast('Kartenquelle gesetzt', 'ok');
        },
      }),
      regionKarten.length ? row({
        icon: 'mapPinned', title: 'Vorgebaute Regionskarte',
        sub: `In ${regionKarten.map((r) => r.name).join(', ')} statt der Kartenquelle – lädt schneller und offline in einem Stück`,
        control: toggleSwitch(st.regionMap !== false, (v) => { set((x) => { x.regionMap = v; }); MapMod.setTileSource(getState().settings.tileUrl); }),
      }) : null),
    group('Fragen',
      row({
        icon: 'ring', title: 'Radius-Vorgaben', sub: meter(s.presets.radius),
        onClick: () => editDistanceList('Radius-Vorgaben', s.presets.radius,
          'Werte für die Schnellauswahl bei Radius-Fragen',
          (list) => update((x) => { x.presets.radius = list; }, 'Radius-Vorgaben geändert')),
      }),
      row({
        icon: 'measure', title: 'Ringe beim Messen', sub: meter(st.radiusRings),
        onClick: () => editDistanceList('Ringe beim Messen', st.radiusRings,
          'Ringe, die im Messmodus um deine Position liegen',
          (list) => set((x) => { x.radiusRings = list; }, 'Radiusringe geändert')),
      })),
    group('Endgame',
      row({
        icon: 'footprints', title: 'Erfassungsbreite', sub: 'So nah muss die Spur an einer Straße sein, damit sie als abgelaufen gilt',
        below: seg([[10, '10 m'], [20, '20 m'], [30, '30 m']], st.trackWidthM || 20, (v) => {
          set((x) => { x.trackWidthM = v; });
          Endgame.recompute();
        }),
      }),
      row({
        icon: 'route', title: 'Lücken schließen', sub: 'Wege bei aus­geschaltetem Bildschirm über das Straßennetz schätzen',
        control: toggleSwitch(st.trackFillGaps !== false, (v) => set((x) => { x.trackFillGaps = v; })),
      })),
    group('Ortung und Akku',
      row({
        icon: 'gps', title: 'GPS', sub: (st.gpsAccuracy || 'high') === 'high' ? 'Jede Sekunde, auf wenige Meter' : 'Seltener und gröber – das Endgame ortet trotzdem genau',
        below: seg([['high', 'Genau'], ['saving', 'Sparsam']], st.gpsAccuracy || 'high', (v) => {
          set((x) => { x.gpsAccuracy = v; });
          Loc.setAccuracyMode(v);
          render();
        }),
      }),
      row({
        icon: 'battery', title: 'Stromsparmodus',
        sub: powerSaving() ? 'Aktiv: gröbere Maske, keine Animationen' : 'Aus: volle Auflösung',
        below: seg([['auto', 'Auto'], ['on', 'An'], ['off', 'Aus']], st.powerSave || 'auto', (v) => {
          set((x) => { x.powerSave = v; });
          render();
        }),
      }),
      row({
        icon: 'eye', title: 'Bildschirm anlassen', sub: 'Solange ein Timer läuft und im Endgame',
        control: toggleSwitch(st.keepAwake !== false, (v) => set((x) => { x.keepAwake = v; })),
      })),
    group('Benachrichtigungen',
      row({
        icon: 'bell', title: 'Alarme als Mitteilung', value: notif,
        onClick: 'Notification' in window ? async () => {
          const p = await Notification.requestPermission();
          toast(p === 'granted' ? 'Benachrichtigungen an' : 'Nicht erlaubt', p === 'granted' ? 'ok' : 'error');
          render();
        } : null,
      })),
    group('App',
      row({ icon: 'info', title: 'Version', value: versionLine() }),
      row({
        icon: 'refresh', title: 'Nach Update suchen',
        onClick: async () => {
          const reg = await navigator.serviceWorker?.getRegistration();
          if (!reg) return toast('Kein Service Worker aktiv', 'error');
          await reg.update();
          toast('Nach Update gesucht', 'ok');
        },
      }),
      row({ icon: 'install', title: 'Als App installieren', onClick: openInstallHelp }),
      row({
        icon: 'trash', title: 'Alles zurücksetzen', danger: true,
        onClick: async () => {
          if (!(await confirmSheet('Alles zurücksetzen?', 'Fragen, Marker, Timer, Runden, Endgame und Einstellungen werden gelöscht.', { danger: true, okLabel: 'Zurücksetzen' }))) return;
          replaceState(emptyState());
          MapMod.render();
          document.dispatchEvent(new CustomEvent('jetlag:changed'));
          openPage('root');
          toast('Zurückgesetzt', 'ok');
        },
      })),
  );
}

function versionLine() {
  const mode = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone
    ? 'installiert' : 'im Browser';
  return `${window.__JL_VERSION__ || 'dev'} · ${mode}`;
}

function rangeInput(value, min, max, step, onChange) {
  const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
  input.addEventListener('input', () => onChange(parseFloat(input.value)));
  input.addEventListener('click', (e) => e.stopPropagation());
  return input;
}

// Segmentierte Auswahl für Zeilen: [[wert, beschriftung], …]
function seg(options, value, onChange) {
  const wrap = el('div', { class: 'seg' });
  for (const [v, label] of options) {
    const b = el('button', {
      class: v === value ? 'on' : '',
      onclick: (e) => {
        e.stopPropagation();
        wrap.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        onChange(v);
      },
    }, label);
    wrap.append(b);
  }
  return wrap;
}

function segOn(e) {
  const seg2 = e.target.parentElement;
  seg2.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
  e.target.classList.add('on');
}

function goMap() { document.querySelector('.tabbar [data-go="map"]').click(); }

function areaLabel(area) {
  if (!area) return 'Nicht gesetzt – ohne Gebiet keine Restflächen-Angabe';
  if (area.type === 'circle') return `Kreis, Radius ${formatDistance(area.radius)}`;
  if (area.type === 'bbox') return 'Rechteck aus Kartenausschnitt';
  if (area.type === 'polygon') return `${area.name || 'Polygon'} · ${area.ring.length} Punkte`;
  return 'unbekannt';
}

/* ---------- Spielgebiet festlegen ---------- */

export function openAreaSheet() {
  openSheet('Spielgebiet', (body, close) => {
    let center = Loc.current();
    let radius = 5000;
    const pf = pointField('Mittelpunkt', center, (p) => { center = p; });
    const rf = distanceField('Radius', radius, (m) => { radius = m; },
      [1000, 2000, 3000, 5000, 7500, 10000, 15000, 25000, 50000]);

    body.append(
      el('div', { class: 'card' },
        el('div', { class: 'card-title', text: 'Kreis' }),
        pf.node,
        rf.node,
        el('button', {
          class: 'btn btn-small btn-primary',
          onclick: () => {
            if (!center) return toast('Mittelpunkt fehlt', 'error');
            setArea({ type: 'circle', center: { lat: center.lat, lng: center.lng }, radius });
            close();
          },
        }, 'Als Spielgebiet setzen')),
      el('div', { class: 'card' },
        el('div', { class: 'card-title', text: 'Aus Kartenausschnitt' }),
        el('div', { class: 'hint', text: 'Nimmt das Rechteck, das gerade auf der Karte zu sehen ist.' }),
        el('button', {
          class: 'btn btn-small',
          onclick: () => {
            const b = MapMod.getMap().getBounds();
            setArea({ type: 'bbox', bounds: { south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() } });
            close();
          },
        }, 'Ausschnitt übernehmen')),
      el('div', { class: 'card' },
        el('div', { class: 'card-title', text: 'Freie Form' }),
        el('div', { class: 'row row-wrap' },
          button('edit', 'Zeichnen', async () => {
            close();
            const ring = await drawPolygon();
            if (ring && ring.length >= 3) setArea({ type: 'polygon', ring, name: 'Gezeichnet' });
          }),
          button('search', 'Ort oder Gebiet', () => {
            close();
            areaPickerSheet(Loc.current(), (a) => setArea({ type: 'polygon', ring: a.ring, name: a.name }));
          }))),
    );
    return [el('button', { class: 'btn grow', onclick: () => close() }, 'Schließen')];
  });
}

function setArea(area) {
  update((s) => { s.area = area; }, 'Spielgebiet gesetzt');
  MapMod.render();
  MapMod.fitArea();
  render();
  goMap();
}

/* ---------- Werkzeuge ---------- */

function randomSpot() {
  const s = getState();
  if (!s.area) return toast('Erst ein Spielgebiet festlegen', 'error');
  const p = C.randomAllowedPoint(s.area, s.constraints.filter((c) => c.active !== false));
  if (!p) return toast('Kein Punkt erfüllt alle Antworten', 'error');
  MapMod.addMarkerAt(p, 'Zufallspunkt', 'aus dem Restgebiet gezogen', '#34d399');
  MapMod.flyTo(p, 14);
  goMap();
  toast('Punkt im Restgebiet gesetzt', 'ok');
}

function openAnalysis() {
  const s = getState();
  if (!s.area) return toast('Erst ein Spielgebiet festlegen', 'error');
  const center = Loc.current();
  if (!center) return toast('Standort nötig', 'error');
  openSheet('Welche Frage bringt am meisten?', (body, close) => {
    body.append(el('div', { class: 'hint', text: 'Angenommen, du fragst nach einem Radius um deinen Standort: So teilt sich das Restgebiet auf.' }));
    const rows = C.analyzeRadius(s.area, s.constraints.filter((c) => c.active !== false), center, s.presets.radius);
    if (!rows.length) {
      body.append(el('div', { class: 'empty', text: 'Kein Restgebiet mehr übrig.' }));
      return [el('button', { class: 'btn grow', onclick: () => close() }, 'Schließen')];
    }
    for (const r of [...rows].sort((a, b) => b.balance - a.balance)) {
      const pct = (r.insideFraction * 100).toFixed(0);
      body.append(el('div', { class: 'card' },
        el('div', { class: 'card-title' },
          el('span', { class: 'grow', text: formatDistance(r.radius) }),
          el('span', { class: 'card-sub', text: `${pct} % / ${100 - pct} %` })),
        el('div', { class: 'progress' }, el('i', { style: { width: `${pct}%` } })),
        el('div', { class: 'card-sub', text: r.balance > 0.7 ? 'teilt gut' : r.balance > 0.3 ? 'brauchbar' : 'bringt wenig' })));
    }
    return [el('button', { class: 'btn grow', onclick: () => close() }, 'Schließen')];
  });
}

/* ---------- Installationshilfe ---------- */

export function openInstallHelp() {
  const prompt = window.__JL_INSTALL_PROMPT__;
  openSheet('Als App installieren', (body, close) => {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    body.append(
      el('div', { class: 'card' },
        el('div', { class: 'card-title', text: ios ? 'iPhone / iPad' : 'Android' }),
        ios
          ? el('div', { class: 'card-sub', html: 'In <b>Safari</b> öffnen → Teilen-Symbol → „Zum Home-Bildschirm" → Hinzufügen. Die App startet dann im Vollbild ohne Browserleiste.' })
          : el('div', { class: 'card-sub', html: 'In <b>Chrome</b> → Menü ⋮ → „App installieren" bzw. „Zum Startbildschirm hinzufügen".' })),
      el('div', { class: 'hint', text: 'Standort und Offline-Betrieb brauchen HTTPS – über die veröffentlichte Adresse öffnen, nicht als lokale Datei.' }),
    );
    return prompt ? [el('button', {
      class: 'btn grow btn-primary',
      onclick: async () => { close(); prompt.prompt(); },
    }, 'Jetzt installieren')] : [el('button', { class: 'btn grow', onclick: () => close() }, 'Verstanden')];
  });
}

// Abstandslisten (Radius-Vorgaben, Radiusringe) bearbeiten – in Kilometern, durch
// Semikolon getrennt, damit das Dezimalkomma bleiben darf ("0,25; 0,5; 1").
async function editDistanceList(title, current, hint, save) {
  const v = await promptSheet(title, {
    label: `${hint} – in km, durch Semikolon getrennt`,
    value: current.map((m) => String(+(m / 1000).toFixed(3)).replace('.', ',')).join('; '),
  });
  if (v == null) return;
  const list = v.split(/;|\s+/)
    .map((x) => parseFloat(x.trim().replace(',', '.')) * 1000)
    .filter((x) => isFinite(x) && x > 0)
    .sort((a, b) => a - b);
  if (!list.length) { toast('Keine gültigen Werte', 'error'); return; }
  save(list);
  render();
  toast(`${list.length} Werte gespeichert`, 'ok');
}

/* ---------- Regelwerk ---------- */

function rulesPage(host) {
  const rules = Rules.getRules();
  if (!rules) {
    host.append(el('div', { class: 'empty', text: 'Regelwerk wird geladen …' }));
    return;
  }
  const size = Rules.currentSize();
  const sizeSeg = seg(Rules.sizes().map((g) => [g.id, g.label]), size && size.id, (id) => {
    Rules.setSize(id);
    render();
    MapMod.render();
  });

  host.append(
    el('div', { class: 'card' },
      el('div', { class: 'card-title' },
        el('span', { class: 'grow', text: rules.name }),
        el('span', { class: 'card-sub', text: Rules.isCustom() ? 'eigenes' : (rules.version || 'Standard') })),
      el('label', { class: 'field' }, 'Spielgröße', sizeSeg),
      size ? el('div', { class: 'card-sub', text: [size.description, size.typicalDuration].filter(Boolean).join(' · ') }) : null),
    size ? group('Werte',
      row({ icon: 'hourglass', title: 'Versteckzeit', value: `${size.hidingPeriodMinutes} min` }),
      row({ icon: 'zone', title: 'Versteckzone', value: zoneSummary(size.hidingZoneRadiusM) }),
      row({ icon: 'timer', title: 'Antwortfrist', value: `${size.answerMinutes} min` }),
      row({ icon: 'clock', title: 'Fotofrist', value: `${size.photoMinutes || size.answerMinutes} min` })) : null,
    group('Im Spiel',
      row({ icon: 'book', title: 'Regeln ansehen', onClick: openRulesOverview }),
      row({
        icon: 'hourglass', title: 'Versteckzeit starten', sub: `${Rules.hidingPeriodMinutes()} min Countdown`,
        onClick: () => {
          const m = Rules.hidingPeriodMinutes();
          createTimer({ name: 'Versteckzeit', kind: 'countdown', duration: m * 60000 });
          toast(`Versteckzeit läuft: ${m} Minuten`, 'ok');
          document.querySelector('.tabbar [data-go="timers"]').click();
        },
      }),
      row({ icon: 'cards', title: 'Deck als Listen anlegen', sub: 'Zum Ziehen nach Kartenhäufigkeit', onClick: seedDeckLists })),
    group('Datei',
      row({ icon: 'json', title: 'JSON bearbeiten', onClick: openRulesEditor }),
      row({ icon: 'upload', title: 'Regeldatei laden', onClick: importRulesFile }),
      row({ icon: 'download', title: 'Regeldatei exportieren', onClick: exportRules }),
      Rules.isCustom() ? row({
        icon: 'reset', title: 'Auf Standard zurücksetzen', danger: true,
        onClick: async () => {
          if (!(await confirmSheet('Regelwerk zurücksetzen?', 'Zurück auf den mitgelieferten Standard von lifack.ch.', { danger: true, okLabel: 'Zurücksetzen' }))) return;
          await Rules.resetRules();
          render();
          toast('Standard wiederhergestellt', 'ok');
        },
      }) : null),
    rules.sourceNote ? el('div', { class: 'hint', text: rules.sourceNote }) : null,
  );
}

function openRulesOverview() {
  const rules = Rules.getRules();
  const size = Rules.currentSize();
  openSheet('Regeln', (body, close) => {
    body.append(el('div', { class: 'hint', text: `Gefiltert auf Spielgröße ${size ? size.label : '–'}.` }));
    for (const cat of Rules.categories()) {
      const opts = Rules.optionsFor(cat.id);
      body.append(el('div', { class: 'card' },
        el('div', { class: 'card-title' },
          el('span', { class: 'grow', text: cat.label }),
          el('span', { class: 'card-sub', text: `${Rules.drawLabel(cat)} · ${Rules.answerMinutes(cat.id)} Min` })),
        el('div', { class: 'card-sub', text: cat.prompt }),
        el('div', { class: 'hint', text: opts.length
          ? opts.map((o) => o.meters ? `${o.label} (${formatDistance(o.meters)})` : o.label).join(' · ')
          : 'In dieser Spielgröße nicht verfügbar' })));
    }
    const r = rules.round || {};

    const fristen = Rules.deadlines();
    if (fristen.length) {
      body.append(el('div', { class: 'card' },
        el('div', { class: 'card-title', text: 'Fristen' }),
        ...fristen.map((d) => el('div', { class: 'card-sub', text:
          `${d.label || d.id}: ${Math.floor(d.afterMinutes / 60) ? Math.floor(d.afterMinutes / 60) + ' h ' : ''}${d.afterMinutes % 60 ? (d.afterMinutes % 60) + ' min ' : ''}ab „${PHASE_LABEL[d.from || 'roundStart']}", bis „${PHASE_LABEL[d.until]}" → ${d.outcomeLabel || d.outcome || 'Hinweis'}` }))));
    }
    const la = Rules.lateAnswerRules();
    if (la) {
      body.append(el('div', { class: 'card' },
        el('div', { class: 'card-title', text: 'Verspätete Antworten' }),
        ...(la.steps || []).map((st) => el('div', { class: 'card-sub', text:
          `${st.overMinutes ? `ab ${st.overMinutes} min` : 'jede Verspätung'}: `
          + (st.label || (st.nextQuestionFree ? 'nächste Frage gratis' : `${st.nextDrawDelta || 0} Karten bei der nächsten Frage`)) })),
        la.deductOvertimeFactor ? el('div', { class: 'card-sub', text: `Überzogene Zeit zählt ${String(la.deductOvertimeFactor).replace('.', ',')}-fach als Abzug.` }) : null,
        la.exemptionNote ? el('div', { class: 'hint', text: la.exemptionNote }) : null));
    }
    const ties = Rules.categories().filter((q) => q.tieBreak);
    if (ties.length) {
      const tol = Rules.tieToleranceM();
      body.append(el('div', { class: 'card' },
        el('div', { class: 'card-title', text: 'Grenzfälle' }),
        el('div', { class: 'card-sub', text: ties.map((q) => `${q.label}: ${Rules.TIE_LABEL[q.tieBreak]}`).join(' · ') }),
        tol ? el('div', { class: 'hint', text: `Als Grenzfall gilt alles innerhalb von ${formatDistance(tol)}.` }) : null));
    }
    for (const b of Rules.textBlocks()) {
      body.append(el('div', { class: 'card' },
        el('div', { class: 'card-title', text: b.title }),
        ...b.chips.filter((c) => c.items.length).map((c) => el('div', {},
          el('div', { class: 'hint', text: c.label }),
          el('div', { class: 'pills' }, c.items.map((it) => el('span', {
            class: 'pill', style: { borderColor: c.kind === 'no' ? '#5b2b34' : '#1f5140' },
          }, it))))),
        ...b.rules.map((t) => el('div', { class: 'card-sub', text: `• ${t}` }))));
    }

    body.append(el('div', { class: 'card' },
      el('div', { class: 'card-title', text: 'Runde' }),
      el('div', { class: 'card-sub', text: [
        r.handLimit ? `Handlimit ${r.handLimit} Karten` : null,
        r.foundLabel ? `Gefunden: ${r.foundLabel}` : null,
        r.roundChangeMinutes ? `Rundenwechsel: ${r.roundChangeMinutes} Min Vorlauf` : null,
        r.scoringLabel || (r.scoring === 'totalTime' ? 'Wertung: Summe aller Runden' : 'Wertung: längste einzelne Runde'),
        r.repeatQuestionNote,
      ].filter(Boolean).join('\n') })));
    const d = rules.deck;
    if (d) {
      const sum = (a) => (a || []).reduce((s2, c) => s2 + (c.count || 0), 0);
      body.append(el('div', { class: 'card' },
        el('div', { class: 'card-title', text: 'Deck' }),
        el('div', { class: 'card-sub', text: `${sum(d.timeBonuses)} Zeitboni · ${sum(d.powerups)} Powerups · ${sum(d.curses)} Flüche · ${d.blanks || 0} Blanks` })));
    }
    if (rules.source) body.append(el('div', { class: 'hint', text: `Quelle: ${rules.source}` }));
    return [el('button', { class: 'btn grow', onclick: () => close() }, 'Schließen')];
  });
}

function openRulesEditor() {
  const current = JSON.stringify(Rules.getRules(), null, 2);
  openSheet('Regelwerk bearbeiten', (body, close) => {
    const area = el('textarea', { style: { minHeight: '46vh', fontFamily: 'ui-monospace, monospace', fontSize: '12px' } });
    area.value = current;
    const status = el('div', { class: 'hint', text: 'Änderungen wirken sofort, sobald sie gültig sind.' });
    body.append(status, area);
    return [
      el('button', { class: 'btn grow', onclick: () => close() }, 'Abbrechen'),
      el('button', {
        class: 'btn grow btn-primary',
        onclick: () => {
          let parsed;
          try { parsed = JSON.parse(area.value); }
          catch (e) { status.textContent = `JSON-Fehler: ${e.message}`; status.style.color = 'var(--danger)'; return; }
          try { Rules.applyRules(parsed); }
          catch (e) { status.textContent = `Regelfehler: ${e.message}`; status.style.color = 'var(--danger)'; return; }
          close();
          render();
          toast('Regelwerk übernommen', 'ok');
        },
      }, 'Übernehmen'),
    ];
  });
}

function importRulesFile() {
  const input = el('input', { type: 'file', accept: 'application/json,.json' });
  input.addEventListener('change', async () => {
    const f = input.files[0];
    if (!f) return;
    try {
      Rules.applyRules(JSON.parse(await f.text()), f.name);
      render();
      toast(`${f.name} übernommen`, 'ok');
    } catch (e) {
      toast(`Nicht übernommen: ${e.message || e}`, 'error');
    }
  });
  input.click();
}

function exportRules() {
  const blob = new Blob([JSON.stringify(Rules.getRules(), null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'jetlag-regeln.json' });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// Deck des Regelwerks in die vorhandene Listenfunktion überführen, damit man
// mit „Ziehen" wirklich nach Kartenhäufigkeit zieht.
function seedDeckLists() {
  const d = Rules.getRules()?.deck;
  if (!d) return toast('Kein Deck im Regelwerk', 'error');
  const expand = (arr, label) => arr.flatMap((c) => Array.from({ length: c.count || 1 }, () => label(c)));
  const neu = [
    { name: 'Zeitboni', items: expand(d.timeBonuses || [], (c) => `+${c.minutes} Minuten`) },
    { name: 'Powerups', items: expand(d.powerups || [], (c) => c.effect ? `${c.label} – ${c.effect}` : c.label) },
    { name: 'Flüche', items: expand(d.curses || [], (c) => c.label) },
  ].filter((l) => l.items.length);

  update((s) => {
    for (const l of neu) {
      const vorhanden = s.lists.find((x) => x.name === l.name);
      if (vorhanden) { vorhanden.items = l.items; vorhanden.drawn = []; }
      else s.lists.push({ id: uid('ls'), name: l.name, items: l.items, drawn: [] });
    }
  }, 'Deck-Listen angelegt');
  toast(`${neu.map((l) => `${l.name} (${l.items.length})`).join(', ')}`, 'ok');
}

/* ---------- Offline vorbereiten ---------- */

function formatBytes(b) {
  if (!b) return '0 MB';
  return `${(b / 1048576).toFixed(1).replace('.', ',')} MB`;
}

async function offlinePage(host) {
  const meta = bundleMeta();
  const s = getState();
  const slot = el('div', { class: 'list' }, row({ icon: 'offline', title: 'Bestand wird gezählt …' }));
  host.append(
    el('div', { class: 'hint', text: 'Lädt Orte, Grenzen, Bezugsgeometrien und die Karte für das Spielgebiet einmal herunter. Danach läuft die Runde ohne Netz.' }),
    slot,
    group('Herunterladen',
      row({
        icon: 'offline', title: meta ? 'Neu vorbereiten' : 'Spielgebiet vorbereiten',
        sub: s.area ? 'Alles, was das Regelwerk braucht' : 'Erst ein Spielgebiet festlegen',
        onClick: s.area ? () => openPrepareSheet() : () => openAreaSheet(),
      }),
      row({ icon: 'map', title: 'Nur Kartenkacheln', onClick: () => openTilesSheet() })),
  );

  // Vorgebaute Regionsdaten: welche Regionen es gibt, wie aktuell, was schon auf dem Gerät ist
  const regionen = listRegions();
  if (regionen.length) {
    const zeilen = (await Promise.all(regionen.map(async (r) => {
      const anzahl = Object.keys(r.files).length;
      const hier = await cachedCount(r);
      const daten = row({
        icon: 'mapPinned', title: r.name,
        sub: `Stand ${new Date(r.built).toLocaleDateString('de-DE')} · ${hier} von ${anzahl} Dateien auf dem Gerät`,
      });
      if (!hasMap(r)) return [daten];
      const liegt = await mapStored(r);
      const karte = row({
        icon: 'map', title: `Karte ${r.name}`,
        sub: liegt ? `Auf dem Gerät · ${formatBytes(r.map.bytes)}` : `${formatBytes(r.map.bytes)} · tippen zum Herunterladen`,
        onClick: liegt ? null : async () => {
          const sub = karte.querySelector('.row-sub');
          try {
            await downloadMap(r, { onProgress: (d, t) => { if (sub) sub.textContent = `Lädt … ${Math.round((d / t) * 100)} %`; } });
            toast('Karte liegt jetzt auf dem Gerät', 'ok');
          } catch (e) {
            toast(`Karte nicht geladen: ${e.message || e}`, 'error');
          }
          render();
        },
      });
      return [daten, karte];
    }))).flat();
    host.insertBefore(group('Vorgebaute Regionen', ...zeilen), slot);
    host.insertBefore(el('div', { class: 'hint', text: 'In diesen Regionen beantwortet die App Ortsfragen ohne Overpass, und die Karte kommt als eine fertige Datei statt Kachel für Kachel. Einmal abgerufene Dateien bleiben auf dem Gerät; „Spielgebiet vorbereiten" holt alle auf einmal.' }), slot);
  }

  const [kacheln, vorrat] = await Promise.all([cacheStats(), bundleStats()]);
  clear(slot);
  if (meta) {
    const z = meta.zaehler || {};
    slot.append(
      meta.region ? row({ title: 'Regionsdaten', value: `${meta.region.name} · ${z.region || 0} Dateien` }) : null,
      meta.karte ? row({ title: 'Karte', value: formatBytes(meta.karte.bytes) }) : null,
      meta.region ? null : row({ title: 'Orte', value: String(z.pois || 0) }),
      meta.region ? null : row({ title: 'Geometrien', value: String(z.refs || 0) }),
      meta.region ? null : row({ title: 'Gebiete', value: `${z.orte || 0}${z.gebiete ? ` · ${z.gebiete} Umrisse` : ''}` }),
      z.hoehe ? row({ title: 'Höhenpunkte', value: String(z.hoehe) }) : null,
      row({ title: 'Kartenkacheln', value: String(kacheln.count) }),
      row({ title: 'Speicher', value: formatBytes(vorrat.bytes) }),
      row({ title: 'Vorbereitet', value: new Date(meta.at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) }),
      meta.fehler?.length ? row({ title: 'Fehlgeschlagen', value: `${meta.fehler.length} Abfragen` }) : null,
    );
  } else {
    slot.append(row({
      title: 'Nichts vorbereitet',
      sub: kacheln.count ? `${kacheln.count} Kartenkacheln liegen bereits vor`
        : regionen.length ? 'Ohne Vorbereitung brauchen Karte und noch nicht abgerufene Regionsdateien Empfang'
          : 'Unterwegs braucht jede Frage dann Empfang',
    }));
  }
  const regionVorrat = 'caches' in window && (await caches.has(REGION_CACHE));
  if (meta || kacheln.count || regionVorrat) {
    host.append(group(null, row({
      icon: 'trash', title: 'Vorrat löschen', danger: true,
      onClick: async () => {
        if (!(await confirmSheet('Offline-Vorrat löschen?', 'Karten und vorgeladene Daten werden entfernt.', { danger: true, okLabel: 'Löschen' }))) return;
        await Promise.all([clearBundle(), clearTileCache(), caches.delete(REGION_CACHE)]);
        forgetMaps();
        render();
        toast('Vorrat geleert', 'ok');
      },
    })));
  }
}

function openPrepareSheet() {
  const area = getState().area;
  if (!area) return toast('Erst ein Spielgebiet festlegen', 'error');
  let withTiles = true;
  let withStreets = true;
  let zoomExtra = 3;
  let controller = null;

  openSheet('Spielgebiet vorbereiten', (body, close) => {
    const region = regionFor(area);
    const info = el('div', { class: 'card-sub' });
    const bar = el('div', { class: 'progress' }, el('i', { style: { width: '0%' } }));
    const status = el('div', { class: 'hint' });
    const detail = el('input', { type: 'range', min: '1', max: '5', value: String(zoomExtra) });
    const detailFeld = el('label', { class: 'field' }, 'Kartendetail', detail);

    async function refresh() {
      const p = planSteps(area, { withTiles, zoomExtra, withStreets });
      const k = withTiles ? estimateTiles(area, zoomExtra) : 0;
      const kachelnMb = Math.round(k * 18 / 1024);
      detailFeld.hidden = !!p.karte;
      if (p.karte) {
        const liegt = await mapStored(p.karte);
        info.textContent = `Regionsdaten ${p.region ? `${p.regionFiles.length} Dateien, ${formatBytes(p.regionBytes)} unkomprimiert` : '–'}`
          + (p.hoeheOnline ? ' · Geländehöhen (online)' : p.elevation ? ' inkl. Geländehöhen' : '')
          + ` · Karte ${p.karte.name}: ${liegt ? 'liegt schon auf dem Gerät' : `${formatBytes(p.karte.map.bytes)} in einer Datei`}`;
        // Alles parallel; die Karte ist der größte Brocken (bei ~2 MB/s mobil)
        const sekunden = Math.max(p.regionFiles.length / 10 * 0.25, p.hoeheOnline ? 3 : 0, liegt ? 0 : p.karte.map.bytes / 2e6);
        status.textContent = `Dauer grob ${sekunden < 60 ? `${Math.max(5, Math.round(sekunden / 5) * 5)} Sekunden` : `${Math.round(sekunden / 60)} Minuten`}, je nach Empfang. Alles kommt aus dem vorgebauten Auszug – weder Overpass noch OpenStreetMap-Kachelserver.`;
        return;
      }
      if (p.region) {
        info.textContent = `Regionsdaten ${p.region.name}: ${p.regionFiles.length} Dateien, ${formatBytes(p.regionBytes)} unkomprimiert`
          + (p.hoeheOnline ? ' · Geländehöhen (online)' : p.elevation ? ' inkl. Geländehöhen' : '')
          + (withTiles ? ` · ${k} Kartenkacheln (grob ${kachelnMb} MB)` : '');
        // Regionsdaten (10 gleichzeitig) und Kacheln (2 gleichzeitig) laufen parallel
        const sekunden = Math.max(p.regionFiles.length / 10 * 0.25, p.hoeheOnline ? 3 : 0, withTiles ? k / 2 * 0.12 : 0);
        status.textContent = `Dauer grob ${sekunden < 60 ? `${Math.max(10, Math.round(sekunden / 10) * 10)} Sekunden` : `${Math.round(sekunden / 60)} Minuten`}, je nach Empfang. Ortsdaten kommen aus dem vorgebauten Auszug, ohne Overpass.`;
        return;
      }
      info.textContent = `${p.pois.length} Ortskategorien · ${p.refs.length} Bezugsobjekte`
        + (p.adminLevels.length ? ` · ${p.adminLevels.length} Verwaltungsebenen` : '')
        + (p.elevation ? ' · Geländehöhen' : '')
        + ' · 1 Gebietsliste'
        + (withTiles ? ` · ${k} Kacheln (grob ${kachelnMb} MB)` : '');
      const sekunden = Math.round((p.schritte - (withTiles ? 1 : 0)) * 2.5 + (withTiles ? k / 12 : 0));
      status.textContent = `Dauer grob ${Math.max(1, Math.round(sekunden / 60))} Minuten. Zwischen den Abfragen wird bewusst gewartet – die OpenStreetMap-Server sind gespendet.`;
    }

    detail.addEventListener('input', () => { zoomExtra = parseInt(detail.value, 10); refresh(); });

    append(body,
      el('div', { class: 'hint', text: region
        ? `Das Spielgebiet liegt in der Region „${region.name}". Orte, Linien, Grenzen und Straßen liegen dort fertig vor und werden nur auf das Gerät geholt, dazu die Karte selbst.`
        : 'Holt alles, was die Fragen später brauchen: Orte je Kategorie, Geometrie der Bezugsobjekte, Orts- und Grenzliste, dazu die Karte selbst.' }),
      el('div', { class: 'list' },
        row({ icon: 'map', title: 'Karte mitladen', control: toggleSwitch(withTiles, (v) => { withTiles = v; refresh(); }) }),
        region ? row({
          icon: 'footprints', title: 'Straßennetz fürs Endgame', sub: 'Damit das Endgame auch im Funkloch startet',
          control: toggleSwitch(withStreets, (v) => { withStreets = v; refresh(); }),
        }) : null),
      detailFeld,
      info, bar, status,
    );
    refresh();

    const startBtn = el('button', {
      class: 'btn grow btn-primary',
      onclick: async () => {
        if (controller) { controller.abort(); return; }
        controller = new AbortController();
        startBtn.textContent = 'Abbrechen';
        try {
          const meta = await prepareArea(area, {
            withTiles, zoomExtra, withStreets, signal: controller.signal,
            onProgress: ({ erledigt, gesamt, text }) => {
              bar.firstChild.style.width = `${(erledigt / gesamt) * 100}%`;
              status.textContent = `${Math.floor((erledigt / gesamt) * 100)} % · ${text}`;
            },
          });
          close();
          render();
          toast(meta.fehler.length
            ? `Vorbereitet, ${meta.fehler.length} Schritte mit Fehlern`
            : 'Spielgebiet ist offline verfügbar', meta.fehler.length ? '' : 'ok');
        } catch (e) {
          status.textContent = String(e.message || e);
        } finally {
          controller = null;
          startBtn.textContent = 'Herunterladen';
        }
      },
    }, 'Herunterladen');

    return [
      el('button', { class: 'btn grow', onclick: () => { if (controller) controller.abort(); close(); } }, 'Schließen'),
      startBtn,
    ];
  });
}
