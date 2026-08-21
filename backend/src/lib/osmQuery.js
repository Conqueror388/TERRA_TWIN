// Shared OpenStreetMap Overpass client.
// Used by the map layer (/api/osm) and by the risk engine's live-utility
// source (lib/liveUtilities.js → /api/excavations/analyze, /api/devices/gps),
// so real underground pipe data is scored exactly where it is drawn.

const CACHE     = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 min

// ── Tag → type mapping ────────────────────────────────────────────────────────
const SUBSTANCE_TYPE = {
  water: 'water', drinking_water: 'water', potable_water: 'water',
  gas: 'gas', natural_gas: 'gas', lpg: 'gas', oil: 'gas', fuel: 'gas',
  sewage: 'sewer', sewer: 'sewer', wastewater: 'sewer',
  electricity: 'electric', power: 'electric',
  telecom: 'fiber', telephone: 'fiber', internet: 'fiber', fiber: 'fiber',
  cable: 'fiber', broadband: 'fiber',
};

export const COLOR = {
  water: '#29B6D8', gas: '#F5A623', sewer: '#8D6E3B',
  electric: '#FFE066', fiber: '#B58CFF', unknown: '#9E9E9E',
  corridor: '#4A6080',
};

export function guessType(tags) {
  const sub = (tags.substance || tags.pipeline || tags.utility || '').toLowerCase();
  if (SUBSTANCE_TYPE[sub]) return SUBSTANCE_TYPE[sub];
  if (tags.power === 'cable' || tags.power === 'minor_cable') return 'electric';
  if (tags.telecom || tags['communication:telephone'] === 'yes') return 'fiber';
  const name = (tags.name || tags.description || '').toLowerCase();
  if (name.includes('water'))  return 'water';
  if (name.includes('gas'))    return 'gas';
  if (name.includes('sewer') || name.includes('drain')) return 'sewer';
  if (name.includes('fiber') || name.includes('telecom')) return 'fiber';
  if (name.includes('electric') || name.includes('power')) return 'electric';
  return 'unknown';
}

async function overpassFetch(query, timeoutMs = 32000) {
  const resp = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'http://localhost:5173/',
    },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`Overpass ${resp.status}`);
  return resp.json();
}

// Fetch real underground pipe/cable features (plus a road-corridor fallback
// where OSM utility tagging is sparse). Returns features shaped like:
//   { id, osmId, type, color, coordinates:[[lat,lng],...], tags, source,
//     verified:false, name, depth }
export async function fetchOsmFeatures(lat, lng, radius = 3000) {
  const key    = `${lat.toFixed(3)},${lng.toFixed(3)},${radius}`;
  const cached = CACHE.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  // Step 1: actual underground pipes / cables
  const pipeQuery = `
[out:json][timeout:30];
(
  way["man_made"="pipeline"](around:${radius},${lat},${lng});
  way["power"="cable"](around:${radius},${lat},${lng});
  way["power"="minor_cable"](around:${radius},${lat},${lng});
  way["pipeline"](around:${radius},${lat},${lng});
  way["utility"="gas"](around:${radius},${lat},${lng});
  way["utility"="water"](around:${radius},${lat},${lng});
  way["utility"="telecom"](around:${radius},${lat},${lng});
  way["utility"="electrical"](around:${radius},${lat},${lng});
  way["communication:telephone"="yes"](around:${radius},${lat},${lng});
  way["telecom"](around:${radius},${lat},${lng});
  way["railway"="subway"]["location"="underground"](around:${radius},${lat},${lng});
);
out geom;`.trim();

  const pipeData = await overpassFetch(pipeQuery);
  const pipes = (pipeData.elements || [])
    .filter((el) => el.type === 'way' && el.geometry?.length >= 2)
    .map((el) => {
      const type = guessType(el.tags || {});
      return {
        id: `osm-${el.id}`,
        osmId: el.id,
        type,
        color: COLOR[type] || COLOR.unknown,
        coordinates: el.geometry.map((pt) => [pt.lat, pt.lon]),
        tags: el.tags || {},
        source: 'osm',
        verified: false,
        name: el.tags?.name || null,
        depth: parseFloat(el.tags?.depth || el.tags?.['buried:depth'] || 0) || null,
      };
    });

  // Step 2: road-corridor fallback when no pipe data exists
  // (very common in India — utilities always run alongside roads)
  let corridors = [];
  if (pipes.length < 3) {
    const roadQuery = `
[out:json][timeout:25];
(
  way["highway"~"primary|secondary|tertiary|trunk|motorway"](around:${radius},${lat},${lng});
);
out geom;`.trim();

    try {
      const roadData  = await overpassFetch(roadQuery, 28000);
      corridors = (roadData.elements || [])
        .filter((el) => el.type === 'way' && el.geometry?.length >= 2)
        .filter((el) => el.geometry.length > 4)
        .slice(0, 40)
        .map((el) => ({
          id: `corridor-${el.id}`,
          osmId: el.id,
          type: 'corridor',
          color: COLOR.corridor,
          coordinates: el.geometry.map((pt) => [pt.lat, pt.lon]),
          tags: el.tags || {},
          source: 'road_corridor',
          verified: false,
          name: el.tags?.name || el.tags?.['name:en'] || 'Unnamed road',
          depth: null,
          roadType: el.tags?.highway,
        }));
    } catch (_) { /* road fetch failed — silently skip */ }
  }

  const features = [...pipes, ...corridors];
  CACHE.set(key, { ts: Date.now(), data: features });
  return features;
}
