// Datenquellen aus OpenStreetMap – bewusst ohne DOM-Abhängigkeit, damit Regelwerke
// und Tests dieselbe Liste sehen wie die App.
//
// Zwei Arten:
//   POI_CATEGORIES  benannte Orte als Punkte (für "nächster Ort", Tentakel, Matching)
//   REFERENCES      Geometrien (Linie/Fläche/Punkt) für Abstands- und Linienfragen
//
// Ein Regelwerk verweist über "osm" auf diese IDs. Neue Quellen kommen hier dazu.

// "filters" sind Overpass-Tag-Filter; mehrere werden vereinigt (ODER).
export const POI_CATEGORIES = [
  { id: 'station',     label: 'Bahnhöfe',            filters: ['["railway"="station"]'] },
  { id: 'tram',        label: 'Tram/U-Bahn',         filters: ['["railway"~"^(tram_stop|subway_entrance)$"]'] },
  { id: 'tram_subway', label: 'U-/Straßenbahn-Haltestellen', filters: ['["railway"="tram_stop"]', '["station"~"^(subway|light_rail)$"]'] },
  { id: 'bus',         label: 'Bushaltestellen',     filters: ['["highway"="bus_stop"]'] },
  { id: 'ferry',       label: 'Fähranleger',         filters: ['["amenity"="ferry_terminal"]'] },
  { id: 'bridge',      label: 'Brücken',             filters: ['["man_made"="bridge"]'] },
  { id: 'museum',      label: 'Museen',              filters: ['["tourism"="museum"]'] },
  { id: 'park',        label: 'Parks',               filters: ['["leisure"="park"]'] },
  { id: 'lake',        label: 'Seen',                filters: ['["natural"="water"]["water"~"^(lake|reservoir|pond)$"]'] },
  { id: 'playground',  label: 'Spielplätze',         filters: ['["leisure"="playground"]'] },
  { id: 'hospital',    label: 'Krankenhäuser',       filters: ['["amenity"="hospital"]'] },
  { id: 'worship',     label: 'Kirchen',             filters: ['["amenity"="place_of_worship"]'] },
  { id: 'school',      label: 'Schulen',             filters: ['["amenity"="school"]'] },
  { id: 'university',  label: 'Hochschulen',         filters: ['["amenity"="university"]'] },
  { id: 'library',     label: 'Bibliotheken',        filters: ['["amenity"="library"]'] },
  { id: 'supermarket', label: 'Supermärkte',         filters: ['["shop"="supermarket"]'] },
  { id: 'zoo',         label: 'Zoos/Tierparks',      filters: ['["tourism"="zoo"]'] },
  { id: 'aquarium',    label: 'Aquarien',            filters: ['["tourism"="aquarium"]'] },
  { id: 'theme_park',  label: 'Freizeitparks',       filters: ['["tourism"="theme_park"]'] },
  { id: 'cinema',      label: 'Kinos',               filters: ['["amenity"="cinema"]'] },
  { id: 'golf',        label: 'Golfplätze',          filters: ['["leisure"="golf_course"]'] },
  { id: 'viewpoint',   label: 'Aussichtspunkte',     filters: ['["tourism"="viewpoint"]'] },
  { id: 'tower',       label: 'Türme',               filters: ['["man_made"="tower"]'] },
  { id: 'peak',        label: 'Berggipfel',          filters: ['["natural"="peak"]'] },
  { id: 'consulate',   label: 'Konsulate/Botschaften', filters: ['["diplomatic"~"consulate|embassy"]'] },
  { id: 'stadium',     label: 'Stadien',             filters: ['["leisure"="stadium"]'] },
  { id: 'airport',     label: 'Flughäfen',           filters: ['["aeroway"="aerodrome"]'] },
  { id: 'townhall',    label: 'Rathäuser',           filters: ['["amenity"="townhall"]'] },
  { id: 'castle',      label: 'Burgen/Schlösser',    filters: ['["historic"="castle"]'] },
];

// geom: 'line'  – Wege als Linien
//       'lines' – Relationen (Bus-, Bahnlinien), alle Mitgliedswege als Linien
//       'auto'  – Punkte, geschlossene Wege und Relationen als Flächen
//       'point' – nur Punkte
// q:    Overpass-Anweisung(en) ohne Suchbereich; Liste = Vereinigung
// from: Filter aus POI_CATEGORIES übernehmen
// param: Platzhalter im Filter, den die Regeloption füllt (z. B. {adminLevel})
// kind: 'elevation' – kein OSM, sondern Höhenmodell
export const REFERENCES = [
  { id: 'motorway',       label: 'Autobahn',                  q: ['way["highway"="motorway"]'], geom: 'line', ladder: [3, 10, 30, 80, 200] },
  { id: 'trunk',          label: 'Schnellstraße',             q: ['way["highway"~"^(motorway|trunk)$"]'], geom: 'line', ladder: [3, 10, 30, 80] },
  { id: 'rail',           label: 'Bahnstrecke',               q: ['way["railway"="rail"]["service"!~"."]'], geom: 'line', ladder: [2, 8, 25, 80] },
  { id: 'highspeed',      label: 'Schnellfahrstrecke',        q: ['way["railway"="rail"]["highspeed"="yes"]'], geom: 'line', ladder: [10, 40, 120, 300] },
  { id: 'bus_route',      label: 'Buslinie',                  q: ['relation["route"="bus"]'], geom: 'lines', ladder: [1, 3, 8, 25] },
  { id: 'tram_route',     label: 'Straßenbahnlinie',          q: ['relation["route"="tram"]'], geom: 'lines', ladder: [2, 6, 20, 60] },
  { id: 'subway_route',   label: 'U-/Stadtbahnlinie',         q: ['relation["route"~"^(subway|light_rail)$"]'], geom: 'lines', ladder: [2, 6, 20, 60] },
  { id: 'rail_route',     label: 'Zuglinie',                  q: ['relation["route"="train"]'], geom: 'lines', ladder: [3, 10, 30, 90] },
  { id: 'ferry',          label: 'Fähre',                     q: ['way["route"="ferry"]'], geom: 'line', ladder: [3, 10, 30, 100] },
  { id: 'bridge',         label: 'Brücke',                    q: ['nwr["man_made"="bridge"]'], geom: 'auto', ladder: [1, 4, 12, 40] },
  { id: 'border_country', label: 'Staatsgrenze',              q: ['way["boundary"="administrative"]["admin_level"="2"]'], geom: 'line', ladder: [15, 50, 120, 300] },
  { id: 'border_admin1',  label: 'Grenze Verwaltungsebene 1', q: ['way["boundary"="administrative"]["admin_level"="4"]'], geom: 'line', ladder: [8, 30, 90, 250] },
  { id: 'border_admin2',  label: 'Grenze Verwaltungsebene 2', q: ['way["boundary"="administrative"]["admin_level"="6"]'], geom: 'line', ladder: [4, 15, 50, 150] },
  { id: 'admin_border',   label: 'Verwaltungsgrenze',         q: ['way["boundary"="administrative"]["admin_level"="{adminLevel}"]'], geom: 'line', ladder: [1, 4, 12, 40, 120], param: 'adminLevel' },
  { id: 'coastline',      label: 'Küstenlinie',               q: ['way["natural"="coastline"]'], geom: 'line', ladder: [25, 60, 150, 350, 600] },
  { id: 'river',          label: 'Fluss',                     q: ['way["waterway"="river"]'], geom: 'line', ladder: [2, 8, 25, 80] },
  { id: 'stream',         label: 'Fluss/Bach',                q: ['way["waterway"~"^(river|stream|canal)$"]'], geom: 'line', ladder: [1, 4, 12, 40] },
  { id: 'water',          label: 'Gewässer',                  q: ['nwr["natural"="water"]'], geom: 'auto', ladder: [2, 8, 25, 80] },
  { id: 'lake',           label: 'See',                       from: 'lake', geom: 'auto', ladder: [2, 8, 25, 80] },
  { id: 'mountain',       label: 'Berg',                      q: ['node["natural"="peak"]'], geom: 'point', ladder: [5, 20, 60, 180] },
  { id: 'forest',         label: 'Wald',                      q: ['nwr["landuse"="forest"]'], geom: 'auto', ladder: [2, 8, 25, 80] },
  { id: 'consulate',      label: 'Ausländische Vertretung',   from: 'consulate', geom: 'auto', ladder: [10, 40, 120, 350] },
  { id: 'airport',        label: 'Verkehrsflughafen',         from: 'airport', geom: 'auto', ladder: [10, 40, 120, 350] },
  { id: 'station',        label: 'Bahnhof',                   from: 'station', geom: 'auto', ladder: [2, 8, 25, 80] },
  { id: 'tram_subway',    label: 'U-/Straßenbahn-Haltestelle', from: 'tram_subway', geom: 'auto', ladder: [1, 4, 12, 40] },
  { id: 'bus_stop',       label: 'Bushaltestelle',            from: 'bus', geom: 'point', ladder: [0.5, 2, 6, 20] },
  { id: 'park',           label: 'Park',                      from: 'park', geom: 'auto', ladder: [1.5, 5, 15, 50] },
  { id: 'playground',     label: 'Spielplatz',                from: 'playground', geom: 'auto', ladder: [0.5, 2, 6, 20] },
  { id: 'museum',         label: 'Museum',                    from: 'museum', geom: 'auto', ladder: [2, 8, 25, 80] },
  { id: 'cinema',         label: 'Kino',                      from: 'cinema', geom: 'auto', ladder: [3, 12, 40, 120] },
  { id: 'hospital',       label: 'Krankenhaus',               from: 'hospital', geom: 'auto', ladder: [3, 12, 40, 120] },
  { id: 'library',        label: 'Bibliothek',                from: 'library', geom: 'auto', ladder: [2, 8, 25, 80] },
  { id: 'school',         label: 'Schule',                    from: 'school', geom: 'auto', ladder: [1, 4, 12, 40] },
  { id: 'townhall',       label: 'Rathaus',                   from: 'townhall', geom: 'auto', ladder: [2, 8, 25, 80] },
  { id: 'zoo',            label: 'Zoo/Tierpark',              from: 'zoo', geom: 'auto', ladder: [10, 40, 120, 350] },
  { id: 'aquarium',       label: 'Aquarium',                  from: 'aquarium', geom: 'auto', ladder: [10, 40, 120, 350] },
  { id: 'theme_park',     label: 'Freizeitpark',              from: 'theme_park', geom: 'auto', ladder: [10, 40, 120, 350] },
  { id: 'golf',           label: 'Golfplatz',                 from: 'golf', geom: 'auto', ladder: [5, 20, 60, 180] },
  { id: 'stadium',        label: 'Stadion',                   from: 'stadium', geom: 'auto', ladder: [5, 20, 60, 180] },
  { id: 'worship',        label: 'Gotteshaus',                from: 'worship', geom: 'auto', ladder: [1.5, 5, 15, 50] },
  { id: 'sea_level',      label: 'Meeresspiegel',             kind: 'elevation' },
];

export function poiCategory(id) {
  return POI_CATEGORIES.find((c) => c.id === id) || null;
}

export function reference(id) {
  return REFERENCES.find((r) => r.id === id) || null;
}

// Overpass-Anweisungen einer Referenz, Platzhalter ersetzt.
// Liefert eine Liste; der Aufrufer hängt jeweils den Suchbereich an.
export function referenceStatements(spec, params = {}) {
  let list;
  if (spec.q) list = spec.q;
  else if (spec.from) {
    const cat = poiCategory(spec.from);
    list = cat ? cat.filters.map((f) => `nwr${f}`) : [];
  } else list = [];
  return list.map((st) => st.replace(/\{(\w+)\}/g, (_, key) => {
    if (params[key] == null) throw new Error(`"${spec.label}" braucht den Wert "${key}"`);
    return String(params[key]);
  }));
}

export function poiStatements(cat) {
  return cat.filters.map((f) => `nwr${f}`);
}
