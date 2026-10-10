// Regionen mit vorgebauten Daten. Für jede wird aus Geofabrik-Auszügen ein Satz
// statischer Dateien unter data/<id>/ erzeugt (scripts/region/build.mjs).
//
// bounds:  Orte, Linien, Grenzen und Gebiete. Bewusst großzügig, damit auch Fragen wie
//          "nächster Flughafen" (Köln/Bonn) oder "nächster Freizeitpark" (Brühl) ohne
//          Overpass beantwortet werden.
// streets: Straßennetz fürs Endgame – das ist der größte Posten, deshalb nur dort, wo
//          gespielt wird.

export const REGIONS = {
  bonn: {
    id: 'bonn',
    name: 'Bonn und Umgebung',
    bounds: { south: 50.53, west: 6.80, north: 50.90, east: 7.42 },
    // Bonn bis Siegburg und Hennef, Wachtberg, Oberwinter, Alfter, Bornheim, Rheinbach
    streets: { south: 50.57, west: 6.92, north: 50.85, east: 7.33 },
    // Oberwinter und Remagen liegen schon in Rheinland-Pfalz
    sources: [
      'https://download.geofabrik.de/europe/germany/nordrhein-westfalen/koeln-regbez-latest.osm.pbf',
      'https://download.geofabrik.de/europe/germany/rheinland-pfalz-latest.osm.pbf',
    ],
  },
};

// Kachelraster des Straßennetzes: etwa 3,3 × 3,2 km in dieser Breite. Größer heißt
// weniger Dateien beim Vorbereiten (jede Anfrage kostet auf Mobilfunk spürbar Zeit),
// kleiner heißt weniger Daten beim Endgame-Start – das hier ist der Mittelweg.
// Die App liest das Raster aus data/regions.json, der Schlüssel kommt aus js/osmgeo.js.
export const STREET_TILE = { lat: 0.03, lng: 0.045 };
