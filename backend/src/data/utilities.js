// TerraTwin AI — Utility registry baseline.
// This file is intentionally EMPTY of fake records. The only utilities the
// system knows about are:
//   - engineer-registered / approved records (stored in the backend store)
//   - real OpenStreetMap underground pipes fetched live near an excavation
//     point and converted to scoring records by lib/liveUtilities.js
// BASE remains as a neutral default map-centre fallback, nothing more.

export const BASE = { lat: 10.12345, lng: 78.12345 };

export const UTILITIES = [];
