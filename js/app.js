/* Routile frontend: drag out zones, drop a start pin, compute, then drive. */

import * as config from './config.js';
import { Area } from './area.js';
import { DetailLayer } from './detail.js';
import { gpxZip, fileStamp } from './gpx.js';
import { openCache } from './cache.js';
import { fetchIdentify, previewRule } from './osm.js';
import {
  MAX_QUERY_RULES, MAX_RULES, TAG_FILTER_AS_QUERY, looksLikeTagFilter, parseTagFilter,
} from './selection.js';

const $ = (id) => document.getElementById(id);

// The three ways to draw. Each one is a full drag gesture: press, move, release.
const SHAPES = ['rect', 'circle', 'freehand'];

// Which basemap is showing, and so which route palette reads on it. Not a page
// theme: the panel is dark whichever map is picked.
const BASEMAP_KEY = 'routile-basemap';
let basemap = config.BASEMAPS[0];

const palette = () =>
  (basemap.dark ? config.ROUTE_PALETTE_DARK : config.ROUTE_PALETTE_LIGHT);

const sessionColor = (i) => palette()[i % palette().length];

const ROUTE_WEIGHT = 3;

// Half a carriageway: each pass is drawn this far right of its own direction of
// travel, so a street driven both ways shows as two lines rather than one.
const OFFSET_M = 4.5;
const ARROW_SPACING_M = 130;
const ARROW_ZOOM = 15;      // below this an arrow is smaller than the junction
const POINT_ZOOM = 16;      // waypoints are dense; they need more room still

const state = {
  regions: [],         // the merged area: a MultiPolygon in [lon, lat]
  regionLayers: [],    // index-aligned with regions
  // {osm way id -> {drive, ...}}: what the user says a road really is, where
  // OSM has it wrong. Survives a recompute, and travels in metadata.json with
  // the route it produced.
  fixes: {},
  // [{op, kind, text}]: which roads in the zones must be driven. Empty means
  // all of them. See selection.js.
  rules: [],
  // [{ref, name}]: restaurants the breaks never stop at. See the banned list.
  bannedPlaces: [],
  streetLayers: [],    // one line per coverage state, while editing
  focusLayers: [],     // the hovered and selected streets, over those
  routeArrows: null,   // kept so the editor can hand the map back as it found it
  fixWay: '',          // which street the card is open on, '' for none
  fixAt: null,         // where on that street the card is anchored
  cardPopup: null,     // the card itself, reused rather than rebuilt
  cardWired: false,    // its one delegated listener is on
  cardHiding: false,   // putting the card away, as against letting the street go
  pickingRoad: false,
  hoverRoad: null,     // drawn heavier; nothing else, so nothing chases the eye
  fixModeOn: false,    // what syncFixMode() last acted on, so it can do nothing
  roadIndex: new Map(),  // way id -> { road, src }: the streets the editor knows
  baseline: null,      // the unedited drive, so a fix can never hide a street
  resumeSelect: false, // Edit coverage was armed when this recompute started
  keepView: false,     // the editor asked for this recompute: leave the view be
  startLatLng: null,
  startMarker: null,
  routeLayers: [],     // one polyline per session, index-aligned with the legend
  sessionPoints: [],   // the offset points behind each of those polylines
  detail: null,        // the canvas of arrows and waypoint dots
  pinned: null,        // clicked in the legend; null is the whole route
  shown: null,         // the highlight on the map, pin or pointer preview
  mode: 'rect',        // rect | circle | freehand | pan | pin | select
  lastShape: 'rect',   // which tool a shift+drag uses while panning
  jobId: 0,
  result: null,
  checkTimer: null,
  searching: false,
  progress: null,      // {phase, message, fraction} of the running job
  started: 0,
  ticker: null,
  confirm: null,       // what the map alert's Accept button runs, if it has one
};

/* ------------------------------------------------------------------ map */
// boxZoom off: it binds shift+drag, which shift+drag drawing needs. zoomControl
// off: the wheel, the keyboard and a pinch all zoom already.
const map = L.map('map', { zoomControl: false, boxZoom: false })
  .setView([48.148, 17.107], 14);

// Asked of the input the device has, not the window width, so a narrow desktop
// window keeps its mouse affordances and a large tablet loses them.
const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
document.documentElement.classList.toggle('is-touch', coarsePointer);

// The default prefix carries a title tooltip; this one is the same credit without it.
map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');

const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// interactive:false throughout: a zone is a backdrop, not a control, and would
// otherwise swallow hovers while you draw the next one over it.
// Dashed once drawn, not just while drafting: a solid outline reads as a
// feature on the map, a dashed one as something the user put there.
const AREA_STYLE = () => ({
  color: cssVar('--zone'), weight: 2, fillOpacity: 0.08,
  dashArray: '6,4', interactive: false,
});
// Green joins, red crops: a draft says which before it is let go of.
const opColor = (op) => cssVar(op === 'subtract' ? '--cut' : '--zone');
const DRAFT_STYLE = (op) => ({
  color: opColor(op), weight: 2, fillOpacity: 0.1, dashArray: '5,4',
  interactive: false,
});

// Same glyph as the Start button and the cursor that places it.
const START_ICON = L.divIcon({
  className: 'start-pin',
  html: '<svg viewBox="0 0 24 24" aria-hidden="true">'
      + '<path d="M12 21s6.5-6.2 6.5-11a6.5 6.5 0 1 0-13 0C5.5 14.8 12 21 12 21z"/>'
      + '<circle cx="12" cy="10" r="2.6"/></svg>',
  iconSize: [60, 60],
  iconAnchor: [30, 54],      // the pin's tip, not its centre, marks the spot
});

// Inside the map container, so Leaflet must not read clicks and drags on them
// as map gestures.
for (const id of ['topbar', 'search', 'legend']) {
  L.DomEvent.disableClickPropagation($(id));
  L.DomEvent.disableScrollPropagation($(id));
}
// Leaflet's keyboard handler is on the map container, which the search box sits
// inside; without this, arrow keys pan the map mid-word.
for (const type of ['keydown', 'keyup', 'keypress']) {
  L.DomEvent.on($('search-input'), type, L.DomEvent.stopPropagation);
}

// Arrows and waypoint dots on their own canvas, redrawn for the visible area,
// so their cost is set by the screen rather than the route's length.
state.detail = new DetailLayer({
  arrowZoom: ARROW_ZOOM,
  pointZoom: POINT_ZOOM,
  halo: cssVar('--map-bg'),
  dot: cssVar('--map-ink'),
}).addTo(map);

// The docked top bar and session list take real height from the map. Lay out
// first, then tell Leaflet, or it keeps drawing for the size it had.
new ResizeObserver(() => {
  layoutOverlays();
  map.invalidateSize({ animate: false });
}).observe($('stage'));

/* ------------------------------------------------------------- basemap */
// Declared in config.js. The CARTO ones need a key and drop out without one.
const BASEMAP_CHOICES = config.BASEMAPS.filter(
  (m) => !m.needsKey || config.CARTO_API_KEY);

let tileLayer = null;

// {r} in a URL is Leaflet's retina placeholder: '@2x' on a hidpi screen, empty
// elsewhere. OSM serves no @2x, so only CARTO's URLs carry it.
function addTiles(spec) {
  const url = spec.needsKey
    ? `${spec.url}?key=${encodeURIComponent(config.CARTO_API_KEY)}`
    : spec.url;
  const next = L.tileLayer(url, {
    maxZoom: spec.maxZoom,
    // CORS, so the cached tiles can be drawn onto the exported image's canvas.
    crossOrigin: 'anonymous',
    attribution: spec.attribution,
  });
  // New tiles go under what is drawn, and the old layer only goes once they
  // load, or the switch flashes the empty container colour.
  next.addTo(map);
  next.getContainer().style.zIndex = 1;
  const old = tileLayer;
  tileLayer = next;
  if (old) next.once('load', () => map.removeLayer(old));

  // A keyed basemap fails wholesale, not tile by tile: CARTO binds a key to one
  // origin and a spent quota looks the same, and either way it is a blank map.
  // Fall back to the keyless one. Counted, not tripped on the first error,
  // since a single tile can fail for reasons that are nobody's fault.
  if (!spec.needsKey) return;
  let bad = 0;
  next.on('tileerror', () => {
    if (++bad < 3 || tileLayer !== next) return;
    next.off('tileerror');
    const plain = BASEMAP_CHOICES.find((m) => !m.needsKey);
    if (plain) setBasemap(plain.id, { save: false });
  });
}

/* The marks answer to the ground they sit on, so palette, zone green and halo
   all move with the tiles. They come from the [data-map] block in the
   stylesheet: stamp the attribute first, refresh everything that reads a
   variable after. */
function setBasemap(id, { save = true } = {}) {
  basemap = BASEMAP_CHOICES.find((m) => m.id === id) || BASEMAP_CHOICES[0];
  const root = document.documentElement;
  root.dataset.map = basemap.dark ? 'dark' : 'light';
  // OSM publishes no dark tiles; its dark option is the daylight tile inverted.
  if (basemap.invert) root.dataset.tiles = 'inverted';
  else delete root.dataset.tiles;
  addTiles(basemap);

  drawRegions();                                  // zones, in the new green
  state.routeLayers.forEach((line, i) => {
    if (line) line.setStyle({ color: sessionColor(i) });
  });
  state.detail.restyle({
    colors: state.routeLayers.map((_, i) => sessionColor(i)),
    halo: cssVar('--map-bg'),
    dot: cssVar('--map-ink'),
  });
  // Not the All sessions row: its stripe is there to hold the column, not to
  // carry a colour.
  for (const stripe of $('legend').querySelectorAll('.legend-item:not(.legend-all) .stripe')) {
    stripe.style.background = sessionColor(sessionOf(stripe.closest('.legend-item')));
  }
  // The restyle above cleared the per-session opacity the highlight sets.
  applyHighlight(state.shown, { scroll: false });
  // The editor's colours come from the same [data-map] block.
  drawStreets();
  drawFocus();

  $('basemap-label').textContent = basemap.label;
  for (const li of $('basemap-list').children) {
    li.setAttribute('aria-selected', String(li.dataset.id === basemap.id));
  }
  if (save) {
    try { localStorage.setItem(BASEMAP_KEY, basemap.id); } catch (err) { /* private mode */ }
  }
}

/* ------------------------------------------------------- the map picker */
$('basemap-list').innerHTML = BASEMAP_CHOICES.map(
  (m) => `<li role="option" aria-selected="false" data-id="${m.id}">`
       + `${escapeHtml(m.label)}</li>`).join('');

// One map on offer is not a choice. That is the keyless case.
const onlyOneMap = BASEMAP_CHOICES.length < 2;
$('basemap-field').classList.toggle('hidden', onlyOneMap);
$('basemap-sep').classList.toggle('hidden', onlyOneMap);

// Open state lives in aria-expanded, so the attribute a screen reader reads is
// the one the stylesheet turns the chevron with. `cursor` is the keyboard's
// position, which is not the selection until Enter.
function pickerOpen() { return $('basemap-button').getAttribute('aria-expanded') === 'true'; }

function openPicker(open) {
  $('basemap-button').setAttribute('aria-expanded', String(open));
  $('basemap-list').classList.toggle('hidden', !open);
  if (open) moveCursor([...$('basemap-list').children]
    .findIndex((li) => li.dataset.id === basemap.id));
  else clearCursor();
}

function clearCursor() {
  for (const li of $('basemap-list').children) li.classList.remove('cursor');
}

function moveCursor(index) {
  const rows = [...$('basemap-list').children];
  if (!rows.length) return;
  const at = (index + rows.length) % rows.length;
  clearCursor();
  rows[at].classList.add('cursor');
  rows[at].scrollIntoView({ block: 'nearest' });
}

function cursorIndex() {
  return [...$('basemap-list').children].findIndex((li) => li.classList.contains('cursor'));
}

$('basemap-button').addEventListener('click', () => openPicker(!pickerOpen()));

$('basemap-list').addEventListener('click', (ev) => {
  const li = ev.target.closest('li');
  if (!li) return;
  setBasemap(li.dataset.id);
  openPicker(false);
  $('basemap-button').focus();
});

// Hover and keyboard share one cursor, so the mouse leaves no stale highlight.
$('basemap-list').addEventListener('mousemove', (ev) => {
  const li = ev.target.closest('li');
  if (li) moveCursor([...$('basemap-list').children].indexOf(li));
});

$('basemap-field').addEventListener('keydown', (ev) => {
  const open = pickerOpen();
  if (ev.key === 'Escape' && open) {
    ev.stopPropagation();          // Escape also cancels a half-drawn zone
    openPicker(false);
    $('basemap-button').focus();
  } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    if (!open) openPicker(true);
    else moveCursor(cursorIndex() + (ev.key === 'ArrowDown' ? 1 : -1));
  } else if (open && (ev.key === 'Enter' || ev.key === ' ')) {
    ev.preventDefault();
    const li = $('basemap-list').children[cursorIndex()];
    if (li) setBasemap(li.dataset.id);
    openPicker(false);
    $('basemap-button').focus();
  } else if (ev.key === 'Home' || ev.key === 'End') {
    if (!open) return;
    ev.preventDefault();
    moveCursor(ev.key === 'Home' ? 0 : $('basemap-list').children.length - 1);
  }
});

// Anywhere else - including the map, and including a tab away.
document.addEventListener('pointerdown', (ev) => {
  if (pickerOpen() && !$('basemap-field').contains(ev.target)) openPicker(false);
});
// Tabbing away closes it, and only tabbing: relatedTarget is null when focus
// lands on something that cannot take it, and a list row is exactly that, so
// without the guard a pointerdown on a row closed the list out from under it.
$('basemap-field').addEventListener('focusout', (ev) => {
  if (!ev.relatedTarget) return;
  if (pickerOpen() && !$('basemap-field').contains(ev.relatedTarget)) openPicker(false);
});

let storedMap = null;
try { storedMap = localStorage.getItem(BASEMAP_KEY); } catch (err) { /* private mode */ }
setBasemap(storedMap || config.BASEMAP_DEFAULT, { save: false });

/* -------------------------------------------------------------- drawing */
/* One gesture, three shapes, one code path for mouse, finger and pen.
   `drag.tool` is fixed at the press, so a key released mid-drag cannot change
   what is being drawn.

   Two ways to draw, and the hand picks without being asked: hold the button and
   the shape follows the drag, or click once and it follows the bare pointer
   until a second click ends it. The second suits a long outline, and costs
   nothing to offer, since a press that goes nowhere was never a drag.
   `drag.sticky` says which is under way.

   The pointer is captured for the held kind, so a drag leaving the map keeps
   reporting. While a shape tool is armed Leaflet's dragging is off (setMode),
   so one finger draws rather than pans; two still pinch. */
let drag = null;   // { tool, op, pointerId, from, points, layer, ring, closing, sticky }

// Add joins the shape to the area, Subtract crops it back out. Read at the
// press and kept in `drag`, so switching mid-gesture cannot change the answer.
const drawOp = () => ($('op-subtract').checked ? 'subtract' : 'add');

const MIN_DRAG_PX = 12;        // below this, a drag is an accidental click
const FREEHAND_STEP_PX = 5;    // sampling distance while drawing by hand
const FREEHAND_SIMPLIFY_PX = 3;
const SNAP_PX = 22;            // radius of the "release here to close" ring
const SNAP_MIN_POINTS = 6;     // don't offer to close before a loop exists

const mapEl = $('map');

function activeTool(ev) {
  if (SHAPES.includes(state.mode)) return state.mode;
  // Shift+drag draws without leaving pan mode, using the last shape picked.
  if (state.mode === 'pan' && ev && ev.shiftKey) return state.lastShape;
  return null;
}

// Viewport coordinates in, Leaflet's map-relative ones out.
function pointerLatLng(ev) {
  const box = mapEl.getBoundingClientRect();
  return map.containerPointToLatLng(
    L.point(ev.clientX - box.left, ev.clientY - box.top));
}

mapEl.addEventListener('pointerdown', (ev) => {
  // A mouse draws with the left button; the other two are the pan grip below.
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  // Already following the pointer from an earlier click, so this press starts
  // the click that ends it. Finished at the release, not here, so pressing and
  // dragging from here still adjusts it first.
  if (drag && drag.sticky) {
    ev.preventDefault();
    drag.pointerId = ev.pointerId;
    return;
  }
  // A second finger mid-drag is a pinch, not a second zone.
  if (drag) return;
  if (ev.target.closest('.leaflet-control')) return;
  // A break's marker is clicked for its card, whatever tool is armed.
  if (ev.target.closest('.stop-marker, .leaflet-popup')) return;
  const tool = activeTool(ev);
  if (!tool) return;

  ev.preventDefault();
  // Captured, so the gesture still arrives here if it wanders off the map.
  try { mapEl.setPointerCapture(ev.pointerId); } catch (err) { /* pointer gone */ }

  const at = pointerLatLng(ev);
  const op = drawOp();
  drag = { tool, op, pointerId: ev.pointerId, from: at, points: [at],
           layer: null, ring: null, closing: false, sticky: false, moved: false };

  if (tool === 'rect') {
    drag.layer = L.rectangle(L.latLngBounds(at, at), DRAFT_STYLE(op));
  } else if (tool === 'circle') {
    drag.layer = L.circle(at, { radius: 1, ...DRAFT_STYLE(op) });
  } else {
    drag.layer = L.polyline([at], DRAFT_STYLE(op));
    // A ring showing where to finish. Without it the shape closes with a
    // straight line from wherever you stopped - a spike across the map.
    drag.ring = L.circleMarker(at, {
      radius: SNAP_PX, color: opColor(op), weight: 1.5,
      dashArray: '4,3', fillOpacity: 0.06, interactive: false,
    }).addTo(map);
  }
  drag.layer.addTo(map);
});

mapEl.addEventListener('pointermove', (ev) => {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  if (tempPan) return;            // frozen under the pan grip; see below
  const at = pointerLatLng(ev);
  // Went somewhere, so the release below is the end of a drag whatever it ends
  // up next to. Sampled here rather than at the release, which is the whole
  // point: a freehand outline finishes where it started.
  if (!drag.moved && pixelGap(drag.from, at) >= MIN_DRAG_PX) drag.moved = true;
  if (drag.tool === 'rect') {
    drag.layer.setBounds(L.latLngBounds(drag.from, at));
  } else if (drag.tool === 'circle') {
    drag.layer.setRadius(drag.from.distanceTo(at));
  } else {
    // Sampled: a slow hand emits hundreds of points a second, and the outline
    // is smoothed at the end anyway.
    const last = drag.points[drag.points.length - 1];
    if (pixelGap(last, at) >= FREEHAND_STEP_PX) drag.points.push(at);
    setClosing(withinSnap(at));
    drag.layer.setLatLngs(
      drag.closing ? drag.points.concat([drag.from]) : drag.points
    );
  }
});

mapEl.addEventListener('pointerup', (ev) => {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  const at = pointerLatLng(ev);
  /* Let go having never gone anywhere: that was a click, not a drag. Hand the
     shape to the bare pointer rather than finish it here too small to keep.

     `moved` and not the distance from the start, which is a different question
     and got a freehand outline released in the snap ring exactly wrong: closing
     a loop means coming back to within a few pixels of where it began, so the
     gesture was read as a click and the finished outline stuck to the pointer
     and would not let go. */
  if (!drag.sticky && !drag.moved) {
    drag.sticky = true;
    return;
  }
  finishDrag(at);
});
// The system took the gesture away: a phone call, a system gesture, a pinch.
mapEl.addEventListener('pointercancel', (ev) => {
  if (drag && ev.pointerId === drag.pointerId) finishDrag(null);
});

// A press off the map while a shape follows the pointer drops the shape: there
// is nothing out there to finish it with.
document.addEventListener('pointerdown', (ev) => {
  if (drag && drag.sticky && !mapEl.contains(ev.target)) finishDrag(null);
});

function withinSnap(latlng) {
  return drag.points.length >= SNAP_MIN_POINTS
    && pixelGap(drag.from, latlng) <= SNAP_PX;
}

function setClosing(closing) {
  if (drag.closing === closing) return;
  drag.closing = closing;
  drag.ring.setStyle(closing
    ? { fillOpacity: 0.28, weight: 2.5, dashArray: null }
    : { fillOpacity: 0.06, weight: 1.5, dashArray: '4,3' });
}

function pixelGap(a, b) {
  return map.latLngToContainerPoint(a).distanceTo(map.latLngToContainerPoint(b));
}

function discardDraft() {
  if (!drag) return;
  try { mapEl.releasePointerCapture(drag.pointerId); } catch (err) { /* already gone */ }
  if (drag.layer) map.removeLayer(drag.layer);
  if (drag.ring) map.removeLayer(drag.ring);
  drag = null;
}

function finishDrag(latlng) {
  if (!drag) return;
  const { tool, op, from, points, closing } = drag;
  discardDraft();
  if (!latlng) return;      // cancelled: Escape, or the gesture was taken away

  if (tool === 'rect') {
    const bounds = L.latLngBounds(from, latlng);
    if (pixelGap(bounds.getNorthWest(), bounds.getSouthEast()) < MIN_DRAG_PX) return;
    applyShape({
      type: 'rect',
      west: bounds.getWest(), south: bounds.getSouth(),
      east: bounds.getEast(), north: bounds.getNorth(),
    }, op);
  } else if (tool === 'circle') {
    // Half the rectangle's threshold: this is a radius, not a diagonal.
    if (pixelGap(from, latlng) < MIN_DRAG_PX / 2) return;
    applyShape({
      type: 'circle',
      lat: from.lat, lon: from.lng, radius_m: from.distanceTo(latlng),
    }, op);
  } else {
    // Released inside the ring: close on the start point exactly, not on
    // wherever the pointer drifted to inside it.
    const raw = closing ? points : points.concat([latlng]);
    const outline = simplifyOutline(raw);
    if (outline.length < 3) return;
    applyShape({ type: 'freehand', points: outline.map((p) => [p.lat, p.lng]) }, op);
  }
}

function simplifyOutline(latlngs) {
  // In screen pixels, where the wobble is: 3 px drops hand tremor and keeps
  // every deliberate turn, at any zoom.
  const pts = latlngs.map((p) => map.latLngToContainerPoint(p));
  return L.LineUtil.simplify(pts, FREEHAND_SIMPLIFY_PX)
    .map((p) => map.containerPointToLatLng(p));
}

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') finishDrag(null);
});

// A click on the map places the start pin and nothing else. What the legend has
// picked is let go in the legend, by choosing All sessions.
map.on('click', (ev) => {
  if (state.mode !== 'pin') return;
  setStart(ev.latlng);
  setMode(state.lastShape);
});

/* --------------------------------------------------- temporary pan grip */
/* Middle or right button pans whatever tool is armed and hands it back on
   release, with the Pan button lit while it lasts. Done by hand because
   Leaflet's drag handler answers to the left button only, which the draw tools
   need.

   A half-drawn zone is frozen for the pan rather than thrown away, so a long
   outline can be walked across the map a screenful at a time. It costs nothing
   to hold: the draft is a list of latitudes and longitudes, so it rides along
   under the map on its own. Pointer moves are dropped while the grip is held,
   and a pan drag keeps the same ground under the cursor, so the pen picks up
   exactly where it was put down. */
const PAN_BUTTONS = new Set([1, 2]);
let tempPan = null;

mapEl.addEventListener('mousedown', (ev) => {
  if (tempPan || !PAN_BUTTONS.has(ev.button)) return;
  if (ev.target.closest('.leaflet-control')) return;
  ev.preventDefault();
  tempPan = { mode: state.mode, x: ev.clientX, y: ev.clientY };
  setMode('pan');
  mapEl.classList.add('grabbing');
});

document.addEventListener('mousemove', (ev) => {
  if (!tempPan) return;
  const dx = ev.clientX - tempPan.x;
  const dy = ev.clientY - tempPan.y;
  tempPan.x = ev.clientX;
  tempPan.y = ev.clientY;
  if (dx || dy) map.panBy([-dx, -dy], { animate: false });
});

document.addEventListener('mouseup', (ev) => {
  if (!tempPan || !PAN_BUTTONS.has(ev.button)) return;
  setMode(tempPan.mode);          // stays on Pan if that is where it started
  tempPan = null;
  mapEl.classList.remove('grabbing');
});

// The right button is a pan grip here, so its menu would fire on every release
// - except over the search box, where a paste menu is the whole point.
mapEl.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
});

/* ------------------------------------------------------- the drawn zones */
/* Zones merge as they are drawn: overlapping ones become one outline, and one
   drawn across a gap joins both. Zones touching nothing stay separate regions
   of the same area, computed as one job.

   Subtract crops instead: the shape is cut out of what is there, which may open
   a hole, split one region into two, or clear the map entirely.

   `state.regions` is a GeoJSON-style MultiPolygon in [lon, lat]: one entry per
   region, each an outline followed by any holes. */
function applyShape(shape, op) {
  applyGeometry([shapeRing(shape)], op);
}

// Merge a polygon or multipolygon, in polygon-clipping's [lon, lat] form, into
// the zones - or cut it out of them. A drawn shape and an OSM boundary both
// come through here, so a boundary zone is a zone like any other.
function applyGeometry(poly, op) {
  let next;
  try {
    if (op === 'subtract') {
      next = state.regions.length
        ? polygonClipping.difference(state.regions, poly) : [];
    } else {
      // Unioning a lone polygon with itself is not a no-op: it also resolves a
      // freehand outline that crossed itself.
      next = state.regions.length
        ? polygonClipping.union(state.regions, poly)
        : polygonClipping.union(poly);
    }
  } catch (err) {
    // Boolean ops can fail on a pathological outline. An unmerged zone beats
    // losing the drag, and everything downstream copes with overlap - but a cut
    // has no such fallback, so it leaves the area exactly as it was.
    console.warn('could not apply that zone', err);
    if (op === 'subtract') return;
    next = state.regions.concat([poly]);
  }
  state.regions = next;
  dropAllPreviews();
  drawRegions();
  // A different area is a different question: the streets the editor was
  // drawing belong to the old one.
  dropBaseline();
  closeRoadCard();
  clearRoute();
  syncZones();
  saveSession();
}

// Clear means start over: zones, route and start pin all go - and, since this
// is the only thing that does, so does what a reload would have come back to.
function clearZones() {
  state.regions = [];
  dropAllPreviews();
  drawRegions();
  dropBaseline();
  closeRoadCard();
  clearRoute();
  clearStart();
  hideMapAlert();
  syncZones();
  saveSession();
}

function drawRegions() {
  for (const layer of state.regionLayers) map.removeLayer(layer);
  // Leaflet reads rings as outline first then holes, the same order
  // polygon-clipping produces, so a merged hole draws as a hole.
  state.regionLayers = state.regions.map((rings) =>
    L.polygon(rings.map((ring) => ring.map(([x, y]) => [y, x])), AREA_STYLE())
      .addTo(map));
}

// A drawn shape as one closed ring of [lon, lat].
function shapeRing(shape) {
  let ring;
  if (shape.type === 'rect') {
    ring = [[shape.west, shape.south], [shape.east, shape.south],
            [shape.east, shape.north], [shape.west, shape.north]];
  } else if (shape.type === 'circle') {
    // The same ellipse-in-degrees the pipeline builds, so what is merged is
    // what the router treats as required.
    const dlat = (shape.radius_m / EARTH_R) * 180 / Math.PI;
    const cosLat = Math.max(Math.cos(rad(shape.lat)), 1e-6);
    const dlon = (shape.radius_m / (EARTH_R * cosLat)) * 180 / Math.PI;
    ring = [];
    for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
      const a = 2 * Math.PI * i / CIRCLE_SEGMENTS;
      ring.push([shape.lon + dlon * Math.cos(a), shape.lat + dlat * Math.sin(a)]);
    }
  } else {
    ring = shape.points.map(([lat, lng]) => [lng, lat]);
  }
  return ring.concat([ring[0]]);    // polygon-clipping wants closed rings
}

// Matches area.js, so the circle drawn, merged and covered are one polygon.
const CIRCLE_SEGMENTS = 64;
const EARTH_R = 6_371_008.8;

// The merged area, as the pipeline's payload.
function shapePayload() {
  if (!state.regions.length) return null;
  const shapes = state.regions.map((rings) => {
    const out = { type: 'polygon', points: rings[0].map(([x, y]) => [y, x]) };
    if (rings.length > 1) {
      out.holes = rings.slice(1).map((ring) => ring.map(([x, y]) => [y, x]));
    }
    return out;
  });
  return shapes.length === 1 ? shapes[0] : { type: 'multi', shapes };
}

function syncZones() {
  const n = state.regions.length;
  syncClear();
  $('compute').disabled = n === 0;

  const info = $('area-info');
  info.classList.toggle('muted', n === 0);
  if (!n) {
    info.textContent = '--';
    return;
  }
  // Now, not on the debounce: the exact figure costs a fraction of a
  // millisecond and a placeholder flickering for 200 ms is worse than none.
  runCheck();
}

function areaText(km2, zones) {
  return `${km2.toFixed(2)} km²${zones > 1 ? ` · ${zones} zones` : ''}`;
}

const KM_PER_DEG = 111.32;

function rad(deg) { return deg * Math.PI / 180; }

function setStart(latlng) {
  state.startLatLng = latlng;
  if (state.startMarker) map.removeLayer(state.startMarker);
  state.startMarker = L.marker(latlng, { icon: START_ICON, keyboard: false })
    .addTo(map);
  $('pin-info').classList.remove('muted');
  $('pin-info').textContent =
    `${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`;
  $('mode-pin').classList.add('has-start');
  syncClear();
  saveSession();
}

function clearStart() {
  state.startLatLng = null;
  if (state.startMarker) map.removeLayer(state.startMarker);
  state.startMarker = null;
  $('pin-info').classList.add('muted');
  $('pin-info').textContent = 'area centre';
  $('mode-pin').classList.remove('has-start');
  syncClear();
  saveSession();
}

// Clear has work to do as long as there is a zone or a pin on the map.
function syncClear() {
  $('clear-zones').disabled = !state.regions.length && !state.startLatLng;
  // There is nothing to cut into on an empty map, and a red draft that quietly
  // did nothing would read as a bug. Cutting the last zone away hands the
  // selector back to Add on its own, so it is never left armed over nothing.
  const empty = !state.regions.length;
  $('op-subtract').disabled = empty;
  $('boundary-subtract').disabled = empty;
  // Keep out stays available: it bars roads rather than cropping the shape, so
  // it has something to do even before a zone is drawn.
  if (empty && $('op-subtract').checked) $('op-add').checked = true;
}

// The Identify tool's card, here rather than with the tool because setMode()
// below puts it away and runs before the rest of the script does.
const ident = {
  popup: null,
  highlight: null,
  ways: [],          // nearest first
  index: 0,          // which of them the card is showing
  checked: new Set(),
  areas: [],         // the admin and cadastral areas the click lies in, most local first
  areaId: null,      // the one picked to limit the rule to, by Overpass area id
  areaLayer: null,   // that area's outline on the map, while it is picked
  areaSeq: 0,        // the pick the outline belongs to; older lookups are dropped
  at: null,
  seq: 0,            // the click the card belongs to; older answers are dropped
};

const TOOL_BUTTONS = {
  select: 'mode-select', pan: 'mode-pan', rect: 'mode-rect', circle: 'mode-circle',
  freehand: 'mode-freehand', pin: 'mode-pin', identify: 'mode-identify',
};

function setMode(mode) {
  state.mode = mode;
  if (SHAPES.includes(mode)) state.lastShape = mode;
  // Buttons rather than radios, so the drawing group can show nothing lit while
  // the start pin is armed. aria-pressed says the same thing out loud.
  for (const [key, id] of Object.entries(TOOL_BUTTONS)) {
    const on = mode === key;
    $(id).classList.toggle('active', on);
    $(id).setAttribute('aria-pressed', String(on));
  }
  const drawing = SHAPES.includes(mode);
  mapEl.classList.toggle('drawing', drawing);
  mapEl.classList.toggle('pinning', mode === 'pin');
  mapEl.classList.toggle('selecting', mode === 'select');
  mapEl.classList.toggle('identifying', mode === 'identify');
  // Leaving the tool puts its card away - but not for the pan grip, which
  // leaves and comes back on every middle-button drag.
  if (!tempPan && mode !== 'identify') closeIdentify();
  /* Arming Edit coverage is what opens the editor, so the map's answer to the
     tool change is the editor's too - except under the pan grip, which leaves
     and re-enters the tool on every drag without the user asking for either.
     Rebuilding the editor's layers there let go of the selected street and left
     the map stuck to the pointer mid-drag. */
  if (!tempPan) syncFixMode();
  // A shape tool owns the drag, which is what lets one finger draw on a touch
  // screen. So does the start pin: with Leaflet's handler live, an unsteady
  // hand panned the map out from under the click instead of dropping the pin.
  // The middle and right buttons still pan and the wheel still zooms.
  const ownsDrag = drawing || mode === 'pin';
  if (ownsDrag) map.dragging.disable(); else map.dragging.enable();
}

for (const [key, id] of Object.entries(TOOL_BUTTONS)) {
  $(id).onclick = () => setMode(key);
}
setMode('rect');

// Clear throws away an outline that took a steady hand and a route that took a
// download and a solve, and nothing here undoes it, so it asks first.
$('clear-zones').onclick = () => {
  showMapAlert('Clear the drawn zones, the start pin and the computed route? '
    + 'Nothing else forgets them, not even a reload.', { accept: clearZones });
};

// Google's /@lat,lon,zoomz form, so the other map opens on what is on this one.
$('open-gmaps').onclick = () => {
  const { lat, lng } = map.getCenter();
  window.open(
    `https://www.google.com/maps/@${lat.toFixed(6)},${lng.toFixed(6)},${map.getZoom()}z`,
    '_blank', 'noopener',
  );
};

/* ----------------------------------------------------------- place search */
// OpenStreetMap's own geocoder: free, no key, asked once per submit rather than
// per keystroke, which is what its usage policy expects.
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

$('search').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const query = $('search-input').value.trim();
  if (!query || state.searching) return;

  const card = $('search');
  state.searching = true;
  card.classList.add('searching');
  card.classList.remove('missed');
  try {
    const url = `${NOMINATIM}?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`the geocoder answered ${res.status}`);
    const hits = await res.json();
    if (!hits.length) {
      card.classList.add('missed');
      showMapAlert(`No place found for "${query}".`);
      return;
    }
    const hit = hits[0];
    const box = hit.boundingbox;    // [south, north, west, east], as strings
    if (box && box.length === 4) {
      // Capped: the box around a single address is metres wide, and zoom 19
      // loses all sense of where you are.
      map.fitBounds([[+box[0], +box[2]], [+box[1], +box[3]]],
        { padding: [24, 24], maxZoom: 16 });
    } else {
      map.setView([+hit.lat, +hit.lon], 15);
    }
    hideMapAlert();
    $('search-input').blur();
  } catch (err) {
    showMapAlert(`Place search failed: ${err.message}`);
  } finally {
    state.searching = false;
    card.classList.remove('searching');
  }
});

/* A zone from a boundary in OSM: a borough, a town, whatever Nominatim knows as
   an area. Its outline arrives simplified - a threshold of 0.00002 degrees is
   about 2 m, far below what decides whether a street is inside - because a
   city's full outline runs to tens of thousands of points, and every one of
   them is tested against every street downstream. One request a second, as
   Nominatim's usage policy asks. */
const BOUNDARY_THRESHOLD_DEG = 0.00002;

async function lookupBoundary(name) {
  const url = `${NOMINATIM}?format=jsonv2&limit=5&polygon_geojson=1`
    + `&polygon_threshold=${BOUNDARY_THRESHOLD_DEG}&q=${encodeURIComponent(name)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`the geocoder answered ${res.status}`);
  const hits = await res.json();
  // The first hit with an outline: the first is often a station or a street
  // named after the place.
  const hit = hits.find((h) => h.geojson
    && (h.geojson.type === 'Polygon' || h.geojson.type === 'MultiPolygon'));
  if (!hit) {
    throw new Error(hits.length
      ? `"${name}" is not an area in OpenStreetMap`
      : `no place found for "${name}"`);
  }
  // polygon-clipping takes GeoJSON's coordinates as they are.
  return { label: hit.display_name, poly: hit.geojson.coordinates, type: hit.geojson.type };
}

$('boundary').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = $('boundary');
  if (form.classList.contains('busy')) return;
  const op = ev.submitter && ev.submitter.value === 'subtract' ? 'subtract' : 'add';
  const names = $('boundary-input').value.split(';').map((s) => s.trim()).filter(Boolean);
  if (!names.length) return;

  form.classList.add('busy');
  const buttons = form.querySelectorAll('button[type=submit]');
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const found = [];
    for (let i = 0; i < names.length; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1100));
      found.push(await lookupBoundary(names[i]));
    }
    for (const b of found) {
      applyGeometry(b.type === 'Polygon' ? [b.poly] : b.poly, op);
      console.info(`boundary zone (${op}): ${b.label}`);
    }
    if (state.regionLayers.length) {
      map.fitBounds(L.featureGroup(state.regionLayers).getBounds(), { padding: [24, 24] });
    }
    hideMapAlert();
  } catch (err) {
    // Nothing is applied unless every name was found, so a typo in the second
    // name does not leave the first one half-done.
    showMapAlert(`Could not add that boundary: ${err.message}.`);
  } finally {
    form.classList.remove('busy');
    $('boundary-add').disabled = false;
    syncClear();
  }
});

$('search-input').addEventListener('input', () => {
  $('search').classList.remove('missed');
});

/* ---------------------------------------------------------------- config */
// Stated in config.js, printed here, and recorded in every metadata.json.
$('repo-version').textContent = config.VERSION;

$('passes').max = String(config.PASSES_MAX);
$('sessions-per-day').max = String(config.SESSIONS_PER_DAY_MAX);
$('sessions-per-day').value = String(config.SESSIONS_PER_DAY_DEFAULT);
$('private-roads').checked = config.INCLUDE_PRIVATE_DEFAULT;
$(config.BOTH_DIRECTIONS_DEFAULT ? 'dir-both' : 'dir-oneway').checked = true;
$('session').value = String(Math.round((config.SESSION_SECONDS_DEFAULT / 3600) * 100) / 100);

function bothDirections() { return $('dir-both').checked; }

function includePrivate() { return $('private-roads').checked; }

function sessionEnabled() { return $('session-enabled').checked; }

function syncSessionField() {
  $('session-field').classList.toggle('hidden', !sessionEnabled());
  $('session-break-field').classList.toggle('hidden', !sessionEnabled());
  $('session-day-field').classList.toggle('hidden', !sessionBreak());
  $('banned-field').classList.toggle('hidden', !sessionBreak());
}

// Whole number from 2 to the cap, or null.
function sessionsPerDay() {
  const raw = $('sessions-per-day').value.trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  return n >= 2 && n <= config.SESSIONS_PER_DAY_MAX ? n : null;
}

// A break needs two sessions to sit between, so it rides on the split.
function sessionBreak() {
  return sessionEnabled() && $('session-restaurant').checked ? 'restaurant' : null;
}
syncSessionField();

/* ------------------------------------------------------------ validation */
function passesValue() {
  const raw = $('passes').value.trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  return n >= 1 ? n : null;
}

const NO_SPLIT_HOURS = 24;   // one session: a session is capped at 24 h

function sessionHours() {
  // Splitting off means one session covering the whole route.
  if (!sessionEnabled()) return NO_SPLIT_HOURS;
  // Decimal hours. Comma accepted: it is the norm across much of Europe.
  const raw = $('session').value.trim().replace(',', '.');
  if (!/^\d*\.?\d+$/.test(raw)) return null;
  const h = parseFloat(raw);
  return Number.isFinite(h) && h >= 0.1 && h <= NO_SPLIT_HOURS ? h : null;
}

function markValid(el, ok) { el.classList.toggle('invalid', !ok); }

// Marks the offending fields, and names the first problem for whoever asks.
function validate() {
  const passes = passesValue();
  const hours = sessionHours();
  markValid($('passes'), passes !== null);
  markValid($('session'), !sessionEnabled() || hours !== null);
  const perDay = sessionsPerDay();
  markValid($('sessions-per-day'), !sessionBreak() || perDay !== null);
  const rules = validateRules();
  if (passes === null) return 'Passes must be a whole number of 1 or more.';
  if (hours === null) return 'Session length must be a number of hours between 0.1 and 24.';
  if (sessionBreak() && perDay === null) {
    return `Sessions per day must be a whole number from 2 to ${config.SESSIONS_PER_DAY_MAX}.`;
  }
  return rules;
}

// The drawn area, or why it cannot be used.
function areaProblem() {
  try {
    Area.fromShape(shapePayload()).validate(config.AREA_CAP_KM2);
    return null;
  } catch (err) {
    return err.message || 'That area cannot be used.';
  }
}

/* -------------------------------------------------------- required roads */
/* The selection rules, one card each. The DOM is rebuilt when a rule is added,
   removed or changes op; typing only updates state.rules and the card's own
   error line, so the field being typed into is never replaced under the caret. */
const RULE_KIND_LABEL = { tags: 'Tag filter', overpass: 'Overpass query' };
const RULE_PLACEHOLDER = {
  tags: '["operator"="..."]',
  overpass: 'way["operator"="..."];\n\nRuns on the road download\'s box unless the\nquery starts with settings of its own.\n{{bbox}} and {{geocodeArea:...}} work as in\noverpass-turbo.',
};

// Whatever a saved session or a hand-edited metadata.json holds, as rules the
// form can show. The worker checks them properly; this only keeps the page up.
function cleanRules(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && (r.kind === 'tags' || r.kind === 'overpass'))
    .map((r) => ({ op: r.op === 'remove' ? 'remove' : 'add', kind: r.kind, text: String(r.text ?? '') }))
    .slice(0, MAX_RULES);
}

// What is wrong with one rule, or null. Tag filters are parsed here with the
// worker's own parser, so a typo shows on the card rather than after a download.
function ruleProblem(rule) {
  const text = rule.text.trim();
  if (!text) return 'Empty - write the rule or remove it.';
  if (rule.kind === 'tags') {
    try {
      parseTagFilter(text);
    } catch (err) {
      return err.message.replace(/^tag filter "[\s\S]*?": /, '');
    }
  } else {
    if (looksLikeTagFilter(text)) return TAG_FILTER_AS_QUERY[0].toUpperCase() + TAG_FILTER_AS_QUERY.slice(1);
    const shortcut = /\{\{(?!\s*(?:bbox\s*|geocodeArea\s*:[^}]*)\}\})[^}]*\}\}/.exec(text);
    if (shortcut) {
      return `${shortcut[0]} is an overpass-turbo shortcut; only {{bbox}} and {{geocodeArea:...}} are filled in here.`;
    }
  }
  return null;
}

function validateRules() {
  let first = null;
  $('rules').querySelectorAll('.rule').forEach((card, i) => {
    const problem = ruleProblem(state.rules[i]);
    card.querySelector('textarea').classList.toggle('invalid', problem !== null);
    card.querySelector('.rule-error').textContent = problem || '';
    if (problem && !first) first = `Required roads, rule ${i + 1}: ${problem}`;
  });
  return first;
}

function renderRules() {
  const box = $('rules');
  box.replaceChildren(...state.rules.map((rule, i) => {
    const card = document.createElement('div');
    card.className = 'rule';

    const head = document.createElement('div');
    head.className = 'rule-head';
    const ops = document.createElement('div');
    ops.className = 'segmented rule-op';
    ops.setAttribute('role', 'radiogroup');
    ops.setAttribute('aria-label', `Rule ${i + 1} adds or removes`);
    for (const [value, label] of [['add', 'Add'], ['remove', 'Remove']]) {
      const l = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = `rule-op-${i}`;
      input.value = value;
      input.checked = rule.op === value;
      input.addEventListener('change', () => { rule.op = value; recolorPreview(rule); rulesChanged(); });
      const span = document.createElement('span');
      span.textContent = label;
      l.append(input, span);
      ops.append(l);
    }
    const kind = document.createElement('span');
    kind.className = 'rule-kind';
    kind.textContent = RULE_KIND_LABEL[rule.kind];
    const meta = document.createElement('span');
    meta.className = 'rule-meta';
    // Draws what this rule matches, so it can be checked before a compute.
    const show = document.createElement('button');
    show.type = 'button';
    show.className = 'rule-show';
    show.innerHTML = EYE_ICON;
    show.addEventListener('click', () => togglePreview(rule));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'rule-del';
    del.setAttribute('aria-label', `Delete rule ${i + 1}`);
    del.textContent = '×';
    del.addEventListener('click', () => {
      dropPreview(rule);
      state.rules.splice(i, 1);
      renderRules();
      rulesChanged();
    });
    head.append(ops, kind, meta, show, del);

    const text = document.createElement('textarea');
    text.rows = rule.kind === 'tags' ? 2 : 5;
    text.spellcheck = false;
    text.autocomplete = 'off';
    text.placeholder = RULE_PLACEHOLDER[rule.kind];
    text.setAttribute('aria-label', `Rule ${i + 1}, ${RULE_KIND_LABEL[rule.kind]}`);
    text.value = rule.text;
    text.addEventListener('input', () => {
      rule.text = text.value;
      // What is drawn answers the old text; a new one has to ask again.
      dropPreview(rule);
      validateRules();
      saveSession();       // debounced; a reload mid-sentence keeps the sentence
    });
    text.addEventListener('change', rulesChanged);

    const error = document.createElement('p');
    error.className = 'rule-error';

    const preview = document.createElement('p');
    preview.className = 'rule-preview';

    card.append(head, text, error, preview);
    card.ruleRef = rule;
    return card;
  }));
  syncPreviewButtons();
  $('add-tag-rule').disabled = state.rules.length >= MAX_RULES;
  $('add-query-rule').disabled = state.rules.length >= MAX_RULES
    || state.rules.filter((r) => r.kind === 'overpass').length >= MAX_QUERY_RULES;
  syncRulesInfo();
}

/* The line under the list, and each card's count from the last compute - but
   only while the rules are still the ones that compute ran with, or the counts
   would be answering a question nobody is asking any more. */
function syncRulesInfo() {
  $('rules-hint').textContent = state.rules.length
    ? 'Only the roads the rules select must be driven. The rest can still be driven to get between them.'
    : 'No rules: every road inside the zones must be driven.';
  const res = state.result;
  const ran = res?.request?.selection;
  const stats = res?.coverage?.selection;
  const current = state.rules.map(({ op, kind, text }) => ({ op, kind, text: text.trim() }));
  const fresh = Array.isArray(ran) && Array.isArray(stats) && stats.length === current.length
    && JSON.stringify(ran) === JSON.stringify(current);
  $('rules').querySelectorAll('.rule-meta').forEach((meta, i) => {
    const s = fresh ? stats[i] : null;
    meta.classList.toggle('warn', !!s && (s.matched === 0 || s.missing > 0));
    if (!s) { meta.textContent = ''; meta.title = ''; return; }
    meta.textContent = s.missing > 0
      ? `${s.matched} ways · ${s.missing} not drivable`
      : `${s.matched} ${s.matched === 1 ? 'way' : 'ways'}`;
    meta.title = s.missing > 0
      ? 'Ways the query returned that are not drivable roads in the download: footways, '
        + 'tracks, or service and private roads while Include service roads is off.'
      : 'Downloaded ways this rule matched, inside the zones or not.';
  });
}

/* Each rule's own matches, drawn on the map at the press of its eye, to test
   the rule before a compute: in the selection cyan if it adds, the cut red if
   it removes. From the same road download a compute of these zones would use
   (see previewRule() in osm.js), so asking here also saves the compute the
   download. With no zone drawn yet, the view stands in for one - if it is
   small enough to download without a second thought.

   A preview answers one question - this text, these zones, this road filter -
   so changing any of them takes it away rather than leaving a stale answer on
   the map. */
const EYE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>';
const PREVIEW_PANE = 'rule-preview';
map.createPane(PREVIEW_PANE).style.zIndex = '430';   // over the route, under Identify
const previewRenderer = L.canvas({ pane: PREVIEW_PANE, padding: 0.2 });
const PREVIEW_VIEW_MAX_KM2 = 25;

const previews = new Map();   // rule -> { state: 'loading' | 'shown' | 'error', layers, info, seq }
let previewSeq = 0;

const previewInk = (rule) => cssVar(rule.op === 'remove' ? '--cut' : '--ident');

// The zones, or the view when there are none yet.
function previewArea() {
  if (state.regions.length) return Area.fromShape(shapePayload());
  const b = map.getBounds();
  const area = Area.fromShape({
    type: 'polygon',
    points: [[b.getSouth(), b.getWest()], [b.getSouth(), b.getEast()],
             [b.getNorth(), b.getEast()], [b.getNorth(), b.getWest()]],
  });
  if (area.areaKm2() > PREVIEW_VIEW_MAX_KM2) {
    throw new Error(`draw a zone first, or zoom in - the view is ${Math.round(area.areaKm2())} km², `
      + `and without a zone the preview only downloads up to ${PREVIEW_VIEW_MAX_KM2}`);
  }
  return area;
}

// The eye's state and the line under the text, on every card, from `previews`.
function syncPreviewButtons() {
  $('rules').querySelectorAll('.rule').forEach((card) => {
    const p = previews.get(card.ruleRef);
    const show = card.querySelector('.rule-show');
    show.classList.toggle('on', !!p && p.state === 'shown');
    show.classList.toggle('busy', !!p && p.state === 'loading');
    show.setAttribute('aria-pressed', String(!!p && p.state === 'shown'));
    show.setAttribute('aria-label', p && p.state === 'shown' ? 'Hide what this rule matches' : 'Show what this rule matches on the map');
    show.title = show.getAttribute('aria-label');
    const line = card.querySelector('.rule-preview');
    line.textContent = p ? p.info : '';
    line.classList.toggle('bad', !!p && p.state === 'error');
  });
}

function dropPreview(rule) {
  const p = previews.get(rule);
  if (!p) return;
  for (const layer of p.layers || []) map.removeLayer(layer);
  previews.delete(rule);
  syncPreviewButtons();
}

function dropAllPreviews() {
  for (const rule of [...previews.keys()]) dropPreview(rule);
}

function recolorPreview(rule) {
  const p = previews.get(rule);
  if (!p || !p.layers || p.layers.length < 3) return;
  for (const layer of p.layers.slice(1)) layer.setStyle({ color: previewInk(rule) });
}

async function togglePreview(rule) {
  if (previews.has(rule)) { dropPreview(rule); return; }
  const problem = ruleProblem(rule);
  const seq = ++previewSeq;
  const entry = { state: 'loading', layers: [], info: 'Downloading roads...', seq };
  previews.set(rule, entry);
  syncPreviewButtons();
  if (problem) {
    Object.assign(entry, { state: 'error', info: 'Fix the rule first.' });
    syncPreviewButtons();
    return;
  }
  let found;
  try {
    const area = previewArea();
    found = await previewRule(rule, area, {
      includePrivate: includePrivate(),
      cache: await sessionCache(),
      progress: (phase, message) => {
        if (previews.get(rule) !== entry) return;
        entry.info = message.includes('retrying') ? 'OpenStreetMap is busy - retrying...' : entry.info;
        syncPreviewButtons();
      },
    });
  } catch (err) {
    if (previews.get(rule) !== entry) return;     // hidden, edited or replaced meanwhile
    Object.assign(entry, { state: 'error', info: friendlyError(err.message) });
    syncPreviewButtons();
    return;
  }
  if (previews.get(rule) !== entry) return;
  // Inside the zones: haloed and solid, since those are the ones that count.
  // Beyond them, in the rest of the download: thin and faint. Index 1 is the
  // solid line recolorPreview() repaints, 2 its faint counterpart.
  const ink = previewInk(rule);
  const line = (lines, style) => L.polyline(lines, { renderer: previewRenderer, interactive: false, ...style });
  entry.layers = [
    line(found.inside, { color: cssVar('--map-bg'), weight: 7, opacity: 0.85 }),
    line(found.inside, { color: ink, weight: 3.5, opacity: 1 }),
    line(found.outside, { color: ink, weight: 2, opacity: 0.35 }),
  ];
  for (const layer of entry.layers) layer.addTo(map);
  entry.state = 'shown';
  const zone = state.regions.length ? 'the zones' : 'the view';
  const n = found.inside.length;
  entry.info = `${n} ${n === 1 ? 'way' : 'ways'} in ${zone}`
    + (found.outside.length ? `, ${found.outside.length} more around (faint)` : '')
    + (found.missing ? ` · ${found.missing} the query returned are not drivable roads` : '');
  syncPreviewButtons();
}

function rulesChanged() {
  // A different question gives a different set of streets; see the settings.
  dropBaseline();
  validateRules();
  syncRulesInfo();
  scheduleCheck();
  saveSession();
}

function addRule(kind) {
  // The first rule adds: a list starting from nothing is the usual question.
  state.rules.push({ op: 'add', kind, text: '' });
  renderRules();
  const cards = $('rules').querySelectorAll('.rule textarea');
  cards[cards.length - 1].focus();
  saveSession();
}

$('add-tag-rule').addEventListener('click', () => addRule('tags'));
$('add-query-rule').addEventListener('click', () => addRule('overpass'));
renderRules();

/* ------------------------------------------------------ banned restaurants */
/* Restaurants the breaks never stop at, as [{ref: 'node/123', name}]. The name
   is only for the list - an id typed in by hand has none until a route shows
   the place. Saved with the form, sent as refs. */

// An OSM ref from whatever was pasted: node/123, n123, "way 45", or a link to
// the object on openstreetmap.org. A bare number is taken as a node, which
// most restaurants are. null if it is none of those.
function parseOsmRef(text) {
  const s = String(text).trim();
  const kinds = { n: 'node', w: 'way', r: 'relation', node: 'node', way: 'way', relation: 'relation' };
  let m = /openstreetmap\.org\/(node|way|relation)\/(\d+)/i.exec(s)
    || /^(node|way|relation)\s*[/ ]\s*(\d+)$/i.exec(s)
    || /^([nwr])\s*(\d+)$/i.exec(s);
  if (m) return `${kinds[m[1].toLowerCase()]}/${m[2]}`;
  m = /^(\d+)$/.exec(s);
  return m ? `node/${m[1]}` : null;
}

function renderBanned() {
  const list = $('banned-list');
  list.replaceChildren(...state.bannedPlaces.map((b) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `https://www.openstreetmap.org/${b.ref}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = b.name || b.ref;
    a.title = b.ref;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'rule-del';
    del.textContent = '×';
    del.setAttribute('aria-label', `Allow ${b.name || b.ref} again`);
    del.addEventListener('click', () => {
      state.bannedPlaces = state.bannedPlaces.filter((x) => x.ref !== b.ref);
      bannedChanged();
    });
    li.append(a, del);
    return li;
  }));
}

// A changed list is a different question. With a route on the map it is
// answered straight away, as a coverage edit is, on the same piece of map.
function bannedChanged() {
  renderBanned();
  saveSession();
  if (state.result && sessionBreak()) recompute({ keepView: true });
}

function banPlace(ref, name = '') {
  const held = state.bannedPlaces.find((b) => b.ref === ref);
  if (held) {
    if (name && !held.name) { held.name = name; renderBanned(); saveSession(); }
    return;
  }
  state.bannedPlaces.push({ ref, name });
  bannedChanged();
}

$('banned-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = $('banned-input');
  if (!input.value.trim()) return;
  const ref = parseOsmRef(input.value);
  input.classList.toggle('invalid', !ref);
  $('banned-error').textContent = ref ? '' : 'Not an OSM id - try node/123, n123 or a link to the restaurant on openstreetmap.org.';
  if (!ref) return;
  input.value = '';
  banPlace(ref);
});
$('banned-input').addEventListener('input', () => {
  $('banned-input').classList.remove('invalid');
  $('banned-error').textContent = '';
});

/* --------------------------------------------------------------- request */
function payload() {
  const body = {
    shape: shapePayload(),
    include_private: includePrivate(),
    // Not a form field: the value that measured best is the value, and the one
    // thing a driver would reach for it for - a stub worth driving anyway - is
    // better answered by the editor, street by street. See DEAD_END_MIN_M.
    dead_end_m: config.DEAD_END_MIN_M,
    overrides: state.fixes,
    selection: state.rules,
    both_directions: bothDirections(),
    passes: passesValue() || 1,
    session_minutes: (sessionHours() || NO_SPLIT_HOURS) * 60,
    session_break: sessionBreak(),
    return_home: $('return-home').checked,
    banned_places: state.bannedPlaces.map((b) => b.ref),
    sessions_per_day: sessionsPerDay() || config.SESSIONS_PER_DAY_DEFAULT,
  };
  if (state.startLatLng) {
    body.start = { lat: state.startLatLng.lat, lon: state.startLatLng.lng };
  }
  return body;
}

function scheduleCheck() {
  clearTimeout(state.checkTimer);
  state.checkTimer = setTimeout(runCheck, 200);
}

/* Settings and zones together, with the merged shape's exact geodesic area.
   Nothing is said out loud here - this runs on every keystroke, and a message
   per keystroke is noise. The offending field goes red; Compute says why. */
function runCheck() {
  if (!state.regions.length) return;
  validate();
  let area = null;
  try {
    area = Area.fromShape(shapePayload());
  } catch (err) { /* named on Compute */ }
  $('area-info').textContent = area
    ? areaText(area.areaKm2(), state.regions.length)
    : '--';
  // Not while a job is running, or changing a setting mid-compute would arm the
  // button for a second one.
  $('compute').disabled = state.ticker !== null;
}

['passes', 'session', 'dir-oneway', 'dir-both', 'session-enabled',
 'private-roads', 'session-restaurant', 'sessions-per-day', 'return-home'].forEach((id) => {
  $(id).addEventListener('change', () => {
    if (id === 'session-enabled' || id === 'session-restaurant') syncSessionField();
    // Service roads in or out is a different download to match against.
    if (id === 'private-roads') dropAllPreviews();
    // A different question gives a different set of streets, so what the editor
    // has been drawing from is no longer what "everything" looks like.
    dropBaseline();
    scheduleCheck();
    saveSession();
  });
  $(id).addEventListener('input', scheduleCheck);
});

/* --------------------------------------------------------------- compute */
// In a worker, so the page stays responsive. The version in the URL is load
// bearing: browsers cache a module worker's script graph hard, and Firefox will
// keep running the old pipeline through an ordinary reload without it.
const worker = new Worker(
  new URL(`./worker.js?v=${config.ALGO_VERSION}`, import.meta.url),
  { type: 'module' },
);

worker.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.id !== state.jobId) return;   // a job the user has since superseded
  if (msg.type === 'progress') {
    state.progress = msg;
    renderProgress();
  } else if (msg.type === 'done') {
    finishJob();
    state.result = msg.result;
    captureBaseline(msg.result);
    renderResult(msg.result);
    // Refitting is for a route you have just asked for. One the editor asked
    // for has to land on the same piece of map the change was made on.
    drawSessions(msg.result, msg.result.track || [], { fit: !state.keepView });
    state.keepView = false;
    resumeEditor();
    if (msg.result.start) setStart(L.latLng(msg.result.start.lat, msg.result.start.lon));
    saveSession();
  } else if (msg.type === 'error') {
    finishJob();
    state.keepView = false;
    state.resumeSelect = false;
    showMapAlert(friendlyError(msg.message));
  }
};

worker.onerror = (ev) => {
  finishJob();
  showMapAlert('The compute worker failed to start. Serve this folder over http(s): '
    + 'browsers refuse to run workers from a file:// page.');
  console.error(ev);
};

$('compute').onclick = () => {
  if (!state.regions.length) return;
  const problem = validate() || areaProblem();
  if (problem) { showMapAlert(problem); return; }

  hideMapAlert();
  // clearRoute() puts the tool away with the route it belongs to; this is what
  // brings it back, so a fix made in the editor is answered in the editor.
  state.resumeSelect = state.mode === 'select';
  clearRoute();
  $('compute').disabled = true;
  state.jobId += 1;
  state.started = performance.now();
  state.progress = { phase: 'queued', message: 'Starting...', fraction: 0 };
  renderProgress();
  clearInterval(state.ticker);
  state.ticker = setInterval(renderProgress, 500);
  worker.postMessage({ id: state.jobId, payload: payload() });
};

function finishJob() {
  clearInterval(state.ticker);
  state.ticker = null;
  hideProgress();
  $('compute').disabled = state.regions.length === 0;
}

function friendlyError(message) {
  // Errors may arrive as "ErrorType: text"; the text is the useful part.
  const m = String(message || '');
  const colon = m.indexOf(': ');
  return colon > 0 && colon < 40 ? m.slice(colon + 2) : m;
}

function renderProgress() {
  const p = state.progress;
  if (!p) return;
  const box = $('progress');
  box.classList.remove('hidden');
  const fill = box.querySelector('.fill');
  // No natural granularity for these two, so a moving bar rather than a lie.
  const indeterminate = p.phase === 'balance' || p.phase === 'fetch';
  fill.classList.toggle('indeterminate', indeterminate);
  fill.style.width = indeterminate ? '' : `${Math.round((p.fraction || 0) * 100)}%`;
  const elapsed = (performance.now() - state.started) / 1000;
  const secs = elapsed >= 1 ? ` · ${elapsed.toFixed(0)}s` : '';
  box.querySelector('.progress-text').textContent = `${p.message || p.phase}${secs}`;
}

function hideProgress() { $('progress').classList.add('hidden'); }

/* ------------------------------------------------------ save and reload */
/* What goes in the zip's metadata.json. Three blocks, one per restore step:
   drawn geometry, form, computed route. Kept apart from the worker's request
   payload, which is shaped for the solver - reversing those conversions on the
   way back in is a second chance to get them wrong.

   Two versions travel in the file and they answer different questions.
   `version` is the release that wrote it - a label, so a puzzling old file can
   be placed. `format` is what the file is *read* by, and it is checked on load:
   a file written to a different one is refused with a sentence rather than
   half-loaded into a page that looks right and is not.

   Bump `format` whenever the shape of what is written changes enough that this
   version would misread it. 2 did so: roads carry runs of the breadcrumb now
   (`spans`) where format 1 carried tour arc positions, so a format 1 file would
   draw its route and then show an editor with nothing in it. */
const METADATA_FORMAT = 2;

// The drawn geometry and the form, which is what both a download and the saved
// session need before they get to the route itself.
function viewState() {
  return {
    regions: state.regions,
    start: state.startLatLng
      ? { lat: state.startLatLng.lat, lon: state.startLatLng.lng }
      : null,
  };
}

function formState() {
  return {
    bothDirections: bothDirections(),
    includePrivate: includePrivate(),
    deadEndM: config.DEAD_END_MIN_M,
    fixes: state.fixes,
    selection: state.rules,
    passes: passesValue() || 1,
    splitSessions: sessionEnabled(),
    breakAtRestaurant: $('session-restaurant').checked,
    returnHome: $('return-home').checked,
    bannedPlaces: state.bannedPlaces,
    sessionsPerDay: sessionsPerDay() || config.SESSIONS_PER_DAY_DEFAULT,
    sessionHours: sessionHours() || NO_SPLIT_HOURS,
  };
}

/* The unedited drive, where it is not simply this one. It has to travel with the
   route, in the download as much as in the saved session: a street set to "not
   driveable" - or one the route stopped covering when it was set to "access
   only" - is not in the result any more, and this is the only thing left that
   knows where it ran. Without it a reloaded file came back with those streets
   missing off the editor's map and no way to change their minds.

   Usually it *is* this result, and then it travels as a flag rather than as a
   second copy of the same city. */
function baselineRecord() {
  if (!state.baseline) return null;
  if (state.result && state.baseline.track === state.result.track) return 'result';
  return state.baseline;
}

function routeMetadata(res) {
  return {
    format: METADATA_FORMAT,
    generator: 'Routile',
    version: config.VERSION,
    saved: new Date().toISOString(),
    // Not enforced on load - an old route still draws as it drew then.
    // Recorded so a puzzling old file can be placed.
    algoVersion: config.ALGO_VERSION,
    view: viewState(),
    form: formState(),
    result: res,
    baseline: baselineRecord(),
  };
}

// Enough that a wrong or damaged file is refused with a sentence rather than
// half-applied. Not a schema: this reads files this page wrote, so it catches
// honest mistakes, not hostile ones.
function checkMetadata(meta) {
  if (!meta || typeof meta !== 'object') throw new Error('metadata.json is not readable.');
  if (meta.format !== METADATA_FORMAT) {
    const wrote = meta.version ? ` by Routile ${meta.version}` : '';
    throw new Error(`This file is in metadata format ${meta.format ?? '?'}`
      + `${wrote}, and Routile ${config.VERSION} reads format ${METADATA_FORMAT}. `
      + 'Draw the area again and recompute to get a file this version can read.');
  }
  const res = meta.result;
  if (!res || !Array.isArray(res.sessions) || !Array.isArray(res.track)) {
    throw new Error('metadata.json has no route in it.');
  }
  if (!res.sessions.length || res.track.length < 2) {
    throw new Error('The route in this file is empty.');
  }
  if (!Array.isArray(meta.view?.regions)) throw new Error('The drawn area is missing.');
  return meta;
}

/* Put the page back as it was when the zip was made. Deliberately no compute:
   the result travelled with the file, so this is instant, works offline, and
   gives exactly the route that was downloaded rather than what the same
   request would produce from today's map data. */
function restoreRoute(meta, { fit = true } = {}) {
  const view = meta.view || {};
  const form = meta.form || {};
  const result = meta.result || null;

  // Someone else's area and someone else's corrections: nothing the editor was
  // holding still applies.
  dropBaseline();
  closeRoadCard();
  clearRoute();
  state.regions = Array.isArray(view.regions) ? view.regions : [];
  state.fixes = (form.fixes && typeof form.fixes === 'object') ? { ...form.fixes } : {};
  dropAllPreviews();
  state.rules = cleanRules(form.selection);
  renderRules();
  drawRegions();

  if (view.start) setStart(L.latLng(view.start.lat, view.start.lon));
  else clearStart();

  $(form.bothDirections ? 'dir-both' : 'dir-oneway').checked = true;
  $('private-roads').checked = !!form.includePrivate;
  // Clamped: a hand-edited file must not put the form into a state its own
  // validation would reject.
  $('passes').value = String(
    Math.min(Math.max(Math.round(form.passes) || 1, 1), config.PASSES_MAX));
  // form.deadEndM is read past: it is a constant now, so there is no field to
  // put it in. The loaded route still drew with whatever it was computed at;
  // a recompute from here uses today's value.
  $('session-enabled').checked = !!form.splitSessions;
  $('session-restaurant').checked = !!form.breakAtRestaurant;
  $('return-home').checked = !!form.returnHome;
  state.bannedPlaces = Array.isArray(form.bannedPlaces)
    ? form.bannedPlaces.filter((b) => b && parseOsmRef(b.ref) === b.ref)
      .map((b) => ({ ref: b.ref, name: String(b.name || '') }))
    : [];
  renderBanned();
  $('sessions-per-day').value = String(Math.min(Math.max(Math.round(form.sessionsPerDay) || config.SESSIONS_PER_DAY_DEFAULT, 2),
    config.SESSIONS_PER_DAY_MAX));
  const hours = Number(form.sessionHours);
  if (Number.isFinite(hours) && hours >= 0.1 && hours <= NO_SPLIT_HOURS) {
    $('session').value = String(hours);
  }
  syncSessionField();

  syncZones();                 // area figure, and the Compute button
  hideMapAlert();
  // Zones and settings but no route: a session saved before Compute was ever
  // pressed, or after the area was redrawn.
  if (!result) return;

  state.result = result;
  // What the editor draws the streets this drive no longer has from. 'result'
  // is the flag baselineRecord() writes when the two were the same thing.
  state.baseline = meta.baseline === 'result' ? result : (meta.baseline || null);
  captureBaseline(result);
  renderResult(result);
  drawSessions(result, result.track || [], { fit });
  resumeEditor();
}

// The zip this page downloads, read back in.
async function loadRouteZip(file) {
  if (!/\.zip$/i.test(file.name)) {
    throw new Error(/\.gpx$/i.test(file.name)
      ? 'A .gpx file holds the track but none of the settings behind it. '
        + 'Drop the whole .zip instead.'
      : 'That is not a Routile .zip.');
  }
  let zip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch (err) {
    throw new Error('That file could not be opened as a zip.');
  }
  const entry = zip.file('metadata.json');
  if (!entry) throw new Error('No metadata.json in this zip.');
  let meta;
  try {
    meta = JSON.parse(await entry.async('string'));
  } catch (err) {
    throw new Error('The metadata.json in this zip is damaged.');
  }
  restoreRoute(checkMetadata(meta));
  saveSession();
}

/* ---------------------------------------------------- the saved session */
/* A reload is not a reset. The drawn area, the settings, the corrections and
   the computed route are written to IndexedDB as they change and read back at
   startup, so the page comes up on exactly what it was closed on; Clear is what
   throws it away, which is what Clear is for.

   IndexedDB rather than localStorage: a city's route is megabytes of
   breadcrumb, which localStorage has no room for and could only be written by
   serialising the whole thing to a string on the main thread. Everything here
   degrades to nothing where IndexedDB is unavailable - the page then starts
   empty, exactly as it used to. */
const SESSION_STORE = 'session';

let cacheOnce = null;
const sessionCache = () => (cacheOnce || (cacheOnce = openCache()));

// Nothing is written until the restore has run, or the empty page the script
// starts on would be saved over the session it is about to read.
let sessionReady = false;
let saveTimer = null;

function saveSession() {
  if (!sessionReady) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeSession, 400);
}

async function writeSession() {
  const db = await sessionCache();
  await db.put(SESSION_STORE, 'route', {
    format: METADATA_FORMAT,
    view: viewState(),
    form: formState(),
    result: state.result,
    baseline: baselineRecord(),
  });
}

// Kept apart from the route, so panning rewrites a three-number record rather
// than the whole drive.
function saveView() {
  if (!sessionReady) return;
  const centre = map.getCenter();
  sessionCache().then((db) => db.put(SESSION_STORE, 'view',
    { lat: centre.lat, lon: centre.lng, zoom: map.getZoom() }));
}

async function restoreSession() {
  let saved = null;
  let view = null;
  try {
    const db = await sessionCache();
    [saved, view] = await Promise.all([
      db.get(SESSION_STORE, 'route'),
      db.get(SESSION_STORE, 'view'),
    ]);
  } catch (err) {
    console.warn('no saved session:', err.message);
  }

  if (view && Number.isFinite(view.lat) && Number.isFinite(view.lon)) {
    map.setView([view.lat, view.lon], view.zoom || map.getZoom(), { animate: false });
  }
  if (saved && saved.format === METADATA_FORMAT) {
    try {
      // Not fitted to the route: where the map was left is a better answer than
      // the route's own bounds, and it is right there in the same record.
      restoreRoute(saved, { fit: false });
    } catch (err) {
      // A half-written or hand-edited record must not cost the page its start,
      // and must not survive to cost it the next one either - hence the flag
      // before the clear, so the empty page is what gets written back.
      console.warn('could not restore the last session:', err);
      sessionReady = true;
      clearZones();
    }
  }
  sessionReady = true;
  map.on('moveend', saveView);
}

restoreSession();

const dropzone = $('dropzone');

async function acceptFiles(files) {
  const list = [...(files || [])];
  if (!list.length) return;
  // One route per zip, so a multiple selection takes the first zip in it.
  const file = list.find((f) => /\.zip$/i.test(f.name)) || list[0];
  dropzone.classList.add('busy');
  try {
    await loadRouteZip(file);
  } catch (err) {
    showMapAlert(err.message);
  } finally {
    dropzone.classList.remove('busy');
  }
}

// Refusing a file is worth interrupting for: you dropped something and nothing
// happened, and a line at the foot of the panel is easy to miss.
//
// The same box asks before anything destructive: pass `accept` and it grows a
// Cancel button, renames the other one, and runs the callback only if that one
// is pressed. Cancel takes the focus, so a stray Enter backs out rather than
// going through with it.
function showMapAlert(msg, { accept = null } = {}) {
  $('map-alert-text').textContent = msg;
  state.confirm = accept;
  $('map-alert-close').textContent = accept ? 'Accept' : 'Dismiss';
  $('map-alert-cancel').classList.toggle('hidden', !accept);
  // A question, not a failure: the border loses its red and the button that
  // goes through with it takes the accent.
  $('map-alert').classList.toggle('asking', !!accept);
  $('map-scrim').classList.remove('hidden');
  $('map-alert').classList.remove('hidden');
  $(accept ? 'map-alert-cancel' : 'map-alert-close').focus();
}

// Dismissing, cancelling, clicking the dark and Escape are the same answer: no.
function hideMapAlert() {
  state.confirm = null;
  $('map-alert').classList.add('hidden');
  $('map-scrim').classList.add('hidden');
}

$('map-alert-close').addEventListener('click', () => {
  const accept = state.confirm;
  hideMapAlert();
  if (accept) accept();
});
$('map-alert-cancel').addEventListener('click', hideMapAlert);
$('map-scrim').addEventListener('click', hideMapAlert);
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  hideMapAlert();
  hideTip();
  closeIdentify();
  // The street card has no close button of its own, so this and a click off the
  // street are the two ways to put it away.
  closeRoadCard();
});

/* --------------------------------------------------------------- info tips */
/* One bubble, moved to whichever marker is asking. Fixed and clamped to the
   window, because the panel is 388px wide and a bubble anchored inside it would
   otherwise run off the edge. Delegated, because the summary tiles - and the
   marker in one of them - are rebuilt on every result. */
const tipBubble = $('tip');
let tipFor = null;

function showTip(marker) {
  if (tipFor === marker) return;      // moving within the marker, not onto it
  hideTip();
  tipFor = marker;
  // The bubble is the label's description only while it is the one showing.
  marker.setAttribute('aria-describedby', 'tip');
  tipBubble.textContent = marker.dataset.tip || '';
  tipBubble.classList.remove('hidden');
  const at = marker.getBoundingClientRect();
  const box = tipBubble.getBoundingClientRect();
  const gap = 8, edge = 10;
  const left = Math.min(Math.max(at.left + at.width / 2 - box.width / 2, edge),
                        window.innerWidth - box.width - edge);
  // Below unless that would go off the bottom, in which case above.
  const below = at.bottom + gap;
  const top = below + box.height + edge > window.innerHeight
    ? Math.max(at.top - box.height - gap, edge)
    : below;
  tipBubble.style.left = `${Math.round(left)}px`;
  tipBubble.style.top = `${Math.round(top)}px`;
}

function hideTip() {
  if (tipFor) tipFor.removeAttribute('aria-describedby');
  tipFor = null;
  tipBubble.classList.add('hidden');
}

const markerAt = (target) =>
  (target instanceof Element ? target.closest('.info') : null);

// Left the marker, rather than crossed from its padding onto its own glyph.
const leaving = (ev) => {
  const marker = markerAt(ev.target);
  return marker && !marker.contains(ev.relatedTarget);
};

document.addEventListener('mouseover', (ev) => {
  const marker = markerAt(ev.target);
  if (marker) showTip(marker);
});
document.addEventListener('mouseout', (ev) => {
  if (leaving(ev)) hideTip();
});
// Keyboard, and a tap on a touch screen: the marker takes focus either way.
document.addEventListener('focusin', (ev) => {
  const marker = markerAt(ev.target);
  if (marker) showTip(marker);
});
document.addEventListener('focusout', (ev) => {
  if (leaving(ev)) hideTip();
});
/* A touch screen has no hover, so the tap itself shows the note and the next
   tap anywhere dismisses it. Defaulted away because the marker sits inside its
   <label>, which would otherwise take the tap into the field. */
document.addEventListener('click', (ev) => {
  const marker = markerAt(ev.target);
  if (!marker) { hideTip(); return; }
  ev.preventDefault();
  showTip(marker);
});
// The bubble is fixed, so anything that moves the page leaves it behind.
window.addEventListener('scroll', hideTip, true);
window.addEventListener('resize', hideTip);

dropzone.addEventListener('click', () => $('load-file').click());
dropzone.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault();
    $('load-file').click();
  }
});
$('load-file').addEventListener('change', (ev) => {
  acceptFiles(ev.target.files);
  ev.target.value = '';        // so the same file can be picked twice running
});

for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    dropzone.classList.add('over');
  });
}
for (const type of ['dragleave', 'dragend']) {
  dropzone.addEventListener(type, () => dropzone.classList.remove('over'));
}
dropzone.addEventListener('drop', (ev) => {
  ev.preventDefault();
  dropzone.classList.remove('over');
  acceptFiles(ev.dataTransfer.files);
});

// A file dropped elsewhere would be opened by the browser, navigating away from
// a page that may have a route in it.
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, (ev) => {
    if (!dropzone.contains(ev.target)) ev.preventDefault();
  });
}

/* --------------------------------------------------------------- identify */
/* Click a road, read what OSM says about it - the raw material of a tag filter,
   which is otherwise guessed at from the wiki. Asked of Overpass on each click
   rather than of the road download: this works before anything is computed,
   and it shows footways and tracks too, the things a filter is often written
   to leave out.

   The card lists every tag with a box beside it; ticking boxes writes the
   filter below them, which can be copied or added straight to Required roads.
   The ticks carry over from one road to the next, so the same filter can be
   tried street after street. */
const IDENTIFY_PX = 12;            // how far from the click a road may lie
const IDENTIFY_RADIUS_M = [3, 80]; // clamped: zoomed far out, 12 px is a suburb

const wayLabel = (w) => w.tags?.name || w.tags?.ref || w.tags?.highway || `way ${w.id}`;

// Metres from a point to a way's geometry, flat-earth: at these distances the
// curvature is far below a pixel.
function distanceToWay(at, geometry) {
  const kx = 111320 * Math.cos(at.lat * Math.PI / 180), ky = 110540;
  const pts = geometry.map((g) => [(g.lon - at.lng) * kx, (g.lat - at.lat) * ky]);
  let best = pts.length ? Math.hypot(pts[0][0], pts[0][1]) : Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(Math.max(-(ax * dx + ay * dy) / len2, 0), 1) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

// One clause of an Overpass tag filter, quoted so any key or value survives.
const quoteTag = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const filterClause = (key, value) => `[${quoteTag(key)}=${quoteTag(value)}]`;

// The area the card has picked, or null.
const identArea = () => ident.areas.find((a) => a.id === ident.areaId) || null;

// What kind of area it is, in the tags that make it one.
function areaLevel(a) {
  const t = a.tags;
  if (t.boundary === 'cadastral') return 'cadastral';
  if (t.boundary === 'administrative' && t.admin_level) return `admin_level ${t.admin_level}`;
  if (t.landuse) return `landuse=${t.landuse}`;
  if (t.place) return `place=${t.place}`;
  return t.boundary || '';
}

/* What the card's ticks and pick add up to, as a Required roads rule. Ticks
   alone are a tag filter; an area makes it a query limited to that area, since
   lying in a borough is not a tag a road carries. The area goes in by id, not by
   name: it is the exact one clicked, and there is no Nominatim lookup to go
   wrong. No ticks with an area picked means every road in it. */
function identifyRule() {
  const way = ident.ways[ident.index];
  const clauses = way ? Object.keys(way.tags || {}).sort()
    .filter((k) => ident.checked.has(k))
    .map((k) => filterClause(k, way.tags[k])).join('') : '';
  const area = identArea();
  if (area) {
    return {
      kind: 'overpass',
      text: `// ${area.tags.name.replace(/[\r\n]/g, ' ')} (${areaLevel(area)})\n`
        + `area(id:${area.id})->.a;\nway(area.a)${clauses || '["highway"]'};`,
    };
  }
  return clauses ? { kind: 'tags', text: clauses } : null;
}

function identifyCard(body) {
  if (!ident.popup) {
    ident.popup = L.popup({
      className: 'road-popup ident-popup', closeButton: true, autoClose: false,
      closeOnClick: false, maxWidth: 340, minWidth: 260,
    });
    ident.popup.on('remove', () => { clearIdentifyHighlight(); clearAreaOutline(); ident.areaSeq++; });
  }
  /* Leaflet pans the map so the card fits, but it only knows the map's edges,
     and the tool bar floats over the top of it. Measured each time, since the
     bar moves as the window narrows. */
  const mapTop = mapEl.getBoundingClientRect().top;
  const barBottom = $('topbar').getBoundingClientRect().bottom - mapTop;
  ident.popup.options.autoPanPaddingTopLeft = L.point(16, Math.max(barBottom, 0) + 12);
  ident.popup.options.autoPanPaddingBottomRight = L.point(16, 16);
  ident.popup.setLatLng(ident.at).setContent(`<div class="road-card ident-card">${body}</div>`);
  if (!map.hasLayer(ident.popup)) ident.popup.openOn(map);
  wireIdentifyCard(ident.popup.getElement());
}

function clearIdentifyHighlight() {
  if (ident.highlight) { map.removeLayer(ident.highlight); ident.highlight = null; }
}

/* The whole way, end to end, as OSM has it - not just where it was clicked,
   since one way is often a short stretch of a longer street and where it stops
   is what a filter on it will select. Drawn over everything: a halo in the
   map's own ground colour, the line in the selection cyan, and a dot at each
   end so its extent reads even where it runs on under the route. */
// Its own pane, above the route and the editor's streets (overlays sit at 400)
// and below the markers and the card.
const IDENT_PANE = 'identify';
map.createPane(IDENT_PANE).style.zIndex = '450';

function drawIdentifyHighlight(way) {
  clearIdentifyHighlight();
  const line = way.geometry.map((g) => [g.lat, g.lon]);
  const halo = cssVar('--map-bg'), ink = cssVar('--ident');
  const style = { pane: IDENT_PANE, interactive: false };
  const ends = [line[0], line[line.length - 1]].map((p) => L.circleMarker(p, {
    ...style, radius: 5, color: halo, weight: 2, fillColor: ink, fillOpacity: 1,
  }));
  ident.highlight = L.layerGroup([
    L.polyline(line, { ...style, color: halo, weight: 11, opacity: 0.9 }),
    L.polyline(line, { ...style, color: ink, weight: 6, opacity: 1 }),
    ...ends,
  ]).addTo(map);
}

function closeIdentify() {
  ident.seq++;
  ident.areaSeq++;
  clearIdentifyHighlight();
  clearAreaOutline();
  if (ident.popup && map.hasLayer(ident.popup)) map.closePopup(ident.popup);
}

function renderIdentify() {
  const way = ident.ways[ident.index] || null;
  if (way) drawIdentifyHighlight(way); else clearIdentifyHighlight();

  const tags = way ? way.tags || {} : {};
  const rows = Object.keys(tags).sort().map((k) =>
    '<label class="ident-tag">'
    + `<input type="checkbox" data-key="${escapeHtml(k)}"${ident.checked.has(k) ? ' checked' : ''}>`
    + `<span class="ident-k">${escapeHtml(k)}</span>`
    + `<span class="ident-v">${escapeHtml(String(tags[k]))}</span></label>`).join('');
  const others = ident.ways.length > 1
    ? '<div class="ident-others"><span>Also here:</span>'
      + ident.ways.map((w, i) => (i === ident.index ? ''
        : `<button type="button" class="ident-other" data-i="${i}">${escapeHtml(wayLabel(w))}</button>`)).join('')
      + '</div>'
    : '';
  // Most local first. The first row takes the area back out of the rule.
  const areaRow = (id, name, level, href) => '<label class="ident-area">'
    + `<input type="radio" name="ident-area" value="${id}"${(ident.areaId ?? '') === id ? ' checked' : ''}>`
    + `<span class="ident-area-name">${escapeHtml(name)}</span>`
    + `<span class="ident-area-level">${escapeHtml(level)}</span>`
    + (href ? `<a class="ident-area-link" href="${href}" target="_blank" rel="noopener noreferrer" title="Open in OpenStreetMap">↗</a>` : '')
    + '</label>';
  const areas = ident.areas.length
    ? '<div class="ident-section">Inside</div><div class="ident-areas">'
      + areaRow('', 'Anywhere', 'no area', null)
      + ident.areas.map((a) => areaRow(a.id, a.tags.name, areaLevel(a), osmAreaUrl(a))).join('')
      + '</div>'
    : '';

  const rule = identifyRule();
  const off = rule ? '' : ' disabled';
  const what = rule && rule.kind === 'overpass' ? 'query' : 'filter';
  identifyCard(
    (way
      ? `<div class="road-card-name">${escapeHtml(wayLabel(way))}</div>`
        + `<div class="road-card-meta">way ${way.id} · ${Object.keys(tags).length} tags</div>`
        + `<div class="ident-tags">${rows}</div>`
      : '<div class="road-card-name">No road here</div>'
        + '<div class="road-card-meta">Click closer to one for its tags.</div>')
    + areas
    + `<div class="ident-filter-label">${way ? 'Tick tags to build a filter' : 'Pick an area to build a query'}`
    + `${ident.areas.length && way ? ', pick an area to limit it to one' : ''}</div>`
    + `<code class="ident-filter">${rule ? escapeHtml(rule.text) : '&nbsp;'}</code>`
    + '<div class="rule-adders ident-actions">'
    + `<button type="button" class="ghost" data-act="copy"${off}>Copy ${what}</button>`
    + `<button type="button" class="ghost" data-act="rule"${off}>Add as rule</button>`
    + (identArea() ? '<button type="button" class="ghost" data-act="zone">Add as zone</button>' : '')
    + '</div>'
    + others
    + (way ? '<a class="road-card-link" target="_blank" rel="noopener noreferrer"'
      + ` href="https://www.openstreetmap.org/way/${way.id}">Open in OpenStreetMap</a>` : ''));
}

// The OSM object an area was made from.
const osmAreaUrl = (a) => `https://www.openstreetmap.org/${a.osmType}/${a.osmId}`;

/* The outline of an area the card lists, as polygon-clipping's multipolygon:
   for drawing it while it is picked, and for Add as zone. By OSM id rather
   than by name, so it is the very area clicked. Nominatim, as the boundary
   field uses, which assembles a relation's rings; kept per area, since picking
   back and forth between two should not ask twice. */
const areaOutlines = new Map();

async function lookupAreaOutline(area) {
  if (areaOutlines.has(area.id)) return areaOutlines.get(area.id);
  const ref = `${area.osmType === 'relation' ? 'R' : 'W'}${area.osmId}`;
  const url = `https://nominatim.openstreetmap.org/lookup?format=jsonv2&polygon_geojson=1`
    + `&polygon_threshold=${BOUNDARY_THRESHOLD_DEG}&osm_ids=${ref}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`the geocoder answered ${res.status}`);
  const hit = (await res.json())[0];
  const g = hit && hit.geojson;
  if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) throw new Error('Nominatim has no outline for it');
  const poly = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  areaOutlines.set(area.id, poly);
  return poly;
}

function clearAreaOutline() {
  if (ident.areaLayer) { map.removeLayer(ident.areaLayer); ident.areaLayer = null; }
}

/* The picked area drawn on the map, so what the query will be limited to can
   be checked before it is used: dashed in the selection cyan, faintly filled,
   under the road highlight. Not fitted to - the card is anchored where the
   click was, and a city's outline would pan it out of sight. */
async function showAreaOutline(area) {
  const seq = ++ident.areaSeq;
  clearAreaOutline();
  if (!area) return;
  let poly;
  try {
    poly = await lookupAreaOutline(area);
  } catch (err) {
    console.warn(`no outline for ${area.tags.name}:`, err.message);
    return;
  }
  if (seq !== ident.areaSeq || ident.areaId !== area.id) return;   // picked another meanwhile
  ident.areaLayer = L.polygon(poly.map((rings) => rings.map((ring) => ring.map(([x, y]) => [y, x]))), {
    pane: IDENT_PANE, interactive: false,
    color: cssVar('--ident'), weight: 2.5, dashArray: '7,5', fillColor: cssVar('--ident'), fillOpacity: 0.08,
  }).addTo(map);
  ident.areaLayer.bringToBack();
}

async function identifyAt(latlng) {
  const seq = ++ident.seq;
  ident.at = latlng;
  clearIdentifyHighlight();
  identifyCard('<div class="road-card-meta">Looking up roads here...</div>');
  const px = map.latLngToContainerPoint(latlng);
  const edge = map.containerPointToLatLng(px.add([IDENTIFY_PX, 0]));
  const radius = Math.min(Math.max(latlng.distanceTo(edge), IDENTIFY_RADIUS_M[0]), IDENTIFY_RADIUS_M[1]);
  let found;
  try {
    found = await fetchIdentify(latlng.lat, latlng.lng, radius);
  } catch (err) {
    if (seq === ident.seq) identifyCard(`<div class="road-card-meta">${escapeHtml(err.message)}</div>`);
    return;
  }
  if (seq !== ident.seq) return;         // another click, or the tool was put away
  ident.ways = found.ways
    .map((w) => ({ w, d: distanceToWay(latlng, w.geometry) }))
    .sort((a, b) => a.d - b.d).map((x) => x.w);
  ident.index = 0;
  ident.areas = found.areas;
  // Like the ticks, the pick survives the next click - while it still applies.
  if (!ident.areas.some((a) => a.id === ident.areaId)) ident.areaId = null;
  if (ident.areaId === null) clearAreaOutline();
  else if (!ident.areaLayer) showAreaOutline(identArea());
  if (!ident.ways.length && !ident.areas.length) {
    identifyCard('<div class="road-card-meta">Nothing in OpenStreetMap here - click closer to a road.</div>');
    return;
  }
  renderIdentify();
}

map.on('click', (ev) => {
  if (state.mode === 'identify') identifyAt(ev.latlng);
});

/* On the popup's own element, which Leaflet keeps across setContent(), and
   delegated, since the markup inside is rebuilt on every change. Not on the
   map: Leaflet stops clicks inside a popup from reaching it. */
function wireIdentifyCard(el) {
  if (!el || el.dataset.wired) return;
  el.dataset.wired = '1';
  el.addEventListener('change', onIdentifyChange);
  el.addEventListener('click', onIdentifyClick);
}

function onIdentifyChange(ev) {
  const pick = ev.target.closest('.ident-card input[name="ident-area"]');
  if (pick) {
    ident.areaId = pick.value ? Number(pick.value) : null;
    renderIdentify();
    showAreaOutline(identArea());
    return;
  }
  const box = ev.target.closest('.ident-card input[type=checkbox]');
  if (!box) return;
  if (box.checked) ident.checked.add(box.dataset.key); else ident.checked.delete(box.dataset.key);
  renderIdentify();
}

async function onIdentifyClick(ev) {
  const other = ev.target.closest('.ident-card .ident-other');
  if (other) {
    ident.index = Number(other.dataset.i);
    renderIdentify();
    return;
  }
  const act = ev.target.closest('.ident-card [data-act]');
  if (!act) return;
  const label = act.textContent;
  const done = (text) => {
    act.textContent = text;
    setTimeout(() => { if (act.isConnected) act.textContent = label; }, 1400);
  };

  if (act.dataset.act === 'zone') {
    const area = identArea();
    if (!area || act.disabled) return;
    act.disabled = true;
    act.textContent = 'Adding...';
    try {
      applyGeometry(await lookupAreaOutline(area), 'add');
      done('Added');
    } catch (err) {
      showMapAlert(`Could not add ${area.tags.name} as a zone: ${err.message}.`);
      act.textContent = label;
    } finally {
      act.disabled = false;
    }
    return;
  }

  const rule = identifyRule();
  if (!rule) return;
  if (act.dataset.act === 'copy') {
    try {
      await navigator.clipboard.writeText(rule.text);
      done('Copied');
    } catch (err) {
      done('Copy failed');
    }
  } else {
    state.rules.push({ op: 'add', ...rule });
    renderRules();
    rulesChanged();
    done('Added');
    $('rules-block').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

/* ---------------------------------------------------------------- render */
const DRIVING_TIP = 'Estimated from speed limits; the real drive takes longer.';
const MODIFIERS_TIP = 'Streets whose coverage you changed with Edit coverage, '
  + 'where OpenStreetMap has them wrong. Saved with the route in metadata.json.';

// The same marker index.html writes by hand, for the tiles built here.
const infoMarker = (tip) =>
  '<button type="button" class="info" aria-label="What this estimate means"'
  + ` data-tip="${escapeHtml(tip)}"><svg viewBox="0 0 24 24" aria-hidden="true">`
  + '<path fill-rule="evenodd" d="M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 1 0 0-19z'
  + 'M12 6.9a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 1 0 0-2.6z'
  + 'M10.85 12.35a1.15 1.15 0 0 1 2.3 0v3.5a1.15 1.15 0 0 1-2.3 0z"/></svg></button>';

/* ------------------------------------------------------------ road fixer */
/* Edit coverage turns the drive into a map of streets, each painted with what
   it is allowed to be, and a click on one opens its card there with the control
   to say otherwise. No panel: the street is the thing being looked at.

   `res.roads` carries, per OSM way, the runs of the breadcrumb that way was
   driven along, so every street drawn here is a slice of the track already
   computed rather than a second copy of the network. Runs and not whole arcs:
   the solver merges a chain of ways into one arc, and crediting each of them
   with the whole run made a 100 m street select and colour as a 2 km one. */

/* The three answers, in the order the card offers them, with the colour each
   one paints its streets. The colours are the whole point of the editor's view:
   what you have changed is read off the map rather than counted up. Include is
   what a street is until it is told otherwise, so green is "untouched". */
const DRIVE_STATES = [
  { key: 'cover', label: 'Include', css: '--drive-cover' },
  { key: 'access', label: 'Access only', css: '--drive-access' },
  { key: 'never', label: 'Not driveable', css: '--drive-never' },
];

const driveState = (key) =>
  DRIVE_STATES.find((s) => s.key === key) || DRIVE_STATES[0];

// What OpenStreetMap itself says, which is what a street is until it is told
// otherwise. A connector is the graph's word for drivable but never covered.
const osmDrive = (road) => (road.connector ? 'access' : 'cover');

/* What the user has said about a street, and nothing else. Untouched is Include,
   whatever OpenStreetMap calls the street - the editor's colours are a record of
   what *you* changed, not a second opinion on road classification, and a map
   that painted every service road amber on a first draw buried the two or three
   that had actually been edited.

   Checked against the three rather than merely for being set: fixes arrive from
   a metadata.json that may have been edited by hand, and everything downstream
   of here indexes by the answer. */
function driveOf(road) {
  const fix = state.fixes[String(road.way)];
  return fix && DRIVE_STATES.some((s) => s.key === fix.drive) ? fix.drive : 'cover';
}

const fixCount = () => Object.keys(state.fixes).length;

const roadName = (road) => road.name || `${road.highway || 'street'} ${road.way}`;

const roadDistance = (road) => (road.metres >= 1000
  ? `${(road.metres / 1000).toFixed(1)} km` : `${Math.round(road.metres)} m`);

/* The drives the editor draws from: this one, and the unedited one behind it.
   Both, because a street marked "not driveable" leaves the next result, and if
   the map only ever showed the current drive it would leave with it - taking
   the only handle for undoing the fix. Compared by track identity, since the
   baseline is usually this very result. */
function editSources() {
  const out = [];
  const seen = new Set();
  for (const src of [state.result, state.baseline]) {
    if (!src || !src.track || !src.arc_start || !src.roads) continue;
    if (seen.has(src.track)) continue;
    seen.add(src.track);
    out.push(src);
  }
  return out;
}

/* Every street the editor knows about, this drive's copy winning where both
   have one, and each entry remembering which drive's breadcrumb it is a slice
   of. Last come fixes whose street has left both drives: they can still be
   named and set back, they just have no geometry left to draw. */
function buildRoadIndex() {
  const index = new Map();
  for (const src of editSources()) {
    for (const road of src.roads) {
      const key = String(road.way);
      const entry = index.get(key);
      /* `parts` is every drive that has this street, not just the winner.
         Drawing only the winner's arcs was why hovering a street the route now
         half-drives lit up half of it: the other half is the baseline's, and
         the baseline was never asked. `road` and `src` stay the current drive's
         copy, which is what the card and the colours read. */
      if (entry) entry.parts.push({ road, src });
      else index.set(key, { road, src, parts: [{ road, src }] });
    }
  }
  for (const [way, fix] of Object.entries(state.fixes)) {
    const entry = index.get(way);
    // The copy the fix kept of its street, which may be all that is left of it.
    if (entry) { entry.geom = fix.geom || null; continue; }
    index.set(way, {
      src: null,
      parts: [],
      geom: fix.geom || null,
      road: {
        way, name: fix.name || null, highway: fix.highway || null,
        metres: fix.metres || 0, oneway: !!fix.oneway, connector: !!fix.connector,
        spans: [],
      },
    });
  }
  state.roadIndex = index;
}

const entryFor = (way) => (way ? state.roadIndex.get(String(way)) || null : null);

const selectedEntry = () => entryFor(state.fixWay);

/* One street as the drives still have it: `spans` are [from, to) runs of the
   breadcrumb that street was driven along, so drawing it is a slice of the
   track already on the map rather than a second copy of the network. Gathered
   across every drive that has it, since a street this drive only half covers
   may have the rest of it in the baseline. */
function partLines(entry) {
  if (!entry) return [];
  const lines = [];
  for (const part of entry.parts) {
    const track = part.src.track || [];
    for (const [from, to] of part.road.spans || []) {
      if (to > from && to < track.length) lines.push(track.slice(from, to + 1));
    }
  }
  return lines;
}

/* Everything the editor can draw of one street: what the drives still have,
   plus the copy the fix kept. A street set to "not driveable" leaves the next
   result, and it may never have been in the baseline either - a street can come
   into the picture through an earlier fix - so a fix records its geometry at the
   moment it is made, which is the one moment the street is certain to be there. */
function roadLines(entry) {
  if (!entry) return [];
  const lines = partLines(entry);
  if (entry.geom && entry.geom.length) lines.push(...entry.geom);
  return lines;
}

/* Every street, painted with what you have said about it: green untouched,
   amber set to access only, red set to not driveable. A record of the edits,
   so a first draw is all green and the handful that have been changed are the
   only thing on the map that is not. Built by walking the breadcrumb step by
   step rather than slicing street by street, so the whole map costs one pass.

   Both drives contribute every step they have. Skipping a baseline step because
   this drive still has that *street* was wrong: coverage belongs to a stretch of
   road, not to a street, so a street this drive only half covers lost its other
   half off the map - which is exactly what "access only" does to one. The
   duplication that costs is invisible: a step in both drives is the same street
   and so the same colour, and where there are no fixes at all the two drives
   are the same object and the second pass never runs. */
function drawStreets() {
  for (const line of state.streetLayers) map.removeLayer(line);
  state.streetLayers = [];
  if (!state.fixModeOn) return;

  const paths = { cover: [], access: [], never: [] };
  for (const src of editSources()) {
    const track = src.track, roads = roadOfSegment(src);
    // Steps that follow each other and answer the same are extended rather than
    // pushed, so a long street is one line and not forty. Leaflet re-clips and
    // re-simplifies every line it holds on every pan; the point count is the
    // same either way, the per-line overhead is not.
    let run = null, runKey = null;
    for (let i = 0; i < roads.length; i++) {
      const road = roads[i];
      const key = road ? driveOf(road) : null;
      if (!key) { run = null; runKey = null; continue; }
      if (run && key === runKey) run.push(track[i + 1]);
      else { run = [track[i], track[i + 1]]; paths[key].push(run); runKey = key; }
    }
  }
  /* Streets a fix has taken out of every drive. Their geometry was put by in the
     fix at the moment it was made, precisely so there is still something to
     paint red here. Drawn again for streets that are also still driven, which
     costs a second stroke of the identical colour over the identical line. */
  for (const [way, fix] of Object.entries(state.fixes)) {
    if (!fix.geom || !fix.geom.length) continue;
    for (const line of fix.geom) paths[driveOf({ way })].push(line);
  }
  for (const st of DRIVE_STATES) {
    if (!paths[st.key].length) continue;
    state.streetLayers.push(L.polyline(paths[st.key], {
      color: cssVar(st.css), weight: ROUTE_WEIGHT, opacity: 0.9,
      interactive: false,
    }).addTo(map));
  }
}

/* Which street is under the pointer, and which one the card is open on. The
   three colours already say what a street *is*, so neither of these says
   anything with colour - both are the street's own colour drawn heavier, the
   selected one heavier still. A second hue here only competed with the three
   that mean something. */
const HOVER_WEIGHT = ROUTE_WEIGHT + 4;
const PICKED_WEIGHT = ROUTE_WEIGHT + 7;

function drawFocus() {
  for (const line of state.focusLayers) map.removeLayer(line);
  state.focusLayers = [];
  if (!state.fixModeOn) return;

  const thicken = (entry, weight) => {
    const lines = roadLines(entry);
    if (!lines.length) return;
    state.focusLayers.push(L.polyline(lines, {
      color: cssVar(driveState(driveOf(entry.road)).css),
      weight, opacity: 1, interactive: false,
    }).addTo(map));
  };

  const selected = selectedEntry();
  const hover = state.hoverRoad ? entryFor(state.hoverRoad.way) : null;
  if (hover && hover !== selected) thicken(hover, HOVER_WEIGHT);
  if (selected) thicken(selected, PICKED_WEIGHT);
}

/* The card a click opens: what OpenStreetMap says about the street, and the one
   control that says otherwise. On the street rather than in the panel, because
   the street is the thing being looked at.

   Anchored where the click landed and left there, so the recompute that follows
   puts it back exactly where it was and the answer can be read off the same
   piece of map the question was asked on. */
function openRoadCard(entry, at) {
  if (!entry) { closeRoadCard(); return; }
  state.fixWay = String(entry.road.way);
  if (at) state.fixAt = at;
  if (!state.fixAt) return;

  const road = entry.road;
  const drive = driveOf(road);
  const facts = [road.highway, roadDistance(road),
                 road.oneway ? 'one way' : 'both ways']
    .filter(Boolean).map((t) => escapeHtml(String(t))).join(' · ');
  /* The panel's own one-of-N control, markup and all, rather than a <select>.
     Same reason the map picker is hand-built: a native popup is an OS window
     and keeps its own corners, colours and highlight whatever the page asks
     for, which in a card this size reads as a piece of another program. */
  const options = DRIVE_STATES.map((st) =>
    '<label><input type="radio" name="road-drive"'
    + ` value="${st.key}"${st.key === drive ? ' checked' : ''}>`
    + `<span>${st.label}</span></label>`).join('');

  if (!state.cardPopup) {
    /* No close button: clicking off the street closes it, which is the gesture
       people reach for anyway, and a card this small does not have the room to
       spend on a control for something the map already does.

       autoPan off: the map holding still is the point of the editor. placeCard()
       moves the card to fit instead of moving the ground under it. */
    state.cardPopup = L.popup({
      className: 'road-popup', closeButton: false, autoClose: false,
      closeOnClick: false, autoPan: false, maxWidth: 300, offset: CARD_OFFSET,
    });
  }
  state.cardPopup.setLatLng(state.fixAt).setContent(
    '<div class="road-card">'
    + `<div class="road-card-name">${escapeHtml(roadName(road))}</div>`
    + `<div class="road-card-meta">${facts}</div>`
    // Unlabelled: three answers about the street named directly above them,
    // in the colours that street is drawn in. Naming it would be reading
    // matter for something already obvious.
    + `<div class="segmented road-card-drive">${options}</div>`
    + '<a class="road-card-link" target="_blank" rel="noopener noreferrer"'
    + ` href="https://www.openstreetmap.org/way/${encodeURIComponent(road.way)}">`
    + `Way ${escapeHtml(String(road.way))} on OpenStreetMap</a></div>`);
  if (!map.hasLayer(state.cardPopup)) state.cardPopup.addTo(map);
  wireCard();
  placeCard();
  drawFocus();
}

/* Once, on the popup's own container, and delegated from there.

   Not on the radios: setContent rewrites the content's innerHTML, and so does
   popup.update(), which is how Leaflet repositions - so a listener on the
   inputs themselves is thrown away by the very next layout pass, and picking an
   answer then did nothing at all. The container outlives all of it; Leaflet
   builds it on the first open and reuses it from then on. */
function wireCard() {
  if (state.cardWired) return;
  const el = state.cardPopup && state.cardPopup.getElement();
  if (!el) return;
  state.cardWired = true;
  el.addEventListener('change', (ev) => {
    const picked = ev.target.closest && ev.target.closest('input[name="road-drive"]');
    if (picked) setDrive(state.fixWay, picked.value);
  });
}

/* Leaflet only ever hangs a popup above its point and centres it there, so near
   an edge - or under the floating tool bar, which is inside the map - the card
   goes off the map or behind the bar. It is laid out, measured, and moved back
   in: flipped under the street when there is no room over it, slid sideways
   when there is none beside it. Corrections are pure translations of the
   popup's own offset, so one pass lands it exactly and there is nothing to
   oscillate. The map itself never moves - that is the whole point of the
   editor's recompute, and it would be odd to give it up for a card.

   Re-run at the end of a gesture rather than during one: mid-pan the card
   should travel with its street, which is what it already does. */
const CARD_OFFSET = L.point(0, -6);   // where Leaflet puts it: just above
const CARD_EDGE = 10;                 // clearance from the map's own edges
const CARD_TIP = 20;                  // the height of Leaflet's little arrow

function placeCard() {
  const popup = state.cardPopup;
  if (!popup || !map.hasLayer(popup)) return;
  const el = popup.getElement();
  if (!el) return;

  const rect = () => el.getBoundingClientRect();
  /* Position only. popup.update() would do it, but it rewrites the card's
     innerHTML on the way past, which costs the keyboard whatever it had focused
     and is a rebuild per pan for nothing. Falls back to update() if a Leaflet
     without the internal ever turns up. */
  const reposition = () => {
    if (popup._updatePosition) popup._updatePosition(); else popup.update();
  };
  const moveBy = (dx, dy) => {
    popup.options.offset = popup.options.offset.add(L.point(dx, dy));
    reposition();
  };

  // Back to where Leaflet would have put it, so what follows measures the
  // natural placement rather than the last one we talked it into.
  el.classList.remove('below', 'nudged');
  popup.options.offset = CARD_OFFSET;
  reposition();

  const frame = mapEl.getBoundingClientRect();
  const bar = $('topbar').getBoundingClientRect();
  const anchorY = frame.top + map.latLngToContainerPoint(popup.getLatLng()).y;
  // The tool bar floats over the map, so the usable top is under it.
  const top = Math.max(frame.top, Math.min(bar.bottom, frame.bottom)) + CARD_EDGE;
  const bottom = frame.bottom - CARD_EDGE;

  let box = rect();
  // No room over the street and room under it: hang it the other way up.
  if (box.top < top && anchorY + CARD_TIP + box.height <= bottom) {
    el.classList.add('below');
    moveBy(0, (anchorY + CARD_TIP) - rect().top);
    box = rect();
  }

  // Whatever is still outside: slide it in, and drop the arrow, which no longer
  // points at anything once the card has left the street it belongs to.
  let dx = 0, dy = 0;
  if (box.left < frame.left + CARD_EDGE) dx = frame.left + CARD_EDGE - box.left;
  else if (box.right > frame.right - CARD_EDGE) dx = frame.right - CARD_EDGE - box.right;
  if (box.top < top) dy = top - box.top;
  else if (box.bottom > bottom) dy = Math.max(bottom - box.bottom, top - box.top);
  if (dx || dy) {
    el.classList.add('nudged');
    moveBy(dx, dy);
  }
}

map.on('moveend zoomend resize', placeCard);

// Put away without letting go: the tool changed, or a recompute is running.
function hideRoadCard() {
  if (!state.cardPopup || !map.hasLayer(state.cardPopup)) return;
  state.cardHiding = true;
  map.removeLayer(state.cardPopup);
  state.cardHiding = false;
}

function closeRoadCard() {
  hideRoadCard();
  state.fixWay = '';
  state.fixAt = null;
  drawFocus();
}

// The card's own close button, or Escape. The card is the selection, so
// dismissing it lets the street go too - unlike hideRoadCard above.
map.on('popupclose', (ev) => {
  if (ev.popup !== state.cardPopup || state.cardHiding) return;
  state.fixWay = '';
  state.fixAt = null;
  drawFocus();
});

/* Stored only where it differs from OpenStreetMap, so a street set back to what
   the map already said stops being a fix rather than becoming a no-op one.

   The street's own details are stored with it. A street marked "not driveable"
   leaves the next result, and without them there would be nothing left to name
   it by - the fix would be permanent by accident.

   Then straight into a recompute: there is nothing to confirm, and the new
   route is the only way to see whether the answer was the right one. */
function setDrive(way, drive) {
  const entry = entryFor(way);
  if (!entry) return;
  const road = entry.road;
  /* Include is the untouched state, so on a street OpenStreetMap already covers
     it is not an answer at all and the fix goes. On one OSM calls a connector it
     very much is an answer - it promotes a service road to something the drive
     has to cover - so that one is kept. */
  const key = String(way);
  const held = state.fixes[key];
  if (drive === 'cover' && osmDrive(road) === 'cover') {
    delete state.fixes[key];
  } else {
    state.fixes[key] = {
      drive,
      name: road.name, highway: road.highway, metres: road.metres,
      oneway: road.oneway, connector: road.connector,
      /* Its geometry, kept from the first time this street was touched. After
         that it may be out of the route altogether and there would be nothing
         left to measure - this is what keeps it on the editor's map. */
      geom: (held && held.geom && held.geom.length) ? held.geom : partLines(entry),
    };
  }
  /* Repainted before the solve, so the answer registers immediately - and then
     the card goes, street and all. Picking one of three is the whole of what
     there was to do here, so leaving it open would only be something else to
     dismiss, and the street's new colour says what was chosen. */
  drawStreets();
  closeRoadCard();
  saveSession();
  recompute({ keepView: true });
}

/* The editor's own recompute. Same view, same zoom, same tool and the same card
   still open: the change has to be checkable where it was made, and a route
   that refits the map to itself moves the evidence off the screen. */
function recompute({ keepView = false } = {}) {
  if ($('compute').disabled) return;
  state.keepView = keepView;
  $('compute').click();
}

/* The unedited drive, kept beside the current one so the editor still has a map
   of the streets after a fix takes one out of the route. Refreshed by any
   result computed with no fixes in force - that run is the full picture by
   definition - and taken from an edited one only when there is nothing better.
   Dropped wherever the question changes, since it is then the answer to one
   nobody asked. */
function captureBaseline(res) {
  if (fixCount() && state.baseline) return;
  state.baseline = { track: res.track, arc_start: res.arc_start, roads: res.roads };
}

function dropBaseline() { state.baseline = null; }

// Back into the editor after its own recompute, or plainly into whatever the
// tool now is. The layers are new either way, so one of the two has to run.
function resumeEditor() {
  const back = state.resumeSelect;
  state.resumeSelect = false;
  if (back && state.result && state.mode !== 'select') setMode('select');
  else syncFixMode({ force: true });
}

// How close the pointer has to get to a street, in screen pixels. Generous on
// purpose: these are 3px lines and nobody should have to hunt for one.
const FIX_HOVER_PX = 26;

/* Edit coverage is the editor: arming it turns the drive into a map of streets,
   and any other tool turns it back. No separate switch, since there was never a
   state where one was on and the other off. */
function syncFixMode({ force = false } = {}) {
  const on = state.mode === 'select' && !!state.result;
  /* Nothing to do unless it actually changed. setMode() runs for things that
     are not really a tool change at all, and rebuilding the layers each time
     left the map stuck to the pointer mid-drag. */
  if (!force && on === state.fixModeOn) return;
  state.fixModeOn = on;
  state.pickingRoad = on;
  /* Sessions are put away rather than dimmed. Their colours are what the drive
     is read by, and the editor is not reading the drive: it wants a map of
     streets, drawn from the breadcrumb rather than from the offset session
     lines. That is what makes it one line per street - normally a street driven
     both ways is two passes 4.5 m either side of the centre, and here they land
     on top of each other, which is what a street is. */
  if (on) state.routeLayers.forEach((line) => { if (line) line.setStyle({ opacity: 0 }); });
  if (state.detail) {
    if (on) state.detail.clear();
    else if (state.result) {
      state.detail.setRoute({
        arrows: state.routeArrows || [],
        colors: state.routeLayers.map((_, i) => sessionColor(i)),
        dots: state.result.waypoints || [],
      });
    }
  }
  // Back to the drive: whatever the legend had picked is showing again.
  if (!on) applyHighlight(state.shown, { scroll: false });

  drawStreets();
  /* The selected street outlives the tool. A middle-button pan leaves and
     re-enters this mode, and a recompute leaves it for as long as the solve
     takes; losing the street to either made the editor unusable. So coming
     back just puts the card up again where it was. */
  if (on) openRoadCard(selectedEntry(), null);
  else hideRoadCard();
  drawFocus();

  $('legend').classList.toggle('hidden', on || !state.result);
  state.hoverRoad = null;
}

/* Breadcrumb step -> the street driven along it: out[i] is the road between
   track[i] and track[i+1]. One per drive, kept against the drive itself, so the
   baseline's does not have to be rebuilt every time this one is. */
const segmentRoads = new WeakMap();

function roadOfSegment(src) {
  let out = segmentRoads.get(src);
  if (out) return out;
  out = new Array(Math.max((src.track || []).length - 1, 0));
  for (const road of src.roads || []) {
    for (const [from, to] of road.spans || []) {
      for (let i = from; i < to && i < out.length; i++) out[i] = road;
    }
  }
  segmentRoads.set(src, out);
  return out;
}

/* The street under the pointer. One pass over the breadcrumb the route is
   already drawn from, compared in degrees rather than pixels - projecting every
   point per mouse move is what makes the obvious version unusable on a
   city-sized track. Longitude is scaled by cos(lat) so the radius stays round. */
function roadAt(latlng) {
  const sources = editSources();
  if (!sources.length) return null;
  const centre = map.getCenter();
  const a = map.latLngToContainerPoint(centre);
  const b = map.latLngToContainerPoint(L.latLng(centre.lat + 0.01, centre.lng));
  const degPerPx = 0.01 / Math.max(Math.abs(b.y - a.y), 1e-9);
  const reach = FIX_HOVER_PX * degPerPx;
  const cosLat = Math.max(Math.cos(latlng.lat * Math.PI / 180), 1e-6);

  /* Distance to the *segment*, not to the nearest vertex. A long straight
     stretch may have two points a kilometre apart, and testing only those means
     hunting for the spot where one happens to be - which is what made this hard
     to hover at all. */
  let bestD = reach * reach;
  let best = null;
  const scan = (points, found) => {
    for (let t = 1; t < points.length; t++) {
      const ay = points[t - 1][0], ax = (points[t - 1][1] - latlng.lng) * cosLat;
      const by = points[t][0], bx = (points[t][1] - latlng.lng) * cosLat;
      const vy = by - ay, vx = bx - ax;
      const wy = latlng.lat - ay, wx = -ax;
      const len = vx * vx + vy * vy;
      const u = len > 0 ? Math.min(Math.max((wx * vx + wy * vy) / len, 0), 1) : 0;
      const dy = wy - u * vy, dx = wx - u * vx;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = found(t - 1); }
    }
  };

  for (const src of sources) {
    const seg = roadOfSegment(src);
    scan(src.track, (i) => ({ way: seg[i] && seg[i].way, at: src.track[i] }));
  }
  /* And the copies the fixes keep. A street taken out of every drive is on the
     map from one of those, so it has to be findable there too - otherwise one
     set to "not driveable" could be seen and never set back. */
  for (const [way, fix] of Object.entries(state.fixes)) {
    for (const line of fix.geom || []) scan(line, (i) => ({ way, at: line[i] }));
  }

  // Resolved through the index, so the card, the highlight and the colours are
  // all talking about the same copy of the street. The point nearest the
  // pointer comes back too, so the card can sit on the street.
  const entry = best && best.way ? entryFor(best.way) : null;
  if (!entry) return null;
  return { entry, road: entry.road, at: L.latLng(best.at[0], best.at[1]) };
}

/* Over the card counts as over the card, not as over whatever street happens to
   lie under it - the pointer is on its way to the control. */
const overCard = (ev) => {
  const t = ev.originalEvent && ev.originalEvent.target;
  return !!(t && t.closest && t.closest('.leaflet-popup'));
};

/* The street under the pointer is drawn heavier and nothing else happens: no
   label, no bubble, nothing that moves. A name that follows the pointer around
   is reading matter at the exact moment you are trying to aim at something, and
   the card says all of it once you have. */
map.on('mousemove', (ev) => {
  if (!state.pickingRoad || state.mode !== 'select' || overCard(ev)) return;
  const hit = roadAt(ev.latlng);
  const road = hit ? hit.road : null;
  // Redrawing the same street on every pixel of movement is wasted work.
  if (road === state.hoverRoad) return;
  state.hoverRoad = road;
  drawFocus();
});

// Off the map altogether. Moving onto the card does not count: that is inside.
map.on('mouseout', () => {
  if (!state.pickingRoad || !state.hoverRoad) return;
  state.hoverRoad = null;
  drawFocus();
});

map.on('click', (ev) => {
  if (!state.pickingRoad || state.mode !== 'select') return;
  const hit = roadAt(ev.latlng);
  if (hit) openRoadCard(hit.entry, hit.at);
  else closeRoadCard();
});

function renderResult(res) {
  $('stats-card').classList.remove('hidden');
  const notes = Array.isArray(res.notes) ? res.notes : [];
  $('route-notes').textContent = notes.map((n) => n[0].toUpperCase() + n.slice(1) + '.').join(' ');
  // There is something to edit now, so the tool for it exists.
  $('mode-select').classList.remove('hidden');
  buildRoadIndex();

  const st = res.stats;
  const cov = res.coverage;
  const sessions = res.sessions;
  // With rules, "in area" is what they selected there, not every road.
  const selective = Array.isArray(res.request?.selection) && res.request.selection.length > 0;
  syncRulesInfo();
  $('summary').innerHTML = [
    ['Distance', `${st.total_km} km`],
    ['Driving', st.duration, DRIVING_TIP],
    ['Sessions', sessions.length],
    ['Roads covered', `${cov.centerline_km_covered} km`],
    ['Coverage', `${cov.coverage_pct}%`],
    [selective ? 'Selected in area' : 'Roads in area', `${cov.centerline_km_in_area} km`],
    ['Unreachable', `${cov.km_dropped_not_strongly_connected} km`],
    ['Coverage modifiers', fixCount(), MODIFIERS_TIP],
  ].map(([label, value, tip]) =>
    `<div class="tile"><span class="tile-label">${label}${tip ? infoMarker(tip) : ''}</span>`
    + `<span class="tile-value">${escapeHtml(String(value))}</span></div>`
  ).join('');

  // One button, one zip. GPX one per session, because an 80,000-point track is
  // more than most nav apps take, plus metadata.json either way.
  const many = sessions.length > 1;
  $('download').textContent = many
    ? `Download ${sessions.length} sessions (.zip)`
    : 'Download route (.zip)';
  $('download-note').textContent =
    'Open the downloaded .gpx file(s) in OsmAnd or any other similar mobile app. '
    + 'Downloaded ZIP file also contains metadata.json, which is necessary to '
    + 'load this export back to Routile.';
}

$('download').onclick = async () => {
  const res = state.result;
  if (!res) return;
  const button = $('download');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Preparing...';
  try {
    // One moment for the whole package: zip name, GPX names and `saved` agree.
    const meta = routeMetadata(res);
    const stamp = fileStamp(new Date(meta.saved));
    const blob = await gpxZip(res, { metadata: meta, stamp });
    const kind = res.sessions.length > 1 ? 'sessions' : 'route';
    saveBlob(blob, `routile-${kind}-${stamp}.zip`);
  } catch (err) {
    showMapAlert(`Could not build the file: ${err.message}`);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
};

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* ----------------------------------------------------------------- route */
// `arc_start` maps a tour arc to where it begins in the breadcrumb, and each
// session knows its arcs. Slicing there rather than by distance keeps every
// session's line joined to the next exactly.
function sessionSlice(res, track, session) {
  const starts = res.arc_start || [];
  if (!starts.length || !session.arc_span) return null;
  const at = (arc) => starts[Math.min(Math.max(arc, 0), starts.length - 1)];
  const from = at(session.arc_span[0]);
  const to = at(session.arc_span[1]);
  return to > from ? track.slice(from, to + 1) : null;
}

/* Shift every point right of the direction of travel, the way a map draws a
   dual carriageway. Without it a street driven both ways is two lines on top of
   each other, indistinguishable from one driven once. Falls out of the
   geometry, so it needs no extra data and works for three passes as for two.

   A fixed distance on the ground, not in pixels, so it stays a real
   half-carriageway: invisible zoomed out, clear zoomed in. */
function offsetRight(points, metres) {
  const out = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const before = points[Math.max(i - 1, 0)];
    const after = points[Math.min(i + 1, points.length - 1)];
    const lat = points[i][0];
    const kx = Math.cos(rad(lat)) || 1e-6;
    let east = (after[1] - before[1]) * kx;
    let north = after[0] - before[0];
    const len = Math.hypot(east, north);
    if (!len) { out[i] = points[i]; continue; }
    east /= len;
    north /= len;
    // Right of travel is the heading turned 90 degrees clockwise: (north, -east).
    out[i] = [
      lat + (-east * metres) / KM_PER_DEG / 1000,
      points[i][1] + (north * metres) / KM_PER_DEG / 1000 / kx,
    ];
  }
  return out;
}

function bearingAt(points, i) {
  const a = points[Math.max(i - 1, 0)];
  const b = points[Math.min(i + 1, points.length - 1)];
  const kx = Math.cos(rad(points[i][0])) || 1e-6;
  return Math.atan2((b[1] - a[1]) * kx, b[0] - a[0]) * 180 / Math.PI;
}

function metresBetween(a, b) {
  const kx = Math.cos(rad(a[0])) || 1e-6;
  return Math.hypot((b[1] - a[1]) * kx, b[0] - a[0]) * KM_PER_DEG * 1000;
}

function drawSessions(res, track, { fit = true } = {}) {
  clearRouteLayers();
  const sessions = res.sessions;
  const arrows = [];

  sessions.forEach((session, i) => {
    const raw = sessionSlice(res, track, session) || [];
    if (raw.length < 2) return;
    const points = offsetRight(raw, OFFSET_M);
    // interactive:false: a route line is drawn output, not a control. Sessions
    // are hovered and picked in the legend, so a line under the pointer must
    // not catch a click meant for the map.
    const line = L.polyline(points, {
      color: sessionColor(i), weight: ROUTE_WEIGHT, opacity: 0.85,
      interactive: false,
    }).addTo(map);
    state.routeLayers[i] = line;
    state.sessionPoints[i] = points;
    arrows[i] = arrowsAlong(points);
  });

  // Kept so the street editor can put them back when it hands the map over.
  state.routeArrows = arrows;
  state.detail.setRoute({
    arrows,
    colors: sessions.map((_, i) => sessionColor(i)),
    dots: res.waypoints || [],
  });

  buildLegend(sessions, res.stops || []);
  drawStops(res);

  const drawn = state.routeLayers.filter(Boolean);
  if (fit && drawn.length) {
    const bounds = drawn.reduce(
      (acc, line) => (acc ? acc.extend(line.getBounds()) : line.getBounds()), null
    );
    map.fitBounds(bounds, { padding: [30, 30] });
  }
}

// Every arrow a session needs, worked out once when its line is drawn: one per
// ARROW_SPACING_M with its heading, after which "on screen?" is a bounds test.
// Spacing does not depend on the viewport, so redoing it per pan - hundreds of
// thousands of distance calculations on a 400 km route - was wasted.
function arrowsAlong(points) {
  const out = [];
  let since = ARROW_SPACING_M;      // so the first one lands at the very start
  for (let n = 1; n < points.length; n++) {
    since += metresBetween(points[n - 1], points[n]);
    if (since < ARROW_SPACING_M) continue;
    since = 0;
    out.push({ lat: points[n][0], lon: points[n][1], deg: bearingAt(points, n) });
  }
  return out;
}

// null is the whole route, which is what the All sessions row stands for.
function sessionOf(item) {
  return item.dataset.session === 'all' ? null : Number(item.dataset.session);
}

// The deadhead line under a row's figures: distance, time and its share of
// the row's distance. Nothing for a route computed before sessions had it.
function deadheadLine(km, deadKm, deadMinutes) {
  if (!Number.isFinite(deadKm) || !Number.isFinite(deadMinutes)) return '';
  const pct = km > 0 ? Math.round(100 * deadKm / km) : 0;
  return `<span class="legend-dead" title="Driving that covers nothing: getting between streets, `
    + `streets driven again, detours to breaks and trips home">`
    + `deadhead ${pct}% · ${deadKm.toFixed(1)} km · ${humanMinutes(deadMinutes)}</span>`;
}

function legendRow(key, color, name, km, minutes, then = '', dead = null) {
  // The stripe is on every row, colourless on All sessions, so each label in
  // the list starts at the same place.
  return `<button type="button" class="legend-item${color ? '' : ' legend-all'}"`
    + ` data-session="${key}" role="listitem">`
    + `<span class="stripe"${color ? ` style="background:${color}"` : ''}></span>`
    + '<span class="legend-text">'
    + `<span class="legend-name">${name}</span>`
    + `<span class="legend-meta">${Number(km).toFixed(1)} km · ${humanMinutes(minutes)}</span>`
    + (dead ? deadheadLine(Number(km), dead.km, dead.minutes) : '')
    + (then ? `<span class="legend-stop">${escapeHtml(then)}</span>` : '')
    + '</span></button>';
}

// What comes after a session, under its figures: the restaurant its break is
// at, home, or the end of the day, when sessions are joined into days.
function sessionThen(sessions, stops, i) {
  const s = sessions[i];
  if (s.stop !== undefined && stops[s.stop]) return `then ${stops[s.stop].name}`;
  if (s.home) return s.day !== undefined ? `end of day ${s.day + 1} · home` : 'back home';
  if (s.day === undefined) return '';
  const next = sessions[i + 1];
  return !next || next.day !== s.day ? `end of day ${s.day + 1}` : '';
}

function buildLegend(sessions, stops = []) {
  const box = $('legend');
  const deadOf = (s) => ({ km: Number(s.deadhead_km), minutes: Number(s.deadhead_minutes) });
  const rows = sessions.map((session, i) => legendRow(i, sessionColor(i), `Session ${i + 1}`,
    session.km, session.minutes, sessionThen(sessions, stops, i), deadOf(session)));
  // Totalled from the rows it sits above, so the sums agree with the list. One
  // session is already its own whole route, so the row would only repeat it.
  if (sessions.length > 1) {
    const sum = (field) => sessions.reduce((s, x) => s + (Number(x[field]) || 0), 0);
    rows.unshift(legendRow('all', null, 'All sessions', sum('km'), sum('minutes'), '',
      sessions.every((s) => s.deadhead_km !== undefined)
        ? { km: sum('deadhead_km'), minutes: sum('deadhead_minutes') } : null));
  }
  box.innerHTML = rows.join('');
  box.classList.toggle('hidden', sessions.length === 0);
  layoutOverlays();

  for (const item of box.querySelectorAll('.legend-item')) {
    const i = sessionOf(item);
    item.addEventListener('mouseenter', () => preview(i));
    item.addEventListener('mouseleave', () => endPreview());
    item.addEventListener('focus', () => preview(i));
    item.addEventListener('blur', () => endPreview());
    item.addEventListener('click', () => pin(i));
  }
  pin(state.pinned);      // a fresh route starts on All sessions
}

/* The top bar floats centred over the map with the session list beside it, and
   gives way in four cumulative steps as the window narrows: tools drop their
   labels, the bar slides left out of the centre, the session list drops below
   the bar, then the panel stacks above the map and hands it 388px. Nothing ever
   leaves the map.

   The session list steps aside before the panel does: it shows up only once a
   route exists, and stacking for it alone turned a wide laptop screen into the
   phone layout the moment a route was computed.

   Measured, not guessed from a breakpoint: room needed depends on the labels,
   room available on whether there are sessions to list. Each step strips the
   classes, measures the bar at its natural width, and re-adds only while it
   still does not fit.

   Cumulative on purpose - a narrower window can only take more away. Undoing a
   step at a narrower width would flicker as the window is dragged. And stacking
   is judged against the *unstacked* width, so it never measures against the
   width its own answer produced. */
const phoneLayout = window.matchMedia('(max-width: 860px)');
phoneLayout.addEventListener('change', () => layoutOverlays());

function layoutOverlays() {
  const stage = $('stage');
  const root = document.documentElement;
  stage.classList.remove('tools-tight', 'tools-left', 'legend-below', 'find-above');
  root.classList.remove('app-stacked');
  putFinderInBar();

  // Below the breakpoint the stacked shape is right whatever the bar fits into.
  if (phoneLayout.matches) {
    stage.classList.add('tools-tight', 'tools-left');
    root.classList.add('app-stacked');
  } else {
    if (barIsCrowded()) stage.classList.add('tools-tight');
    if (barIsCrowded()) stage.classList.add('tools-left');
    if (barIsCrowded()) stage.classList.add('legend-below');
    if (barIsCrowded()) root.classList.add('app-stacked');
  }

  // Last resort, reachable only once stacked: the bar is clamped to the stage
  // by then and the search box has a width floor, so anything left overflows.
  // Picker and search step out above the map; the tools keep the floating bar.
  if (barOverflows()) {
    stage.classList.add('find-above');
    stage.insertBefore($('findbar'), $('map'));
    // What the bar and the sessions, positioned against the stage, clear it by.
    stage.style.setProperty('--find-strip', `${$('findbar').offsetHeight}px`);
  }
}

// The finder's home is the tail of the floating bar. Put back before every
// measurement, so what is measured is always the whole bar.
function putFinderInBar() {
  const bar = $('topbar');
  if ($('findbar').parentElement !== bar) bar.appendChild($('findbar'));
  $('stage').style.removeProperty('--find-strip');
}

// True only of a clamped bar that still wants room: a floating one is sized to
// its content and cannot overflow itself.
function barOverflows() {
  const bar = $('topbar');
  return bar.scrollWidth > bar.clientWidth + 1;
}

// Does the bar, where it currently sits, clear both stage edges and the
// session list on its right? Once the list sits below the bar, only the edges.
function barIsCrowded() {
  const stage = $('stage').getBoundingClientRect();
  const bar = $('topbar').getBoundingClientRect();
  const clear = 10;
  if (bar.width > stage.width - 2 * clear) return true;
  const legend = $('legend');
  if (legend.classList.contains('hidden')) return false;
  if ($('stage').classList.contains('legend-below')) return false;
  return bar.right + clear > legend.getBoundingClientRect().left;
}

/* Two layers of one highlight, both driven from the legend. The pointer or the
   keyboard previews a row; a click pins it, so it survives the pointer leaving.
   Only All sessions puts the whole route back. */
const preview = (index) => applyHighlight(index, { scroll: false });

// The pointer left the legend, so whatever is pinned shows again.
const endPreview = () => applyHighlight(state.pinned);

function pin(index) {
  state.pinned = index;
  applyHighlight(index);
  for (const item of $('legend').querySelectorAll('.legend-item')) {
    item.classList.toggle('pinned', sessionOf(item) === index);
  }
}

// Highlighting leaves a session exactly as drawn and takes the others off the
// map, so what is left is that one leg on its own.
function applyHighlight(index, { scroll = true } = {}) {
  state.shown = index;
  state.routeLayers.forEach((line, i) => {
    if (!line) return;
    const hidden = index !== null && i !== index;
    line.setStyle({ opacity: hidden ? 0 : 0.85 });
    if (i === index) line.bringToFront();
  });

  state.detail.setHighlight(index);

  for (const item of $('legend').querySelectorAll('.legend-item')) {
    const hot = sessionOf(item) === index;
    item.classList.toggle('active', hot);
    // Keep the row visible when the legend has scrolled past it.
    if (hot && scroll) item.scrollIntoView({ block: 'nearest' });
  }
}

function humanMinutes(minutes) {
  const total = Math.round(Number(minutes) || 0);
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)} h ${total % 60} min`;
}

/* The breaks between sessions, one marker each: a knife and fork on the
   restaurant itself - not on the node the drive stops at, which may be across
   the road - named on hover, with the details on a click. */
const STOP_ICON = L.divIcon({
  className: 'stop-marker',
  html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3v7.5a2 2 0 0 0 4 0V3M9 3v18M16.5 21V3c-1.9 1-3 3.6-3 6.5 0 2.2.9 3.5 3 3.5"/></svg>',
  iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14],
});

/* What the stop's card says about the place, from its OSM tags: the ones a
   driver deciding on lunch reads, labelled, in this order. The rest are in the
   card's full tag list. A route saved before stops carried tags falls back to
   the three fields it did carry. */
const STOP_FACTS = [
  ['cuisine', 'Cuisine', (v) => v.replace(/;/g, ', ').replace(/_/g, ' ')],
  ['opening_hours', 'Open'],
  ['phone', 'Phone', null, (v) => `tel:${v.split(';')[0].replace(/[^\d+]/g, '')}`],
  ['contact:phone', 'Phone', null, (v) => `tel:${v.split(';')[0].replace(/[^\d+]/g, '')}`],
  ['email', 'Email', null, (v) => `mailto:${v.split(';')[0].trim()}`],
  ['contact:email', 'Email', null, (v) => `mailto:${v.split(';')[0].trim()}`],
  ['diet:vegetarian', 'Vegetarian'],
  ['diet:vegan', 'Vegan'],
  ['diet:gluten_free', 'Gluten free'],
  ['outdoor_seating', 'Outdoor seating'],
  ['takeaway', 'Takeaway'],
  ['reservation', 'Reservation'],
  ['wheelchair', 'Wheelchair'],
  ['air_conditioning', 'Air conditioning'],
  ['smoking', 'Smoking'],
  ['capacity', 'Seats'],
  ['description', 'About'],
];

function stopTags(st) {
  if (st.tags) return st.tags;
  const t = { name: st.name };
  if (st.cuisine) t.cuisine = st.cuisine;
  if (st.opening_hours) t.opening_hours = st.opening_hours;
  if (st.website) t.website = st.website;
  return t;
}

// "Street 12, 851 01 City" from the addr:* tags, or '' when OSM has none.
function stopAddress(t) {
  const street = [t['addr:street'] || t['addr:place'],
    t['addr:housenumber'] || t['addr:streetnumber'] || t['addr:conscriptionnumber']].filter(Boolean).join(' ');
  const town = [t['addr:postcode'], t['addr:city'] || t['addr:town'] || t['addr:village']].filter(Boolean).join(' ');
  return [street, town].filter(Boolean).join(', ');
}

const httpUrl = (v) => (/^https?:\/\//i.test(v || '') ? v : v && /^www\./i.test(v) ? `https://${v}` : null);

/* Google Maps for the place. With an address, the documented search URL
   (maps/search/?api=1&query=), which the Google Maps app on a phone opens too:
   name and address together find the listing itself. Without one, a name alone
   would find every restaurant of that name, so the search is pinned to where
   OSM has the place instead, which Google Maps reads from the @lat,lon,zoom
   part of its own search URLs. */
function googleMapsUrl(st) {
  const address = stopAddress(stopTags(st));
  if (address) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${st.name}, ${address}`)}`;
  }
  return `https://www.google.com/maps/search/${encodeURIComponent(st.name)}/@${st.lat},${st.lon},18z`;
}

const stopRef = (st) => `${st.osm_type}/${st.osm_id}`;

function stopCard(st, k) {
  const t = stopTags(st);
  const after = st.after_session >= 0 ? st.after_session + 1 : null;
  const link = (href, text) => `<a class="road-card-link" target="_blank" rel="noopener noreferrer" href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
  const rows = [];
  const address = stopAddress(t);
  if (address) rows.push(['Address', escapeHtml(address)]);
  const seen = new Set();
  for (const [key, label, show, href] of STOP_FACTS) {
    const v = t[key];
    if (!v || seen.has(label)) continue;
    seen.add(label);
    const text = escapeHtml(show ? show(v) : v);
    rows.push([label, href ? `<a href="${escapeHtml(href(v))}">${text}</a>` : text]);
  }
  const web = httpUrl(t.website || t['contact:website'] || t.url);
  const detour = st.detour_km > 0
    ? `${st.detour_km} km off the route, ${humanMinutes(st.detour_min)} there and back`
    : 'right on the route';
  const all = Object.keys(t).sort().map((key) =>
    `<div class="stop-tag"><span>${escapeHtml(key)}</span><span>${escapeHtml(String(t[key]))}</span></div>`).join('');
  return '<div class="road-card stop-card">'
    + `<div class="road-card-name">${escapeHtml(st.name)}</div>`
    + `<div class="road-card-meta">${after ? `Break after session ${after}` : `Break ${k + 1}`} · ${escapeHtml(detour)}</div>`
    + (rows.length ? `<dl class="stop-facts">${rows.map(([l, v]) => `<dt>${l}</dt><dd>${v}</dd>`).join('')}</dl>` : '')
    + '<div class="stop-links">'
    + link(googleMapsUrl(st), 'Google Maps')
    + (web ? ` · ${link(web, 'Website')}` : '')
    + ` · ${link(`https://www.openstreetmap.org/${stopRef(st)}`, 'OpenStreetMap')}`
    + '</div>'
    + `<details class="stop-all"><summary>All OSM tags (${Object.keys(t).length})</summary>${all}</details>`
    + `<button type="button" class="ghost stop-ban" data-ref="${escapeHtml(stopRef(st))}">Ban this restaurant</button>`
    + '</div>';
}

function drawStops(res) {
  if (state.stopLayer) { map.removeLayer(state.stopLayer); state.stopLayer = null; }
  const stops = res.stops || [];
  if (!stops.length) return;
  // Leaflet pans a card into view against the map's edges only, and the tool
  // bar floats over the top of the map: the card is kept clear of it too.
  const barBottom = $('topbar').getBoundingClientRect().bottom - mapEl.getBoundingClientRect().top;
  const clear = {
    autoPanPaddingTopLeft: L.point(16, Math.max(barBottom, 0) + 12),
    autoPanPaddingBottomRight: L.point(16, 16),
  };
  state.stopLayer = L.layerGroup(stops.map((st, k) => {
    const marker = L.marker([st.lat, st.lon], { icon: STOP_ICON, keyboard: true, title: st.name })
      .bindTooltip(escapeHtml(st.name), { direction: 'top', offset: [0, -14] })
      .bindPopup(stopCard(st, k), { className: 'road-popup', maxWidth: 300, minWidth: 250, ...clear });
    // Banning answers at once, like a coverage edit: the list takes it and the
    // route is worked out again without it, on the same piece of map.
    marker.on('popupopen', (ev) => {
      const button = ev.popup.getElement().querySelector('.stop-ban');
      if (button) button.onclick = () => {
        map.closePopup(ev.popup);
        banPlace(stopRef(st), st.name);
      };
    });
    return marker;
  })).addTo(map);
}

function clearRouteLayers() {
  if (state.stopLayer) { map.removeLayer(state.stopLayer); state.stopLayer = null; }
  for (const line of state.routeLayers) {
    if (line) map.removeLayer(line);
  }
  state.routeLayers = [];
  state.sessionPoints = [];
  state.detail.clear();
  state.pinned = null;
  state.shown = null;
}

function clearRoute() {
  clearRouteLayers();
  $('legend').innerHTML = '';
  $('legend').classList.add('hidden');
  state.result = null;
  syncRulesInfo();
  $('stats-card').classList.add('hidden');
  state.routeArrows = null;
  state.pickingRoad = false;
  state.fixModeOn = false;
  state.hoverRoad = null;
  /* The editor's own state outlives the result. The fixes are the user's
     corrections rather than part of the answer, and the selected street is
     where they are working - every recompute passes through here, and letting
     go of either would throw that away each time one was made. Only a new area
     drops them; see clearZones and applyShape. */
  hideRoadCard();
  for (const line of state.streetLayers) map.removeLayer(line);
  for (const line of state.focusLayers) map.removeLayer(line);
  state.streetLayers = [];
  state.focusLayers = [];
  buildRoadIndex();
  // Nothing to edit any more, so the tool goes with it.
  $('mode-select').classList.add('hidden');
  if (state.mode === 'select') setMode('pan');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
