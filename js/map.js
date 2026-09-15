// Karte: Kacheln, eigene Position, Masken-Overlay, Marker, Messwerkzeug, Punktauswahl.

import { getState, update, uid } from './state.js';
import { createMask } from './mask.js';
import * as C from './constraints.js';
import * as Loc from './location.js';
import { distance, bearing, formatDistance, formatBearing } from './geo.js';
import { el, toast } from './ui/ui.js';

const DEFAULT_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

let map = null;
let mask = null;
let tileLayer = null;
const layers = {};
let meMarker = null, meAccuracy = null;
let follow = true;
let measure = null;      // {points:[], line, markers:[]}
let picking = null;      // {resolve, banner}
let longPressTimer = null;

export function getMap() { return map; }

export function initMap() {
  const s = getState();
  map = L.map('map', {
    zoomControl: false,
    attributionControl: true,
    tap: false,
    worldCopyJump: true,
  }).setView([51.1657, 10.4515], 6);

  setTileSource(s.settings.tileUrl);

  layers.area = L.layerGroup().addTo(map);
  layers.zone = L.layerGroup().addTo(map);
  layers.outlines = L.layerGroup().addTo(map);
  layers.pois = L.layerGroup().addTo(map);
  layers.markers = L.layerGroup().addTo(map);
  layers.measure = L.layerGroup().addTo(map);
  layers.rings = L.layerGroup().addTo(map);

  mask = createMask(L, map, { opacity: s.settings.maskOpacity });

  map.on('movestart', () => { if (!followingProgrammatically) setFollow(false); });
  map.on('click', onMapClick);
  map.on('contextmenu', (e) => openPointMenu(e.latlng));
  bindLongPress();

  Loc.onLocation(renderMe);
  return map;
}

export function setTileSource(url) {
  if (tileLayer) tileLayer.remove();
  tileLayer = L.tileLayer(url || DEFAULT_TILES, {
    maxZoom: 19,
    crossOrigin: 'anonymous',
    attribution: ATTRIB,
    className: 'jl-tiles',
  }).addTo(map);
  if (layers.area) tileLayer.bringToBack();
}

export function tileTemplate() {
  return getState().settings.tileUrl || DEFAULT_TILES;
}

/* ---------- eigene Position ---------- */

let followingProgrammatically = false;

function renderMe(pos) {
  const el0 = document.getElementById('pos-source');
  const el1 = document.getElementById('pos-coords');
  // Der GPS-Fehler darf eine manuell gesetzte oder eingefrorene Position nicht überschreiben
  const showError = Loc.error() && (!pos || pos.source === 'gps');
  if (el0) el0.textContent = showError ? Loc.error() : Loc.sourceLabel();
  if (el1) el1.textContent = pos ? `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}` : '–';
  if (!pos || !map) return;

  const cls = `jl-me ${pos.source === 'gps' ? '' : 'manual'}`;
  if (!meMarker) {
    meMarker = L.marker([pos.lat, pos.lng], {
      icon: L.divIcon({ className: '', html: `<div class="${cls}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }),
      zIndexOffset: 1000,
      interactive: false,
    }).addTo(map);
    meAccuracy = L.circle([pos.lat, pos.lng], { radius: 0, color: '#38bdf8', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
  } else {
    meMarker.setLatLng([pos.lat, pos.lng]);
    meMarker.setIcon(L.divIcon({ className: '', html: `<div class="${cls}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }));
    meAccuracy.setLatLng([pos.lat, pos.lng]);
  }
  meAccuracy.setRadius(pos.accuracy && pos.source === 'gps' ? pos.accuracy : 0);

  if (follow) {
    followingProgrammatically = true;
    map.panTo([pos.lat, pos.lng], { animate: true, duration: 0.4 });
    setTimeout(() => { followingProgrammatically = false; }, 500);
  }
}

export function setFollow(on) {
  follow = on;
  const btn = document.getElementById('btn-follow');
  if (btn) btn.classList.toggle('on', on);
  if (on) {
    const p = Loc.current();
    if (p) {
      followingProgrammatically = true;
      map.setView([p.lat, p.lng], Math.max(map.getZoom(), 14), { animate: true });
      setTimeout(() => { followingProgrammatically = false; }, 600);
    }
  }
}

export function isFollowing() { return follow; }

/* ---------- Zeichnen des Zustands ---------- */

export function render() {
  if (!map) return;
  const s = getState();
  const active = s.constraints.filter((c) => c.active !== false);

  const shapes = [];
  for (const c of active) {
    const color = (C.TYPES[c.type] || {}).color;
    for (const sh of C.shapes(c)) shapes.push({ ...sh, color });
  }
  mask.setShapes(shapes);
  mask.setArea(C.areaRing(s.area));
  mask.setOpacity(s.settings.maskOpacity);
  mask.setVisible(s.ui.showMask !== false);

  layers.outlines.clearLayers();
  for (const c of active) {
    const color = (C.TYPES[c.type] || {}).color || '#94a3b8';
    for (const o of C.outline(c)) {
      if (o.kind === 'circle') {
        L.circle(o.center, { radius: o.radius, color, weight: 1, opacity: 0.5, fill: false, interactive: false }).addTo(layers.outlines);
      } else if (o.kind === 'path') {
        L.polyline(o.points, { color, weight: 2.5, opacity: 0.9, dashArray: '6 4', interactive: false }).addTo(layers.outlines);
      } else if (o.kind === 'dot') {
        L.circleMarker(o.at, {
          radius: o.strong ? 6 : 4, color, weight: 2,
          fillColor: o.strong ? color : '#0b1020', fillOpacity: 1, interactive: false,
        }).addTo(layers.outlines);
      }
    }
  }

  layers.area.clearLayers();
  const ring = C.areaRing(s.area);
  if (ring) {
    L.polygon(ring, { color: '#e2e8f0', weight: 2, dashArray: '6 5', fill: false, interactive: false }).addTo(layers.area);
  }

  // Versteckzone aus dem Regelwerk – der Kreis, in dem sich der Versteckende bewegen darf
  layers.zone.clearLayers();
  if (s.hidingZone) {
    const z = s.hidingZone;
    L.circle([z.lat, z.lng], {
      radius: z.radius, color: '#fbbf24', weight: 2, dashArray: '8 5',
      fillColor: '#fbbf24', fillOpacity: 0.07, interactive: false,
    }).addTo(layers.zone);
    L.circleMarker([z.lat, z.lng], { radius: 4, color: '#fbbf24', fillColor: '#fbbf24', fillOpacity: 1 })
      .addTo(layers.zone)
      .bindTooltip(z.name || 'Versteckzone', { direction: 'top', className: 'jl-label' });
  }

  layers.markers.clearLayers();
  for (const m of s.markers) {
    L.marker([m.lat, m.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div class="jl-pin" style="background:${m.color || '#f472b6'}"></div>`,
        iconSize: [16, 16], iconAnchor: [8, 8],
      }),
    }).addTo(layers.markers).bindPopup(popupFor(m));
  }

  layers.pois.clearLayers();
  for (const p of s.pois) {
    L.circleMarker([p.lat, p.lng], {
      radius: 5, color: '#fbbf24', weight: 2, fillColor: '#0b1020', fillOpacity: 1,
    }).addTo(layers.pois).bindTooltip(p.name || 'POI', { direction: 'top', className: 'jl-label' });
  }
}

function popupFor(m) {
  const wrap = el('div', {},
    el('b', { text: m.name || 'Marker' }),
    m.note ? el('div', { class: 'card-sub', text: m.note }) : null,
    el('div', { class: 'row', style: { marginTop: '8px' } },
      el('button', {
        class: 'btn btn-small', onclick: () => {
          update((st) => { st.markers = st.markers.filter((x) => x.id !== m.id); }, 'Marker gelöscht');
          map.closePopup();
          render();
        },
      }, 'Löschen'),
    ),
  );
  return wrap;
}

/* ---------- Interaktion ---------- */

function onMapClick(e) {
  if (picking) {
    const fn = picking.resolve;
    cancelPick();
    fn(e.latlng);
    return;
  }
  if (measure) {
    addMeasurePoint(e.latlng);
    return;
  }
}

function bindLongPress() {
  const container = map.getContainer();
  let startLatLng = null, moved = false;
  container.addEventListener('touchstart', (ev) => {
    if (ev.touches.length !== 1) return;
    moved = false;
    const t = ev.touches[0];
    const pt = map.mouseEventToContainerPoint(t);
    startLatLng = map.containerPointToLatLng(pt);
    longPressTimer = setTimeout(() => {
      if (!moved && startLatLng && !picking && !measure) {
        if (navigator.vibrate) navigator.vibrate(12);
        openPointMenu(startLatLng);
      }
    }, 520);
  }, { passive: true });
  const cancel = () => { clearTimeout(longPressTimer); };
  container.addEventListener('touchmove', () => { moved = true; cancel(); }, { passive: true });
  container.addEventListener('touchend', cancel, { passive: true });
  container.addEventListener('touchcancel', cancel, { passive: true });
}

let pointMenuHandler = null;
export function setPointMenuHandler(fn) { pointMenuHandler = fn; }
function openPointMenu(latlng) {
  if (pointMenuHandler) pointMenuHandler({ lat: latlng.lat, lng: latlng.lng });
}

/* ---------- Punktauswahl für Dialoge ---------- */

export function pickPoint(label = 'Punkt auf der Karte antippen') {
  cancelPick();
  return new Promise((resolve) => {
    const banner = el('div', { class: 'measure-readout' },
      label,
      el('button', { class: 'btn btn-small', style: { marginLeft: '10px' }, onclick: () => { cancelPick(); resolve(null); } }, 'Abbrechen'),
    );
    document.getElementById('panel-map').append(banner);
    picking = { resolve, banner };
    document.querySelector('.tabbar [data-go="map"]').click();
  });
}

function cancelPick() {
  if (picking) { picking.banner.remove(); picking = null; }
}

export function isPicking() { return !!picking; }

/* ---------- Messwerkzeug ---------- */

// Messmodus zeigt zusätzlich die eingestellten Radiusringe um die eigene Position –
// beim Abschätzen von Entfernungen will man beides gleichzeitig.
export function toggleMeasure() {
  if (measure) { stopMeasure(); return false; }
  measure = { points: [] };
  document.getElementById('btn-measure').classList.add('on');
  drawRadiusRings(true);
  const rings = getState().settings.radiusRings;
  showMeasure(rings.length && Loc.current()
    ? `Ringe: ${rings.map((r) => formatDistance(r, getState().settings.unit)).join(' · ')} — zwei Punkte antippen`
    : 'Punkte antippen – Distanz und Peilung erscheinen hier');
  return true;
}

export function stopMeasure() {
  measure = null;
  layers.measure.clearLayers();
  drawRadiusRings(false);
  document.getElementById('btn-measure').classList.remove('on');
  document.getElementById('measure-readout').hidden = true;
}

export function drawRadiusRings(on) {
  layers.rings.clearLayers();
  const me = Loc.current();
  if (!on || !me) return;
  const unit = getState().settings.unit;
  for (const r of getState().settings.radiusRings) {
    L.circle(me, { radius: r, color: '#38bdf8', weight: 1, opacity: 0.55, fill: false, dashArray: '4 5', interactive: false })
      .addTo(layers.rings)
      .bindTooltip(formatDistance(r, unit), { permanent: true, direction: 'top', className: 'jl-label' });
  }
}

function addMeasurePoint(latlng) {
  const p = { lat: latlng.lat, lng: latlng.lng };
  measure.points.push(p);
  if (measure.points.length > 2) measure.points = [p];
  layers.measure.clearLayers();
  for (const q of measure.points) {
    L.circleMarker(q, { radius: 5, color: '#38bdf8', fillColor: '#38bdf8', fillOpacity: 1 }).addTo(layers.measure);
  }
  if (measure.points.length === 2) {
    const [a, b] = measure.points;
    L.polyline([a, b], { color: '#38bdf8', weight: 2.5 }).addTo(layers.measure);
    const unit = getState().settings.unit;
    showMeasure(`${formatDistance(distance(a, b), unit)} · ${formatBearing(bearing(a, b))}`);
  } else {
    const me = Loc.current();
    const unit = getState().settings.unit;
    showMeasure(me
      ? `Von dir: ${formatDistance(distance(me, p), unit)} · ${formatBearing(bearing(me, p))} — zweiten Punkt antippen`
      : 'Zweiten Punkt antippen');
  }
}

function showMeasure(text) {
  const r = document.getElementById('measure-readout');
  r.hidden = false;
  r.textContent = text;
}

/* ---------- Hilfsfunktionen ---------- */

export function flyTo(p, zoom) {
  setFollow(false);
  map.setView([p.lat, p.lng], zoom || Math.max(map.getZoom(), 14), { animate: true });
}

export function fitArea() {
  const ring = C.areaRing(getState().area);
  if (!ring) { toast('Kein Spielgebiet gesetzt'); return; }
  setFollow(false);
  map.fitBounds(L.latLngBounds(ring.map((p) => [p.lat, p.lng])), { padding: [40, 40] });
}

export function addMarkerAt(p, name, note, color) {
  update((s) => {
    s.markers.push({ id: uid('mk'), lat: p.lat, lng: p.lng, name, note: note || '', color: color || '#f472b6', at: Date.now() });
  }, 'Marker gesetzt');
  render();
}

export function invalidate() {
  if (map) setTimeout(() => { map.invalidateSize(); mask.redraw(); }, 60);
}
