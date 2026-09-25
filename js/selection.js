/* Which of the downloaded roads the drive must cover, beyond lying in a zone.

   The zones say where; these rules say what. An ordered list, each rule adding
   ways to the selection or removing them from it, the way a drawn zone adds to
   the area and Subtract crops it back:

     { op: 'add' | 'remove', kind: 'tags' | 'overpass', text }

   `tags` is an Overpass tag filter, ["operator"="..."][highway~"^(primary|secondary)$"],
   read here against each way's tags - no second download. `overpass` is a query
   of the user's own, run against the same box as the roads; the ways it returns
   (and the way members of any relations it returns) are the rule's set.

   With no rules the selection is everything, which is the page as it always
   was. The first rule decides where the list starts: an add starts from
   nothing, a remove from everything - so a single "remove motorways" means what
   it says, and a single "add operator=X" does too.

   A road outside the selection is not a connector. A connector is a doubtful
   road, priced so the route avoids it; an unselected one is a perfectly good
   street that simply need not be covered, and the drive between two selected
   streets should use it freely. It is marked `optional` instead. */

export const RULE_OPS = ['add', 'remove'];
export const RULE_KINDS = ['tags', 'overpass'];

// A typo guard, not a capability limit. Each Overpass rule is a request to a
// free shared service, so they are the ones worth capping.
export const MAX_RULES = 20;
export const MAX_QUERY_RULES = 5;
const MAX_TEXT = 4000;

export class SelectionError extends Error {}

/* ------------------------------------------------------------- tag filters */
/* The Overpass tag-filter clauses, which is what anyone who knows OSM will type:

     [key]  [!key]  [key=value]  [key!=value]  [key~regex]  [key!~regex]
     [key~regex,i]

   Keys and values quoted or bare. Clauses in a row must all hold. Negations hold
   for a way without the key, as in Overpass. A leading `way` is allowed so a
   filter can be pasted straight out of a query. */
export function parseTagFilter(text) {
  const src = String(text ?? '').trim().replace(/^(way|nwr)\b/, '').trim();
  if (!src) throw new SelectionError('a tag filter is empty');
  const clauses = [];
  let i = 0;
  const fail = (what) => {
    throw new SelectionError(`tag filter "${text}": ${what} at character ${i + 1}`);
  };
  const skip = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const token = () => {
    skip();
    const q = src[i];
    if (q === '"' || q === "'") {
      let out = '';
      for (i++; i < src.length && src[i] !== q; i++) {
        if (src[i] === '\\' && i + 1 < src.length) i++;
        out += src[i];
      }
      if (src[i] !== q) fail('unterminated quote');
      i++;
      return out;
    }
    const m = /^[^\s\[\]=!~,"']+/.exec(src.slice(i));
    if (!m) fail('expected a key or a value');
    i += m[0].length;
    return m[0];
  };

  while (true) {
    skip();
    if (i >= src.length) break;
    if (src[i] !== '[') fail("expected '['");
    i++;
    skip();
    let clause;
    if (src[i] === '!') {
      i++;
      clause = { key: token(), op: 'absent' };
    } else {
      if (src[i] === '~') fail('key regexes are not supported');
      const key = token();
      skip();
      const op = /^(!~|!=|=|~)/.exec(src.slice(i));
      if (!op) {
        clause = { key, op: 'present' };
      } else {
        i += op[0].length;
        const value = token();
        skip();
        let flags = '';
        if (src[i] === ',') {
          i++; skip();
          if (src[i] !== 'i') fail("expected 'i' after the comma");
          i++; flags = 'i';
        }
        clause = { key, op: op[0], value };
        if (op[0] === '~' || op[0] === '!~') {
          try {
            clause.re = new RegExp(value, flags);
          } catch (err) {
            throw new SelectionError(`tag filter "${text}": ${err.message}`);
          }
        } else if (flags) {
          fail("',i' only applies to a regex");
        }
      }
    }
    skip();
    if (src[i] !== ']') fail("expected ']'");
    i++;
    clauses.push(clause);
  }
  if (!clauses.length) throw new SelectionError(`tag filter "${text}" has no clauses`);
  return clauses;
}

export function matchesTags(clauses, tags) {
  for (const c of clauses) {
    const has = Object.prototype.hasOwnProperty.call(tags, c.key);
    const v = has ? String(tags[c.key]) : null;
    switch (c.op) {
      case 'present': if (!has) return false; break;
      case 'absent': if (has) return false; break;
      case '=': if (v !== c.value) return false; break;
      case '!=': if (v === c.value) return false; break;
      case '~': if (!has || !c.re.test(v)) return false; break;
      case '!~': if (has && c.re.test(v)) return false; break;
      default: return false;
    }
  }
  return true;
}

/* A tag filter pasted where a query belongs. Overpass rejects it with a wall of
   parser errors about an unknown type "[", which says nothing about the fix, so
   it is caught first and named. A settings line - [out:json][timeout:120]; -
   ends with a semicolon, so it never parses as a filter and is not caught. */
export function looksLikeTagFilter(text) {
  try {
    parseTagFilter(String(text).trim().replace(/;\s*$/, ''));
    return !/^\s*(way|nwr)\b/.test(String(text));
  } catch (err) {
    return false;
  }
}

export const TAG_FILTER_AS_QUERY = 'this is a tag filter, not an Overpass query - '
  + 'add it with + Tag filter instead, or make it a query by starting it with way, as in way[...];';

/* ---------------------------------------------------------- the rule list */
// Validate the UI's rules, with messages a user can act on. Tag filters are
// parsed here too, so a typo fails the request before anything is downloaded.
export function parseRules(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new SelectionError('the road selection is malformed');
  const rules = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') throw new SelectionError('a selection rule is malformed');
    const text = String(r.text ?? '').trim();
    if (!text) continue;                        // an empty row says nothing
    if (!RULE_OPS.includes(r.op)) throw new SelectionError(`'${r.op}' is not a selection operation`);
    if (!RULE_KINDS.includes(r.kind)) throw new SelectionError(`'${r.kind}' is not a kind of selection rule`);
    if (text.length > MAX_TEXT) throw new SelectionError(`a selection rule is over ${MAX_TEXT} characters`);
    const rule = { op: r.op, kind: r.kind, text };
    if (r.kind === 'tags') rule.clauses = parseTagFilter(text);
    else if (looksLikeTagFilter(text)) {
      throw new SelectionError(`selection rule ${rules.length + 1}: ${TAG_FILTER_AS_QUERY}`);
    }
    rules.push(rule);
  }
  if (rules.length > MAX_RULES) throw new SelectionError(`at most ${MAX_RULES} selection rules`);
  if (rules.filter((r) => r.kind === 'overpass').length > MAX_QUERY_RULES) {
    throw new SelectionError(`at most ${MAX_QUERY_RULES} Overpass queries - each is a request to a free shared service`);
  }
  return rules;
}

// What identifies the rules for the result cache: the parsed clauses are
// derived, the text is the rule.
export const rulesKey = (rules) => rules.map((r) => `${r.op}:${r.kind}:${r.text}`);

export const rulesToJSON = (rules) => rules.map(({ op, kind, text }) => ({ op, kind, text }));

/* ------------------------------------------------------- Overpass queries */
/* overpass-turbo's {{geocodeArea:name}}, which is how a query names a borough
   without knowing its relation id. Turbo asks Nominatim and writes in the area
   id, a relation's id plus 3600000000 (a closed way's plus 2400000000); this
   does the same, with the lookup passed in so the network stays in osm.js. */
const GEOCODE_AREA = /\{\{\s*geocodeArea\s*:\s*([^}]*?)\s*\}\}/g;

export const geocodeAreaNames = (text) =>
  [...new Set([...String(text).matchAll(GEOCODE_AREA)].map((m) => m[1]))];

// `found` maps each name to {osm_type, osm_id}, as Nominatim gives them.
export function fillGeocodeAreas(text, found) {
  return String(text).replace(GEOCODE_AREA, (all, name) => {
    const hit = found.get(name);
    if (!hit) throw new SelectionError(`Nominatim found no place called "${name}"`);
    const id = Number(hit.osm_id);
    if (hit.osm_type === 'relation') return `area(id:${3600000000 + id})`;
    if (hit.osm_type === 'way') return `area(id:${2400000000 + id})`;
    throw new SelectionError(`"${name}" is a point in Nominatim, not an area`);
  });
}

/* The user's query made safe to send: JSON out, and an output statement if it
   has none. Without a settings line of its own it also gets the road box as its
   bounding box, so a bare `way["operator"="X"];` stays local; one that brings
   its own settings is taken at its word, which is the way out for a query the
   global box gets in the way of. overpass-turbo's {{bbox}} is filled in, and
   {{geocodeArea}} must have been by fillGeocodeAreas(); its other shortcuts
   need its own server. */
export function selectionQuery(text, box, timeoutS) {
  const bbox = `${box.bottom},${box.left},${box.top},${box.right}`;
  let q = String(text).trim().replace(/\{\{\s*bbox\s*\}\}/g, bbox);
  const shortcut = /\{\{[^}]*\}\}/.exec(q);
  if (shortcut) {
    throw new SelectionError(`${shortcut[0]} is an overpass-turbo shortcut this page cannot fill in - only {{bbox}} and {{geocodeArea:...}} are`);
  }

  let settings = `[out:json][timeout:${timeoutS}][bbox:${bbox}]`;
  const head = /^((?:\[[^\]]*\]\s*)+);/.exec(q);
  if (head) {
    settings = head[1].replace(/\[\s*out\s*:[^\]]*\]/g, '').trim();
    if (!/\[\s*timeout\s*:/.test(settings)) settings += `[timeout:${timeoutS}]`;
    settings = `[out:json]${settings}`;
    q = q.slice(head[0].length).trim();
  }
  if (!q) throw new SelectionError('an Overpass query is empty');
  if (!/;\s*$/.test(q)) q += ';';
  // Members too, so a query for route relations selects the roads on them.
  if (!/(^|[;)}])\s*(\.\w+\s+)?out\b/.test(q)) q += '(._;way(r););out ids;';
  return `${settings};${q}`;
}

// The ways an Overpass answer names, as id strings.
export function waysOf(elements) {
  const ids = new Set();
  for (const el of elements || []) {
    if (el.type === 'way') ids.add(String(el.id));
    else if (el.type === 'relation' && Array.isArray(el.members)) {
      for (const m of el.members) if (m.type === 'way') ids.add(String(m.ref));
    }
  }
  return ids;
}

/* ------------------------------------------------------------ evaluation */
/* The selected way ids, or null when there are no rules and everything is.
   `ways` is the downloaded ways; `querySets[i]` the ids rule i's query returned.

   Returns per-rule counts alongside, because a rule that matched nothing is the
   likeliest thing to go wrong - a misspelt operator, a query for roads the
   download never had - and it should be said rather than discovered. */
export function selectWays(rules, ways, querySets = []) {
  if (!rules.length) return { selected: null, stats: [] };
  const downloaded = new Set(ways.map((w) => String(w.id)));
  const selected = new Set(rules[0].op === 'remove' ? downloaded : []);
  const stats = [];
  rules.forEach((rule, i) => {
    let hits;
    let missing = 0;
    if (rule.kind === 'tags') {
      hits = ways.filter((w) => matchesTags(rule.clauses, w.tags || {})).map((w) => String(w.id));
    } else {
      hits = [];
      for (const id of querySets[i] || []) {
        if (downloaded.has(id)) hits.push(id); else missing++;
      }
    }
    for (const id of hits) {
      if (rule.op === 'add') selected.add(id); else selected.delete(id);
    }
    stats.push({ op: rule.op, kind: rule.kind, text: rule.text, matched: hits.length, missing });
  });
  return { selected, stats };
}
