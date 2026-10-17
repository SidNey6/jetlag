// Regionen mit vorgebauten Daten. Für jede wird aus Geofabrik-Auszügen ein Satz
// statischer Dateien unter data/<id>/ erzeugt (scripts/region/build.mjs), dazu Höhen
// (elevation.mjs) und Karte (basemap.mjs).
//
// bounds:  Orte, Linien, Grenzen und Gebiete – Stadt mit Umland, damit auch Fragen nach
//          Flughafen, Freizeitpark oder Autobahn ohne Overpass auskommen.
// streets: Straßennetz fürs Endgame. Das ist der größte Posten, deshalb nur die Stadt.
// sources: alle Auszüge, die den Rahmen abdecken – über Landes- und Bezirksgrenzen hinweg.
//          scripts/region/coverage.mjs prüft das gegen die Umrisse der Auszüge.
//
// Alles zusammen muss unter der 1-GB-Grenze von GitHub Pages bleiben (je Region etwa
// 30–60 MB, davon gut die Hälfte Karte).

const G = (p) => `https://download.geofabrik.de/europe/germany/${p}-latest.osm.pbf`;
const NRW = (p) => G(`nordrhein-westfalen/${p}`);
const BW = (p) => G(`baden-wuerttemberg/${p}`);

const LISTE = [
  // Nordrhein-Westfalen
  {
    id: 'bonn', name: 'Bonn und Umgebung',
    bounds: { south: 50.53, west: 6.80, north: 50.90, east: 7.42 },
    streets: { south: 50.57, west: 6.92, north: 50.85, east: 7.33 },
    sources: [NRW('koeln-regbez'), G('rheinland-pfalz')],
  },
  {
    id: 'koeln', name: 'Köln',
    bounds: { south: 50.80, west: 6.72, north: 51.10, east: 7.20 },
    streets: { south: 50.86, west: 6.80, north: 51.05, east: 7.12 },
    sources: [NRW('koeln-regbez'), NRW('duesseldorf-regbez')],
  },
  {
    id: 'duesseldorf', name: 'Düsseldorf',
    bounds: { south: 51.10, west: 6.62, north: 51.38, east: 6.98 },
    streets: { south: 51.15, west: 6.68, north: 51.32, east: 6.95 },
    sources: [NRW('duesseldorf-regbez')],
  },
  {
    id: 'dortmund', name: 'Dortmund',
    bounds: { south: 51.40, west: 7.28, north: 51.62, east: 7.68 },
    streets: { south: 51.44, west: 7.33, north: 51.58, east: 7.62 },
    sources: [NRW('arnsberg-regbez'), NRW('muenster-regbez')],
  },
  {
    id: 'muenster', name: 'Münster',
    bounds: { south: 51.85, west: 7.45, north: 52.06, east: 7.80 },
    streets: { south: 51.90, west: 7.53, north: 52.02, east: 7.72 },
    sources: [NRW('muenster-regbez')],
  },
  // Baden-Württemberg
  {
    // Westlich des Rheins beginnt Rheinland-Pfalz; Frankreich liegt knapp außerhalb
    id: 'karlsruhe', name: 'Karlsruhe',
    bounds: { south: 48.92, west: 8.25, north: 49.12, east: 8.60 },
    streets: { south: 48.96, west: 8.30, north: 49.08, east: 8.52 },
    sources: [BW('karlsruhe-regbez'), G('rheinland-pfalz')],
  },
  {
    id: 'heidelberg', name: 'Heidelberg und Mannheim',
    bounds: { south: 49.32, west: 8.42, north: 49.52, east: 8.82 },
    streets: { south: 49.36, west: 8.45, north: 49.50, east: 8.78 },
    // Ludwigshafen liegt in Rheinland-Pfalz
    sources: [BW('karlsruhe-regbez'), G('rheinland-pfalz')],
  },
  {
    id: 'stuttgart', name: 'Stuttgart',
    bounds: { south: 48.66, west: 9.00, north: 48.90, east: 9.38 },
    streets: { south: 48.70, west: 9.06, north: 48.86, east: 9.30 },
    sources: [BW('stuttgart-regbez')],
  },
  {
    id: 'freiburg', name: 'Freiburg im Breisgau',
    bounds: { south: 47.92, west: 7.68, north: 48.10, east: 8.02 },
    streets: { south: 47.95, west: 7.75, north: 48.05, east: 7.95 },
    sources: [BW('freiburg-regbez')],
  },
  // Weitere Großstädte
  {
    id: 'frankfurt', name: 'Frankfurt am Main',
    bounds: { south: 50.00, west: 8.45, north: 50.25, east: 8.90 },
    streets: { south: 50.05, west: 8.52, north: 50.20, east: 8.80 },
    sources: [G('hessen')],
  },
  {
    id: 'muenchen', name: 'München',
    bounds: { south: 48.03, west: 11.33, north: 48.27, east: 11.78 },
    streets: { south: 48.07, west: 11.40, north: 48.22, east: 11.70 },
    sources: [G('bayern/oberbayern')],
  },
  {
    id: 'berlin', name: 'Berlin',
    bounds: { south: 52.36, west: 13.08, north: 52.66, east: 13.76 },
    streets: { south: 52.42, west: 13.18, north: 52.60, east: 13.62 },
    // Der Brandenburg-Auszug enthält Berlin
    sources: [G('brandenburg')],
  },
  {
    id: 'hamburg', name: 'Hamburg',
    // Südgrenze knapp vor Niedersachsen – dessen Auszug allein ist fast 500 MB
    bounds: { south: 53.475, west: 9.80, north: 53.68, east: 10.25 },
    streets: { south: 53.50, west: 9.88, north: 53.63, east: 10.15 },
    sources: [G('hamburg'), G('schleswig-holstein')],
  },
  {
    id: 'leipzig', name: 'Leipzig',
    bounds: { south: 51.24, west: 12.22, north: 51.44, east: 12.58 },
    streets: { south: 51.28, west: 12.28, north: 51.40, east: 12.50 },
    sources: [G('sachsen')],
  },
];

export const REGIONS = Object.fromEntries(LISTE.map((r) => [r.id, r]));

// Kachelraster des Straßennetzes: etwa 3,3 × 3,2 km in dieser Breite. Größer heißt
// weniger Dateien beim Vorbereiten (jede Anfrage kostet auf Mobilfunk spürbar Zeit),
// kleiner heißt weniger Daten beim Endgame-Start – das hier ist der Mittelweg.
// Die App liest das Raster aus data/regions.json, der Schlüssel kommt aus js/osmgeo.js.
export const STREET_TILE = { lat: 0.03, lng: 0.045 };
