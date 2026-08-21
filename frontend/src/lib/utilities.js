// TerraTwin AI — Utility registry baseline (frontend mirror).
// Intentionally EMPTY of fake records. Utilities come from:
//   - engineer-registered records served by the backend /api/utilities
//   - real OpenStreetMap pipes fetched near the excavation point and
//     converted to scoring records by lib/osmUtils.js
// BASE is only a neutral default map-centre fallback.

export const BASE = { lat: 10.12345, lng: 78.12345 };

export const UTILITIES = [];
