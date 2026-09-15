// Canvas-Overlay: färbt alles ein, was durch die bisherigen Antworten ausscheidet.
//
// Statt Polygone boolesch zu verschneiden wird die VEREINIGUNG der ausgeschlossenen
// Flächen gemalt: jede Form landet deckend auf einem Zwischen-Canvas (bei
// "außerhalb fällt weg" wird die erlaubte Fläche per destination-out ausgestanzt) und
// wird dann auf das Sammel-Canvas kopiert. Übrig bleibt hell, was keine Frage ausschließt.

const MASK_COLOR = '#0b1020';

export function createMask(L, map, opts = {}) {
  const pane = map.getPanes().overlayPane;
  const maskCanvas = document.createElement('canvas');
  const edgeCanvas = document.createElement('canvas');
  maskCanvas.className = 'jl-mask';
  edgeCanvas.className = 'jl-edges';
  pane.appendChild(maskCanvas);
  pane.appendChild(edgeCanvas);

  const scratch = document.createElement('canvas');
  let shapes = [];
  let areaRing = null;
  let opacity = opts.opacity ?? 0.62;
  let visible = true;
  let size = { x: 0, y: 0 };
  let raf = null;
  // Projizierte Punkte pro Zoomstufe zwischenspeichern: beim Schwenken ändert sich
  // nur der Pixel-Ursprung, nicht die Projektion.
  let projCache = { zoom: null, items: null };

  function setSize() {
    const s = map.getSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    size = s;
    for (const c of [maskCanvas, edgeCanvas, scratch]) {
      c.width = Math.round(s.x * dpr);
      c.height = Math.round(s.y * dpr);
      if (c !== scratch) {
        c.style.width = `${s.x}px`;
        c.style.height = `${s.y}px`;
      }
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  function reposition() {
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(maskCanvas, topLeft);
    L.DomUtil.setPosition(edgeCanvas, topLeft);
  }

  function projectAll() {
    const zoom = map.getZoom();
    if (projCache.zoom === zoom && projCache.items) return projCache.items;
    const items = shapes.map((s) => ({
      kind: s.kind,
      color: s.color,
      exclude: s.exclude,
      pts: (s.ring || s.line || []).map((p) => map.project(p, zoom)),
      ref: s.excludeRef ? map.project(s.excludeRef, zoom) : null,
    }));
    if (areaRing) {
      // Alles AUSSERHALB des Spielgebiets fällt weg
      items.push({
        kind: 'ring', exclude: 'outside', area: true,
        pts: areaRing.map((p) => map.project(p, zoom)),
      });
    }
    projCache = { zoom, items };
    return items;
  }

  function toScreen(pt, origin) {
    return { x: pt.x - origin.x, y: pt.y - origin.y };
  }

  function tracePath(ctx, pts, origin) {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const p = toScreen(pts[i], origin);
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
  }

  // Halbebene: die Trennlinie wird über den Bildrand hinaus verlängert und auf der
  // wegfallenden Seite zu einem Polygon geschlossen.
  function halfPlanePolygon(pts, ref, origin) {
    const big = Math.hypot(size.x, size.y) * 4 + 2000;
    const a = toScreen(pts[0], origin);
    const b = toScreen(pts[pts.length - 1], origin);
    let vx = b.x - a.x, vy = b.y - a.y;
    const vlen = Math.hypot(vx, vy) || 1;
    vx /= vlen; vy /= vlen;
    let nx = -vy, ny = vx;
    const r = toScreen(ref, origin);
    const mid = toScreen(pts[Math.floor(pts.length / 2)], origin);
    if ((r.x - mid.x) * nx + (r.y - mid.y) * ny < 0) { nx = -nx; ny = -ny; }
    const line = pts.map((p) => toScreen(p, origin));
    return [
      { x: a.x - vx * big, y: a.y - vy * big },
      ...line,
      { x: b.x + vx * big, y: b.y + vy * big },
      { x: b.x + vx * big + nx * big, y: b.y + vy * big + ny * big },
      { x: a.x - vx * big + nx * big, y: a.y - vy * big + ny * big },
    ];
  }

  function fillPoly(ctx, poly) {
    ctx.beginPath();
    poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fill();
  }

  function draw() {
    raf = null;
    const mctx = maskCanvas.getContext('2d');
    const ectx = edgeCanvas.getContext('2d');
    mctx.clearRect(0, 0, size.x, size.y);
    ectx.clearRect(0, 0, size.x, size.y);
    maskCanvas.style.opacity = visible ? String(opacity) : '0';
    edgeCanvas.style.opacity = visible ? '1' : '0';
    if (!visible) return;

    // Projektionskoordinate der linken oberen Bildschirmecke – alle Punkte werden relativ dazu gezeichnet
    const nw = map.containerPointToLatLng([0, 0]);
    const org = map.project(nw, map.getZoom());
    const sctx = scratch.getContext('2d');

    for (const item of projectAll()) {
      if (!item.pts.length) continue;
      sctx.clearRect(0, 0, size.x, size.y);
      sctx.globalCompositeOperation = 'source-over';
      sctx.fillStyle = MASK_COLOR;

      if (item.kind === 'ring') {
        if (item.exclude === 'inside') {
          tracePath(sctx, item.pts, org);
          sctx.fill();
        } else {
          sctx.fillRect(0, 0, size.x, size.y);
          sctx.globalCompositeOperation = 'destination-out';
          tracePath(sctx, item.pts, org);
          sctx.fill();
        }
      } else {
        fillPoly(sctx, halfPlanePolygon(item.pts, item.ref, org));
      }

      mctx.globalCompositeOperation = 'source-over';
      mctx.drawImage(scratch, 0, 0, size.x, size.y);

      // Kante nachzeichnen, damit einzelne Grenzen auch in überlagerten Zonen sichtbar sind
      ectx.strokeStyle = item.area ? 'rgba(226,232,240,.85)' : (item.color || 'rgba(148,197,255,.75)');
      ectx.lineWidth = item.area ? 2 : 1.5;
      ectx.setLineDash(item.area ? [6, 4] : []);
      ectx.beginPath();
      const pts = item.kind === 'ring' ? [...item.pts, item.pts[0]] : item.pts;
      pts.forEach((p, i) => {
        const s = toScreen(p, org);
        if (i) ectx.lineTo(s.x, s.y); else ectx.moveTo(s.x, s.y);
      });
      ectx.stroke();
    }
  }

  function schedule() {
    if (raf == null) raf = requestAnimationFrame(draw);
  }

  function onMove() { reposition(); schedule(); }
  function onZoomStart() { maskCanvas.style.visibility = 'hidden'; edgeCanvas.style.visibility = 'hidden'; }
  function onZoomEnd() {
    maskCanvas.style.visibility = '';
    edgeCanvas.style.visibility = '';
    setSize(); reposition(); schedule();
  }
  function onResize() { setSize(); reposition(); schedule(); }

  map.on('move', onMove);
  map.on('zoomstart', onZoomStart);
  map.on('zoomend', onZoomEnd);
  map.on('resize', onResize);
  setSize(); reposition();

  return {
    setShapes(next) { shapes = next || []; projCache = { zoom: null, items: null }; schedule(); },
    setArea(ring) { areaRing = ring; projCache = { zoom: null, items: null }; schedule(); },
    setOpacity(v) { opacity = v; schedule(); },
    setVisible(v) { visible = v; schedule(); },
    redraw: schedule,
    destroy() {
      map.off('move', onMove); map.off('zoomstart', onZoomStart);
      map.off('zoomend', onZoomEnd); map.off('resize', onResize);
      maskCanvas.remove(); edgeCanvas.remove();
    },
  };
}
