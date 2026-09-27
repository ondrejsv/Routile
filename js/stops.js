/* Where one session ends and the next begins, when that is more than a line
   drawn across the tour: a break at a restaurant, or a trip home.

   The coverage tour is settled before any of this. A break is a detour spliced
   into it - out from a node on the tour to the restaurant or home and back to
   the same node - so every street is still driven exactly as the solver
   planned, and the only cost is the detour itself. The session ends at the
   far end of the detour, and the next one starts from there.

   Where: the drive is cut evenly into as many sessions as the session length
   asks for, and each cut may slide within a window either side of its even
   point. Within the window the cheapest round trip wins - to the best of the
   nearest restaurants, or home - with a surcharge for a U-turn where the
   detour leaves or rejoins the tour and a small nudge towards the even point.

   Days: `perDay` sessions make one. The cuts inside a day are restaurant
   stops, the cut that ends it a trip home, or a plain cut without a home.
   The caller passes 1 when there are no restaurant breaks: every session is
   then a day of its own.

   A place is any {lat, lon, ...}; this module does not care what kind. Which
   places are candidates is the caller's business (see fetchPlaces() in
   osm.js), so the same code can later stop at a restaurant picked by rating. */

import { Dijkstra } from './graph.js';
import { circuitNodes } from './euler.js';

// Nearest graph node to each place within `snapM`, or -1. A flat-earth
// distance: at a few hundred metres the curvature is far below a lane.
function snapPlaces(g, places, snapM) {
  const out = [];
  for (const p of places) {
    const kx = 111320 * Math.cos(p.lat * Math.PI / 180), ky = 110540;
    let best = -1, bestD = snapM * snapM;
    for (let v = 0; v < g.N; v++) {
      const dx = (g.x[v] - p.lon) * kx, dy = (g.y[v] - p.lat) * ky;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = v; }
    }
    out.push({ place: p, node: best, snapM: Math.sqrt(bestD) });
  }
  return out.filter((s) => s.node >= 0);
}

/* The cuts for `circuit`, and the circuit with their detours spliced in.
   Returns { circuit, breaks, sessions, legs }: one break per cut, in tour
   order, each { position, kind, place, ... } where `position` is the index in
   the new circuit at which the session ends and the next begins, and `kind`
   is 'stop' (a restaurant), 'home' or 'cut' (nothing: the session just ends).

   `homeNode` >= 0 turns on trips home, and the whole drive then also starts
   and ends there: when home is not where the tour starts, the way out and the
   way back are added at the two ends, and `legs` says how long they are.

   A stop whose window had no restaurant in reach is a plain cut, flagged
   `missed`, so a missing restaurant never changes how many sessions there are. */
export function planStops(g, circuit, places, {
  sessionSeconds, perDay = 2, homeNode = -1, windowFraction, maxDetourS, snapM, candidates,
  uturnPenaltyS, offTargetWeight, scale,
}) {
  const m = circuit.length;
  const nodes = circuitNodes(g, circuit);
  const preSecs = new Float64Array(m + 1);
  for (let t = 0; t < m; t++) preSecs[t + 1] = preSecs[t] + g.travel[circuit[t]];
  const total = preSecs[m];
  const home = homeNode >= 0;

  // Home once, both ways, over the whole graph: a trip home is no detour a
  // cutoff should refuse, however far it is.
  const fromHome = new Dijkstra(g), toHome = new Dijkstra(g);
  if (home) {
    fromHome.search({ sources: [homeNode] });
    toHome.search({ sources: [homeNode], reverse: true });
  }
  const homeRoundTrip = (v) => (toHome.get(v) + fromHome.get(v)) / scale;

  // The way out to the tour and back from it, when home is not on it.
  const tourStart = nodes[0];
  const legOut = home && homeNode !== tourStart ? fromHome.pathArcs(tourStart) : [];
  const legBack = home && homeNode !== tourStart ? toHome.pathArcs(tourStart) : [];
  let legSecs = 0, legMetres = 0;
  for (const a of legOut.concat(legBack)) { legSecs += g.travel[a]; legMetres += g.length[a]; }
  const legs = { secs: Math.round(legSecs), metres: Math.round(legMetres) };

  /* How many sessions. Trips home take time out of every day but the tour's
     own ends, so with them the count is raised until the average session -
     coverage plus its share of the trips - fits the length again. The trip is
     estimated from a sample of the tour, since where the cuts land is not
     known until the count is. */
  const dayLength = Math.max(perDay, 1);
  let sessions = Math.max(Math.ceil(total / sessionSeconds - 1e-9), 1);
  if (home) {
    let sum = 0, n = 0;
    for (let i = 0; i <= m; i += Math.max(1, Math.floor(m / 60))) {
      const r = homeRoundTrip(nodes[i]);
      if (Number.isFinite(r)) { sum += r; n++; }
    }
    const roundTrip = n ? sum / n : 0;
    const fits = (s) => (total + legSecs + (Math.ceil(s / dayLength) - 1) * roundTrip) / s <= sessionSeconds;
    while (sessions < 200 && !fits(sessions)) sessions++;
  }
  if (m < 2 || sessions <= 1) {
    return { circuit: legOut.concat(circuit, legBack), breaks: [], sessions: 1, legs, prefix: legOut.length };
  }

  const snapped = snapPlaces(g, places, snapM);
  const out = new Dijkstra(g);   // restaurant -> tour, forward
  const back = new Dijkstra(g);  // tour -> restaurant, reverse
  const cutoff = maxDetourS * scale;
  const even = total / sessions;
  const halfWindow = even * windowFraction;

  const windowOf = (target) => {
    const positions = [];
    for (let i = 1; i < m; i++) if (Math.abs(preSecs[i] - target) <= halfWindow) positions.push(i);
    return positions;
  };
  const nearestPosition = (target) => {
    let best = 1;
    for (let i = 1; i < m; i++) {
      if (Math.abs(preSecs[i] - target) < Math.abs(preSecs[best] - target)) best = i;
    }
    return best;
  };
  // A U-turn where the detour leaves the tour at position i, or rejoins it.
  // `leave` is the detour's first arc, `rejoin` its last.
  const uturns = (i, leave, rejoin) => (leave >= 0 && g.reciprocal[leave] === circuit[i - 1] ? uturnPenaltyS : 0)
    + (rejoin >= 0 && g.reciprocal[rejoin] === circuit[i] ? uturnPenaltyS : 0);

  const chosen = [];
  for (let k = 1; k < sessions; k++) {
    const target = k * even;
    const endsDay = k % dayLength === 0;
    let best = null;

    if (!endsDay && snapped.length) {
      const positions = windowOf(target);
      // The restaurants nearest the window, as the crow flies, are the ones
      // worth two searches each.
      const midNode = positions.length ? nodes[positions[Math.floor(positions.length / 2)]] : -1;
      const near = midNode < 0 ? [] : snapped
        .map((s) => ({ s, d: Math.hypot(g.x[s.node] - g.x[midNode], g.y[s.node] - g.y[midNode]) }))
        .sort((a, b) => a.d - b.d).slice(0, candidates).map((x) => x.s);
      for (const s of near) {
        back.search({ sources: [s.node], reverse: true, cutoff });
        out.search({ sources: [s.node], cutoff });
        for (const i of positions) {
          const v = nodes[i];
          if (!back.has(v) || !out.has(v)) continue;
          let score = (back.get(v) + out.get(v)) / scale;
          if (score > maxDetourS) continue;
          // parent[v] is the detour's first arc in the reverse search and its
          // last in the forward one: the arcs either side of the tour at v.
          if (v !== s.node) score += uturns(i, back.parent[v], out.parent[v]);
          score += offTargetWeight * Math.abs(preSecs[i] - target);
          if (!best || score < best.score) best = { score, i, kind: 'stop', s };
        }
      }
    } else if (endsDay && home) {
      // Home from wherever in the window it is nearest.
      for (const i of windowOf(target)) {
        const v = nodes[i];
        let score = homeRoundTrip(v);
        if (!Number.isFinite(score)) continue;
        if (v !== homeNode) score += uturns(i, toHome.parent[v], fromHome.parent[v]);
        score += offTargetWeight * Math.abs(preSecs[i] - target);
        if (!best || score < best.score) best = { score, i, kind: 'home' };
      }
    }
    // Nothing wanted here, or nothing in reach: a plain cut at the even split.
    chosen.push(best ? { ...best, target, k }
      : { i: nearestPosition(target), kind: 'cut', target, k, missed: !endsDay });
  }

  // Splice, last first, so earlier positions stay where they were.
  let next = circuit.slice();
  const inserted = [];
  for (const c of [...chosen].sort((a, b) => b.i - a.i || b.k - a.k)) {
    const v = nodes[c.i];
    let there = [], again = [];
    if (c.kind === 'stop' && v !== c.s.node) {
      back.search({ sources: [c.s.node], reverse: true, cutoff });
      out.search({ sources: [c.s.node], cutoff });
      there = back.pathArcs(v);      // tour -> restaurant
      again = out.pathArcs(v);       // restaurant -> tour
    } else if (c.kind === 'home' && v !== homeNode) {
      there = toHome.pathArcs(v);    // tour -> home
      again = fromHome.pathArcs(v);  // home -> tour
    }
    next = next.slice(0, c.i).concat(there, again, next.slice(c.i));
    let secs = 0, metres = 0;
    for (const a of there.concat(again)) { secs += g.travel[a]; metres += g.length[a]; }
    inserted.push({ c, there: there.length, again: again.length, secs, metres });
  }

  // Positions in the finished circuit: each detour pushes every later one on,
  // and so does the way out from home at the very start.
  inserted.sort((a, b) => a.c.i - b.c.i || a.c.k - b.c.k);
  let shift = legOut.length;
  const breaks = inserted.map(({ c, there, again, secs, metres }) => {
    const position = c.i + shift + there;
    shift += there + again;
    return {
      position, kind: c.kind, place: c.kind === 'stop' ? c.s.place : null,
      node: c.kind === 'stop' ? c.s.node : c.kind === 'home' ? homeNode : nodes[c.i],
      snap_m: c.kind === 'stop' ? Math.round(c.s.snapM) : 0, missed: !!c.missed,
      detour_s: Math.round(secs), detour_m: Math.round(metres), target_s: Math.round(c.target),
    };
  });
  return { circuit: legOut.concat(next, legBack), breaks, sessions, legs, prefix: legOut.length };
}
