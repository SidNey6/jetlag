// Spielstand teilen – ohne Server. Der Zustand wird gepackt, base64-kodiert und
// in den URL-Fragment gehängt; als QR gezeigt liest ihn jede Handykamera direkt.
// Ein Scanner im Browser wäre der Umweg: Safari kennt BarcodeDetector nicht.

import { getState, replaceState, update } from './state.js';
import { el, clear, openSheet, confirmSheet, toast } from './ui/ui.js';

const B64 = { to: bytesToB64url, from: b64urlToBytes };

function bytesToB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gzip(str) {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export function shareablePayload(scope = 'all') {
  const s = getState();
  if (scope === 'map') {
    return { v: s.v, area: s.area, constraints: s.constraints, markers: s.markers, pois: s.pois, settings: s.settings };
  }
  return s;
}

export async function encodePayload(payload) {
  const json = JSON.stringify(payload);
  const gz = await gzip(json);
  if (gz) return '1' + B64.to(gz);
  return '0' + B64.to(new TextEncoder().encode(json));
}

export async function decodePayload(code) {
  const flag = code[0];
  const bytes = B64.from(code.slice(1));
  const json = flag === '1' ? await gunzip(bytes) : new TextDecoder().decode(bytes);
  return JSON.parse(json);
}

export function shareUrl(code) {
  const base = location.href.split('#')[0];
  return `${base}#s=${code}`;
}

/* ---------- Teilen-Dialog ---------- */

export function openShareSheet() {
  let scope = 'all';
  openSheet('Spielstand teilen', (body, close) => {
    const out = el('div', {});

    async function build() {
      clear(out).append(el('div', { class: 'hint', text: 'Wird gepackt …' }));
      const code = await encodePayload(shareablePayload(scope));
      const url = shareUrl(code);
      clear(out);

      const qrBox = el('div', { class: 'qr-wrap' });
      try {
        const qr = window.qrcode(0, 'L');
        qr.addData(url);
        qr.make();
        qrBox.innerHTML = qr.createImgTag(6, 8);
        out.append(qrBox, el('div', { class: 'hint', style: { textAlign: 'center' }, text: 'Mit der Handykamera scannen – der Link öffnet die App mit diesem Stand.' }));
      } catch (e) {
        out.append(el('div', { class: 'card' },
          el('div', { class: 'card-title', text: 'Zu viele Daten für einen QR-Code' }),
          el('div', { class: 'card-sub', text: 'Stattdessen den Link kopieren und per Nachricht schicken – oder oben „nur Karte" wählen.' })));
      }

      out.append(
        el('div', { class: 'hint mono', style: { wordBreak: 'break-all', maxHeight: '72px', overflow: 'auto' }, text: url }),
        el('div', { class: 'row row-wrap' },
          el('button', {
            class: 'btn btn-small grow',
            onclick: async () => {
              try { await navigator.clipboard.writeText(url); toast('Link kopiert', 'ok'); }
              catch (e) { toast('Kopieren nicht erlaubt', 'error'); }
            },
          }, '🔗 Link kopieren'),
          navigator.share ? el('button', {
            class: 'btn btn-small grow',
            onclick: () => navigator.share({ title: 'Jetlag-Spielstand', url }).catch(() => {}),
          }, '📤 Teilen') : null,
          el('button', {
            class: 'btn btn-small grow',
            onclick: () => downloadJson(shareablePayload(scope)),
          }, '💾 Als Datei'),
        ),
        el('div', { class: 'hint', text: `${(url.length / 1024).toFixed(1).replace('.', ',')} kB Link` }),
      );
    }

    body.append(
      el('label', { class: 'field' }, 'Umfang',
        el('div', { class: 'seg' },
          el('button', { class: 'on', onclick: (e) => { scope = 'all'; segSwitch(e); build(); } }, 'Alles'),
          el('button', { onclick: (e) => { scope = 'map'; segSwitch(e); build(); } }, 'Nur Karte'))),
      out,
    );
    build();

    return [
      el('button', { class: 'btn grow', onclick: () => close() }, 'Schließen'),
      el('button', { class: 'btn grow', onclick: () => { close(); openImportSheet(); } }, 'Stattdessen importieren'),
    ];
  });
}

function segSwitch(e) {
  const seg = e.target.parentElement;
  seg.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
  e.target.classList.add('on');
}

function downloadJson(payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = el('a', {
    href: URL.createObjectURL(blob),
    download: `jetlag-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`,
  });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function openImportSheet() {
  openSheet('Spielstand importieren', (body, close) => {
    const input = el('textarea', { placeholder: 'Link oder Code hier einfügen' });
    const file = el('input', { type: 'file', accept: 'application/json' });
    file.addEventListener('change', async () => {
      const f = file.files[0];
      if (!f) return;
      try {
        const payload = JSON.parse(await f.text());
        close();
        applyImport(payload);
      } catch (e) { toast('Datei nicht lesbar', 'error'); }
    });
    body.append(
      el('label', { class: 'field' }, 'Link oder Code', input),
      el('label', { class: 'field' }, 'oder Datei', file),
    );
    return [
      el('button', { class: 'btn grow', onclick: () => close() }, 'Abbrechen'),
      el('button', {
        class: 'btn grow btn-primary',
        onclick: async () => {
          const raw = input.value.trim();
          const code = raw.includes('#s=') ? raw.split('#s=')[1] : raw;
          if (!code) return toast('Nichts eingefügt', 'error');
          try {
            const payload = await decodePayload(code);
            close();
            applyImport(payload);
          } catch (e) {
            toast('Code unlesbar', 'error');
          }
        },
      }, 'Einlesen'),
    ];
  });
}

// Beim Import nie kommentarlos überschreiben: der andere hat vielleicht
// stundenlang Fragen gesammelt.
export async function applyImport(payload) {
  const s = getState();
  const incoming = {
    fragen: (payload.constraints || []).length,
    marker: (payload.markers || []).length,
    runden: (payload.game?.rounds || []).length,
  };
  openSheet('Importieren', (body, close) => {
    body.append(
      el('div', { class: 'card' },
        el('div', { class: 'card-title', text: 'Empfangener Stand' }),
        el('div', { class: 'card-sub', text: `${incoming.fragen} Fragen · ${incoming.marker} Marker · ${incoming.runden} Runden` })),
      el('div', { class: 'card' },
        el('div', { class: 'card-title', text: 'Dein aktueller Stand' }),
        el('div', { class: 'card-sub', text: `${s.constraints.length} Fragen · ${s.markers.length} Marker · ${s.game.rounds.length} Runden` })),
    );
    return [
      el('button', {
        class: 'btn grow',
        onclick: () => {
          mergeImport(payload);
          close();
          toast('Zusammengeführt', 'ok');
          document.dispatchEvent(new CustomEvent('jetlag:changed'));
        },
      }, 'Zusammenführen'),
      el('button', {
        class: 'btn grow btn-primary',
        onclick: async () => {
          close();
          if (!(await confirmSheet('Ersetzen?', 'Dein aktueller Stand wird überschrieben.', { danger: true, okLabel: 'Ersetzen' }))) return;
          replaceState({ ...getState(), ...payload });
          toast('Ersetzt', 'ok');
          document.dispatchEvent(new CustomEvent('jetlag:changed'));
        },
      }, 'Ersetzen'),
    ];
  });
}

function mergeImport(payload) {
  update((s) => {
    const byId = (arr, item) => !arr.some((x) => x.id === item.id);
    for (const c of payload.constraints || []) if (byId(s.constraints, c)) s.constraints.push(c);
    for (const m of payload.markers || []) if (byId(s.markers, m)) s.markers.push(m);
    for (const t of payload.game?.teams || []) if (byId(s.game.teams, t)) s.game.teams.push(t);
    for (const r of payload.game?.rounds || []) if (byId(s.game.rounds, r)) s.game.rounds.push(r);
    for (const l of payload.game?.log || []) if (byId(s.game.log, l)) s.game.log.push(l);
    s.game.log.sort((a, b) => a.at - b.at);
    if (!s.area && payload.area) s.area = payload.area;
    if (payload.pois?.length) s.pois = payload.pois;
  }, 'Import zusammengeführt');
}

// Beim Start prüfen, ob ein geteilter Stand im Link steckt.
export async function consumeHash() {
  const m = location.hash.match(/#s=(.+)$/);
  if (!m) return;
  history.replaceState(null, '', location.href.split('#')[0]);
  try {
    const payload = await decodePayload(decodeURIComponent(m[1]));
    applyImport(payload);
  } catch (e) {
    toast('Geteilter Link unlesbar', 'error');
  }
}
