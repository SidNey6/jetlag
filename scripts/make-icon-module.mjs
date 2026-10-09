// Erzeugt js/ui/icons.js aus den SVG-Dateien von lucide-static.
//
//   npm pack lucide-static@1.40.0 && tar -xzf lucide-static-1.40.0.tgz
//   node scripts/make-icon-module.mjs package/icons
//
// Nur die Symbole, die die App tatsächlich nutzt, landen im Modul – das ganze Set
// wären über 2000 Dateien. Links steht der Name im App-Code, rechts der von Lucide.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAMES = {
  map: 'map', questions: 'circle-help', timer: 'timer', game: 'flag', more: 'ellipsis',
  follow: 'locate-fixed', freeze: 'snowflake', measure: 'ruler', mask: 'contrast', layers: 'layers',
  undo: 'undo-2', plus: 'plus', minus: 'minus', x: 'x', check: 'check', play: 'play', pause: 'pause',
  reset: 'rotate-ccw', trash: 'trash-2', edit: 'pencil', copy: 'copy', share: 'share-2',
  download: 'download', upload: 'upload', link: 'link', qr: 'qr-code', book: 'book-open', dice: 'dice-5',
  cards: 'square-stack', shuffle: 'shuffle', chart: 'chart-column', pin: 'map-pin', crosshair: 'crosshair',
  radius: 'circle-dot', thermo: 'thermometer', compare: 'arrow-left-right', area: 'pentagon',
  nearest: 'target', sector: 'compass', elevation: 'mountain', side: 'waves', endgame: 'goal',
  footprints: 'footprints', route: 'route', pocket: 'smartphone', moon: 'moon', fileUp: 'file-up',
  fileDown: 'file-down', settings: 'settings', sliders: 'sliders-horizontal', search: 'search',
  chevronRight: 'chevron-right', chevronLeft: 'chevron-left', bell: 'bell', battery: 'battery-medium',
  gps: 'satellite', ring: 'circle-dashed', info: 'info', train: 'train-front', bus: 'bus', tram: 'tram-front',
  clock: 'clock', log: 'scroll-text', users: 'users', note: 'sticky-note', refresh: 'refresh-cw',
  offline: 'cloud-download', json: 'file-json', eye: 'eye', eyeOff: 'eye-off', lock: 'lock',
  unlock: 'lock-open', stop: 'circle-stop', rec: 'radio', trophy: 'trophy', install: 'house-plus',
  coins: 'coins', history: 'history', pointer: 'mouse-pointer-click', bookmark: 'bookmark',
  mapPinned: 'map-pinned', zone: 'circle-dashed', hourglass: 'hourglass', list: 'list-checks',
};

const dir = process.argv[2];
if (!dir) {
  console.error('Pfad zum icons-Ordner von lucide-static angeben');
  process.exit(1);
}

const lines = [];
for (const [name, file] of Object.entries(NAMES)) {
  const svg = readFileSync(join(dir, `${file}.svg`), 'utf8');
  const inner = svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>'))
    .replace(/\s*\n\s*/g, '').replace(/\s*\/>/g, '/>').trim();
  lines.push(`  ${/^[a-z]\w*$/i.test(name) ? name : `'${name}'`}: '${inner.replace(/'/g, "\\'")}',`);
}

const out = `// Symbole aus Lucide (https://lucide.dev), ISC-Lizenz – siehe vendor/lucide/LICENSE.
// Erzeugt von scripts/make-icon-module.mjs, nicht von Hand bearbeiten.

const PATHS = {
${lines.join('\n')}
};

// Ein Symbol als SVG-Element. Farbe kommt von currentColor, Größe aus dem CSS (.ic).
export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', \`ic \${cls}\`.trim());
  svg.innerHTML = PATHS[name] || PATHS.info;
  return svg;
}

export function hasIcon(name) {
  return name in PATHS;
}
`;

const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'js', 'ui', 'icons.js');
writeFileSync(target, out);
console.log(`${Object.keys(NAMES).length} Symbole nach ${target}`);
