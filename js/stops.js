/* Sessions joined by a stop: a break at a restaurant between one drive and the
   next, the drive ending there and the next one starting from it.

   The coverage tour is settled before any of this. A stop is a detour spliced
   into it - out from a node on the tour to the restaurant and back to the same
   node - so every street is still driven exactly as the solver planned, and
   the only cost is the detour itself.

   Where: the drive is cut evenly into as many sessions as the session length
   asks for, and each cut may slide within a window either side of its even
   point. Within the window, the pair of (tour node, restaurant) with the
   cheapest round trip wins, with a surcharge for a U-turn where the detour
   leaves or rejoins the tour and a small nudge towards the even point.

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

/* Where each session ends, and the circuit with the stops' detours spliced in.
   Returns { circuit, breaks, sessions }: one break per cut between sessions,
   in tour order, each { position, place, ... } where `position` is the index
   in the new circuit at which the session ends and the next begins.

   `perDay` sessions make a day. Cuts inside a day are stops at a restaurant;
   the cut that ends a day is a plain one, at the even split, with `place`
   null - as is a stop whose window had no restaurant in reach, so a missing
   restaurant never changes how many sessions there are. */
export function planStops(g, circuit, places, {
  sessionSeconds, perDay = 2, windowFraction, maxDetourS, snapM, candidates, uturnPenaltyS,
  offTargetWeight, scale,
}) {
  const m = circuit.length;
  const nodes = circuitNodes(g, circuit);
  const preSecs = new Float64Array(m + 1);
  for (let t = 0; t < m; t++) preSecs[t + 1] = preSecs[t] + g.travel[circuit[t]];
  const total = preSecs[m];
  const sessions = Math.ceil(total / sessionSeconds - 1e-9);
  if (sessions <= 1 || m < 2) return { circuit, breaks: [], sessions: 1 };

  const snapped = snapPlaces(g, places, snapM);
  const out = new Dijkstra(g);   // restaurant -> tour, forward
  const back = new Dijkstra(g);  // tour -> restaurant, reverse
  const cutoff = maxDetourS * scale;
  const even = total / sessions;
  const halfWindow = even * windowFraction;

  // The tour position closest to a time, never the very start or finish.
  const nearestPosition = (target) => {
    let best = 1;
    for (let i = 1; i < m; i++) {
      if (Math.abs(preSecs[i] - target) < Math.abs(preSecs[best] - target)) best = i;
    }
    return best;
  };

  const chosen = [];
  for (let k = 1; k < sessions; k++) {
    const target = k * even;
    const wantsStop = k % perDay !== 0;
    let best = null;
    if (wantsStop && snapped.length) {
      // Tour positions inside the window. Not the very ends of the tour: a
      // stop at the start or the finish is not a break between two drives.
      const positions = [];
      for (let i = 1; i < m; i++) {
        if (Math.abs(preSecs[i] - target) <= halfWindow) positions.push(i);
      }
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
          if (v !== s.node) {
            const leave = back.parent[v], rejoin = out.parent[v];
            if (leave >= 0 && g.reciprocal[leave] === circuit[i - 1]) score += uturnPenaltyS;
            if (rejoin >= 0 && g.reciprocal[rejoin] === circuit[i]) score += uturnPenaltyS;
          }
          score += offTargetWeight * Math.abs(preSecs[i] - target);
          if (!best || score < best.score) best = { score, i, s };
        }
      }
    }
    // No restaurant wanted here, or none in reach: a plain cut at the even split.
    chosen.push(best ? { ...best, target, k } : { i: nearestPosition(target), s: null, target, k, wanted: wantsStop });
  }

  // Splice, last first, so earlier positions stay where they were.
  let next = circuit.slice();
  const inserted = [];
  for (const c of [...chosen].sort((a, b) => b.i - a.i || b.k - a.k)) {
    let there = [], home = [];
    if (c.s && nodes[c.i] !== c.s.node) {
      back.search({ sources: [c.s.node], reverse: true, cutoff });
      out.search({ sources: [c.s.node], cutoff });
      there = back.pathArcs(nodes[c.i]);    // tour -> restaurant
      home = out.pathArcs(nodes[c.i]);      // restaurant -> tour
    }
    next = next.slice(0, c.i).concat(there, home, next.slice(c.i));
    let secs = 0, metres = 0;
    for (const a of there.concat(home)) { secs += g.travel[a]; metres += g.length[a]; }
    inserted.push({ c, there: there.length, home: home.length, secs, metres });
  }

  // Positions in the finished circuit: each detour pushes every later one on.
  inserted.sort((a, b) => a.c.i - b.c.i || a.c.k - b.c.k);
  let shift = 0;
  const breaks = inserted.map(({ c, there, home, secs, metres }) => {
    const position = c.i + shift + there;
    shift += there + home;
    return {
      position, place: c.s ? c.s.place : null, node: c.s ? c.s.node : nodes[c.i],
      snap_m: c.s ? Math.round(c.s.snapM) : 0, missed: !c.s && !!c.wanted,
      detour_s: Math.round(secs), detour_m: Math.round(metres), target_s: Math.round(c.target),
    };
  });
  return { circuit: next, breaks, sessions };
}
