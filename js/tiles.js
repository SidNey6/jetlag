// Offline-Kartencache: Kacheln für ein Gebiet vorab in den Cache Storage laden,
// damit die Karte im Funkloch weiter funktioniert. Der Service Worker bedient
// Kachelanfragen anschließend zuerst aus genau diesem Cache.
//
// Bewusst gedeckelt und gedrosselt: Massen-Downloads von tile.openstreetmap.org
// verstoßen gegen deren Nutzungsbedingungen. Wer größere Gebiete braucht, trägt in
// den Einstellungen eine eigene Kachelquelle ein.

import { getState } from './state.js';
import { areaBounds } from './constraints.js';
import { el, openSheet, confirmSheet, toast } from './ui/ui.js';
import { getMap, tileTemplate } from './map.js';
import { tileList } from './tilemath.js';

export const TILE_CACHE = 'jetlag-tiles-v1';
export { tileList };
const MAX_TILES = 2000;
const CONCURRENCY = 2;
const THROTTLE_MS = 60;

export function tileUrl(t) {
  return tileTemplate()
    .replace('{s}', 'a')
    .replace('{z}', t.z)
    .replace('{x}', t.x)
    .replace('{y}', t.y)
    .replace('{r}', '');
}

export async function cacheStats() {
  if (!('caches' in window)) return { count: 0, bytes: null };
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  let bytes = null;
  if (navigator.storage?.estimate) {
    try { bytes = (await navigator.storage.estimate()).usage ?? null; } catch (e) { /* egal */ }
  }
  return { count: keys.length, bytes };
}

export async function clearTileCache() {
  await caches.delete(TILE_CACHE);
}

export async function downloadTiles(tiles, onProgress, signal) {
  const cache = await caches.open(TILE_CACHE);
  let done = 0, failed = 0;
  let index = 0;

  async function worker() {
    while (index < tiles.length) {
      if (signal.aborted) return;
      const t = tiles[index++];
      const url = tileUrl(t);
      try {
        const hit = await cache.match(url);
        if (!hit) {
          const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
          if (res.ok) await cache.put(url, res.clone());
          else failed++;
          await new Promise((r) => setTimeout(r, THROTTLE_MS));
        }
      } catch (e) {
        failed++;
      }
      done++;
      onProgress(done, tiles.length, failed);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { done, failed, aborted: signal.aborted };
}

export function openTilesSheet() {
  openSheet('Karte offline speichern', (body, close) => {
    const state = getState();
    let source = state.area ? 'area' : 'view';
    let extraZoom = 2;
    const info = el('div', { class: 'card-sub' });
    const bar = el('div', { class: 'progress' }, el('i', { style: { width: '0%' } }));
    const status = el('div', { class: 'hint' });
    let controller = null;

    function bounds() {
      if (source === 'area' && state.area) return areaBounds(state.area);
      const b = getMap().getBounds();
      return { south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() };
    }
    function zooms() {
      const base = Math.round(getMap().getZoom());
      return { minZ: Math.max(1, base - 1), maxZ: Math.min(19, base + extraZoom) };
    }
    function refresh() {
      const { minZ, maxZ } = zooms();
      const list = tileList(bounds(), minZ, maxZ, MAX_TILES + 1);
      const capped = list.length > MAX_TILES;
      info.textContent = `${capped ? `über ${MAX_TILES}` : list.length} Kacheln · Zoom ${minZ}–${maxZ} · grob ${Math.round((Math.min(list.length, MAX_TILES) * 18) / 1024)} MB`;
      info.style.color = capped ? 'var(--warn)' : '';
      if (capped) status.textContent = `Zu groß – Ausschnitt verkleinern oder Detailstufen reduzieren. Es würden nur die ersten ${MAX_TILES} geladen.`;
      else status.textContent = '';
    }

    const detail = el('input', { type: 'range', min: '0', max: '5', value: String(extraZoom) });
    detail.addEventListener('input', () => { extraZoom = parseInt(detail.value, 10); refresh(); });

    body.append(
      el('label', { class: 'field' }, 'Bereich',
        el('div', { class: 'seg' },
          el('button', {
            class: source === 'view' ? 'on' : '',
            onclick: (e) => { source = 'view'; segOn(e); refresh(); },
          }, 'Aktueller Ausschnitt'),
          el('button', {
            class: source === 'area' ? 'on' : '',
            onclick: (e) => {
              if (!state.area) return toast('Kein Spielgebiet gesetzt', 'error');
              source = 'area'; segOn(e); refresh();
            },
          }, 'Spielgebiet'))),
      el('label', { class: 'field' }, 'Detailstufen zusätzlich zum aktuellen Zoom', detail),
      info, bar, status,
      el('div', { class: 'hint', text: 'Bitte fair bleiben: die OSM-Kachelserver sind Spenden­infrastruktur. Für große Gebiete eigene Kachelquelle in den Einstellungen eintragen.' }),
    );
    refresh();

    const startBtn = el('button', {
      class: 'btn grow btn-primary',
      onclick: async () => {
        if (controller) { controller.abort(); return; }
        const { minZ, maxZ } = zooms();
        const list = tileList(bounds(), minZ, maxZ, MAX_TILES);
        controller = new AbortController();
        startBtn.textContent = 'Abbrechen';
        const res = await downloadTiles(list, (done, total, failed) => {
          bar.firstChild.style.width = `${(done / total) * 100}%`;
          status.textContent = `${done} / ${total} geladen${failed ? `, ${failed} fehlgeschlagen` : ''}`;
        }, controller.signal);
        controller = null;
        startBtn.textContent = 'Herunterladen';
        toast(res.aborted ? 'Abgebrochen' : `${res.done - res.failed} Kacheln gespeichert`, res.aborted ? '' : 'ok');
      },
    }, 'Herunterladen');

    return [
      el('button', { class: 'btn grow', onclick: () => { if (controller) controller.abort(); close(); } }, 'Schließen'),
      startBtn,
    ];
  });
}

function segOn(e) {
  const seg = e.target.parentElement;
  seg.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
  e.target.classList.add('on');
}

export async function tileCacheCard() {
  const { count, bytes } = await cacheStats();
  return el('div', { class: 'card' },
    el('div', { class: 'card-title', text: 'Offline-Karten' }),
    el('div', { class: 'card-sub', text: `${count} Kacheln gespeichert${bytes != null ? ` · ${(bytes / 1048576).toFixed(1).replace('.', ',')} MB Gesamtspeicher der App` : ''}` }),
    el('div', { class: 'row' },
      el('button', { class: 'btn btn-small grow', onclick: () => openTilesSheet() }, 'Gebiet laden'),
      el('button', {
        class: 'btn btn-small btn-danger',
        onclick: async () => {
          if (!(await confirmSheet('Kacheln löschen?', 'Die Karte braucht danach wieder Empfang.', { danger: true, okLabel: 'Löschen' }))) return;
          await clearTileCache();
          toast('Kachelcache geleert', 'ok');
          document.dispatchEvent(new CustomEvent('jetlag:changed'));
        },
      }, 'Leeren'),
    ),
  );
}
