// Restaurant Tracker updater: everything that doesn't touch Bluetooth or the page, so it can be
// tested in Node (../tests/updater_test.js). The region file layout must match
// ../wokwi-sim/region_file.h.
(function (exports) {
  'use strict';

  const TACO_BELL_WIKIDATA = 'Q752941';
  const HEADER_BYTES = 20;
  const MAX_LABEL = 47;  // the device keeps 48 bytes per label, including the NUL

  const STREET_ABBREV = {
    Boulevard: 'Blvd', Avenue: 'Ave', Street: 'St', Road: 'Rd', Drive: 'Dr', Parkway: 'Pkwy',
    Highway: 'Hwy', Lane: 'Ln', Center: 'Ctr', North: 'N', South: 'S', East: 'E', West: 'W',
  };

  // The display font only has plain ASCII: drop accents, replace anything else with '?'.
  function ascii(s) {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '?');
  }

  // "Hanover St, Boston" from OpenStreetMap address tags (same rules as tools/fetch_stores.py).
  function shortLabel(tags) {
    const street = (tags['addr:street'] || '').split(/\s+/).filter(Boolean)
      .map((w) => STREET_ABBREV[w] || w).join(' ');
    const city = tags['addr:city'] || '';
    const label = street && city ? `${street}, ${city}` : street || city || 'Taco Bell';
    return ascii(label).slice(0, MAX_LABEL);
  }

  // CRC-32 (IEEE), same as region::crc32 on the device.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // Overpass query for several regions at once. Each region's area is printed as a marker before
  // its stores, so one response can be split back into regions (even ones with no stores).
  function overpassQuery(codes) {
    const areas = codes.map((c) => c.includes('-')
      ? `area["ISO3166-2"="${c}"][admin_level=4];`
      : `area["ISO3166-1"="${c}"][admin_level=2];`).join('');
    return `[out:json][timeout:600];(${areas})->.regions;` +
      `foreach.regions->.r(.r out tags;nwr["brand:wikidata"="${TACO_BELL_WIKIDATA}"](area.r);out center tags;);`;
  }

  // Overpass JSON -> { code: [{lat, lon, label}] } for the requested codes. A region that appears
  // with no stores maps to []; a region missing from the response is left out.
  function splitRegions(json, codes) {
    const wanted = new Set(codes);
    const out = {};
    const seen = {};
    let current = null;
    for (const el of json.elements || []) {
      if (el.type === 'area') {
        const t = el.tags || {};
        current = wanted.has(t['ISO3166-2']) ? t['ISO3166-2'] : wanted.has(t['ISO3166-1']) ? t['ISO3166-1'] : null;
        if (current && !out[current]) { out[current] = []; seen[current] = new Set(); }
        continue;
      }
      if (!current) continue;
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      const key = `${el.type}/${el.id}`;
      if (lat == null || lon == null || seen[current].has(key)) continue;  // an area can repeat
      seen[current].add(key);
      out[current].push({ lat, lon, label: shortLabel(el.tags || {}) });
    }
    return out;
  }

  // One region's stores -> the binary file the device stores as /r/<code>.
  function buildRegionFile(code, stores, fetchedUnix) {
    if (stores.length > 65535) throw new Error(`${code}: too many stores`);
    const enc = new TextEncoder();
    const labels = stores.map((s) => enc.encode(s.label + '\0'));
    const labelBytes = labels.reduce((n, l) => n + l.length, 0);
    if (labelBytes > 65535) throw new Error(`${code}: labels too long`);
    const n = stores.length;
    const buf = new Uint8Array(HEADER_BYTES + n * 8 + n * 2 + labelBytes);
    const dv = new DataView(buf.buffer);
    buf.set(enc.encode('TBR1'), 0);
    buf.set(enc.encode(code), 4);  // NUL-padded to 8 bytes by the zeroed buffer
    dv.setUint32(12, fetchedUnix, true);
    dv.setUint16(16, n, true);
    dv.setUint16(18, labelBytes, true);
    let p = HEADER_BYTES;
    for (const s of stores) {
      dv.setInt32(p, Math.round(s.lat * 1e6), true);
      dv.setInt32(p + 4, Math.round(s.lon * 1e6), true);
      p += 8;
    }
    let off = 0;
    for (const l of labels) { dv.setUint16(p, off, true); p += 2; off += l.length; }
    for (const l of labels) { buf.set(l, p); p += l.length; }
    return buf;
  }

  // Device "LIST" reply lines ("R US-MA,56,1759190400 CA,412,1759190400") -> { code: {count, fetched} }.
  function parseInventory(lines) {
    const inv = {};
    for (const line of lines) {
      if (!line.startsWith('R ')) continue;
      for (const item of line.slice(2).trim().split(/\s+/)) {
        const [code, count, fetched] = item.split(',');
        if (code) inv[code] = { count: +count, fetched: +fetched };
      }
    }
    return inv;
  }

  // Which regions to download for a choice ("WORLD", "US", a state "US-MA" or a country "CA").
  function regionsFor(choice, catalog) {
    const states = catalog.states.map((s) => s.code);
    if (choice === 'WORLD') return [...states, ...catalog.countries.map((c) => c.code)];
    if (choice === 'US') return states;
    return [choice];
  }

  // Split a choice into what must be sent and what the device already has.
  function plan(choice, catalog, inventory, redownload) {
    const all = regionsFor(choice, catalog);
    const skip = redownload ? [] : all.filter((c) => inventory[c]);
    const send = all.filter((c) => !skip.includes(c));
    return { send, skip };
  }

  Object.assign(exports, {
    TACO_BELL_WIKIDATA, shortLabel, ascii, crc32, overpassQuery, splitRegions, buildRegionFile,
    parseInventory, regionsFor, plan,
  });
})(typeof module !== 'undefined' ? module.exports : (window.Core = {}));
