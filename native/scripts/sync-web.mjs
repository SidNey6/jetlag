// Web-App für die Android-Hülle bereitstellen: die Dateien der Website nach native/www
// kopieren, die Capacitor-Brücke einhängen und die App-Version ins Android-Projekt
// übernehmen. Regionsdaten und Karte bleiben draußen – die holt die App wie die Website
// von GitHub Pages (js/native.js).
//
//   node scripts/sync-web.mjs

import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const NATIVE = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(NATIVE, '..');
const WWW = join(NATIVE, 'www');

const TEILE = ['index.html', 'offline.html', 'manifest.webmanifest', 'css', 'js', 'vendor', 'assets', 'rules'];

rmSync(WWW, { recursive: true, force: true });
mkdirSync(WWW, { recursive: true });
for (const t of TEILE) cpSync(join(ROOT, t), join(WWW, t), { recursive: true });

// Capacitor-Brücke vor dem App-Modul laden: stellt window.Capacitor.registerPlugin bereit
mkdirSync(join(WWW, 'vendor', 'capacitor'), { recursive: true });
cpSync(join(NATIVE, 'node_modules', '@capacitor', 'core', 'dist', 'capacitor.js'), join(WWW, 'vendor', 'capacitor', 'capacitor.js'));
cpSync(join(NATIVE, 'node_modules', '@capacitor', 'core', 'LICENSE'), join(WWW, 'vendor', 'capacitor', 'LICENSE'));
const indexPfad = join(WWW, 'index.html');
const html = readFileSync(indexPfad, 'utf8');
const anker = '<script type="module" src="./js/main.js"></script>';
if (!html.includes(anker)) throw new Error('index.html: Einstiegspunkt nicht gefunden');
writeFileSync(indexPfad, html.replace(anker, `<script src="./vendor/capacitor/capacitor.js"></script>\n${anker}`));

// App-Version aus js/main.js → versionName/versionCode (1.10.1 → 11001)
const version = /__JL_VERSION__ = 'v(\d+)\.(\d+)\.(\d+)'/.exec(readFileSync(join(ROOT, 'js', 'main.js'), 'utf8'));
if (!version) throw new Error('Version in js/main.js nicht gefunden');
const [, a, b, c] = version.map(Number);
const gradle = join(NATIVE, 'android', 'app', 'build.gradle');
if (existsSync(gradle)) {
  const g = readFileSync(gradle, 'utf8')
    .replace(/versionCode \d+/, `versionCode ${a * 10000 + b * 100 + c}`)
    .replace(/versionName "[^"]*"/, `versionName "${a}.${b}.${c}"`);
  writeFileSync(gradle, g);
}
console.log(`www bereit, Version ${a}.${b}.${c}`);
