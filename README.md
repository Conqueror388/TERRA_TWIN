# TerraTwin AI (GhostNet) — DigSafe Excavation Platform

A locate-request-gated excavation safety workflow, not an underground
scanner. GPS-based positioning, simulated + worker-reported utility
records, a **deterministic** risk engine, and an 811/one-call locate
request that actually gates when digging is allowed to start — plus worker
discovery reports with photo upload, engineer review/approval, and an AI
assistant that explains results without ever overriding them.

> **Prototype note:** underground utility data is simulated. GPS does not
> detect buried pipes or cables. Real excavation safety comes from calling
> 811/one-call before digging and getting utilities marked — TerraTwin's
> job is to make sure that step never gets skipped, not to replace it. See
> `KEY TECHNICAL PRINCIPLES` in the original implementation plan.

```
terratwin-ai/
├── frontend/   React + Vite + Tailwind + Leaflet + React Three Fiber
└── backend/    Express + (optional) Firebase Admin + (optional) Gemini
```

## Quick start

Two terminals, both from inside `terratwin-ai/`:

```bash
# Terminal 1 — backend (http://localhost:4000)
cd backend
cp .env.example .env      # optional — works with no keys set at all
npm install
npm run dev

# Terminal 2 — frontend (http://localhost:5173)
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api/*` and
`/uploads/*` to the backend on port 4000 (see `frontend/vite.config.js`).

**Sign-in is required.** Use "Create account" on the login screen and pick a
role — Worker or Engineer. Create at least one of each to see the full demo
flow (a worker can't approve their own discovery reports; that's enforced
server-side, not just hidden in the UI). Accounts persist only in memory
unless Firestore is configured, so they reset when the backend restarts.

The frontend's Excavation Planner still falls back to computing the DigSafe
score locally with the same risk-engine module if the backend is down, so
the map/planner/twin stay usable standalone — but starting an excavation,
submitting a discovery report, and everything in the Engineer Dashboard all
need the backend up and a valid login.

## What's real vs. stubbed

| Piece | Status |
|---|---|
| DigSafe deterministic risk engine | **Real**, identical logic on frontend and backend (`lib/riskEngine.js`) |
| Simulated utility registry (3 records) | Real data, intentionally fake per the prototype note |
| Leaflet map, click-to-place excavation point | Real |
| 3D digital twin (React Three Fiber) | Real — orbit-controllable cross-section |
| Recommendation engine (shift/depth alternatives) | Real |
| Excavation live-monitoring, discovery reports | Real API + storage; swap in Firestore by setting env vars, no route changes needed |
| Discovery report photo upload | Real — multer-backed upload to `backend/uploads/`, served at `/uploads/<file>` |
| Engineer approval workflow | Real — AI verify → approve/reject → writes into the utility registry → risk engine/Digital Twin pick it up immediately |
| Authentication + roles | Real — email/password + JWT, bcrypt-hashed passwords, `worker`/`engineer` roles enforced server-side (not just hidden nav links) |
| Analytics / Overview stats | Real — aggregated from actual `/analyze` calls, excavations, and discovery reports, not mock arrays |
| Firebase Firestore | Optional — set `FIREBASE_SERVICE_ACCOUNT` or `GOOGLE_APPLICATION_CREDENTIALS` in `backend/.env`, otherwise falls back to in-memory storage automatically. Setup steps: `backend/CREDENTIALS.md` |
| Gemini AI assistant + discovery verification | Optional — set `GEMINI_API_KEY` in `backend/.env`, otherwise returns a canned but numerically-accurate fallback explanation (clearly labeled in the UI either way). Setup steps: `backend/CREDENTIALS.md` |
| ESP32 + NEO-6M GPS hardware | Not included — see `hardware/` and Phase 9/10 of the original plan; `/api/devices` is the endpoint the device would hit |

## Risk engine (the part that actually decides things)

`lib/riskEngine.js`, ported identically to both frontend and backend.

- **Depth conflict** (40%): `100 - |excavationDepth - utilityDepth| × 100`, clamped 0–100
- **Horizontal distance** (30%): decays to 0 risk at a 15 m "danger radius"
- **Utility criticality** (20%): fixed per type (electric 70, water 60, fiber 50 — tune in `data/utilities.js`)
- **Data confidence** (10%): `100 - confidence%`

`DigSafe score = 100 - weighted risk`, and the *overall* score for a plan is
the **minimum** across all nearby utilities (most conservative). Bands:
LOW ≥75, MEDIUM ≥55, HIGH ≥35, CRITICAL below that.

Gemini is only ever given these numbers to explain — it has no path to
change the score, and every AI-sourced response is labeled in the UI as
either "gemini" or "fallback" so it's never ambiguous which one answered.

## Roles

| | Worker | Engineer |
|---|---|---|
| Plan/analyze excavations | ✅ | ✅ |
| Start live excavations | ✅ | ✅ |
| Submit discovery reports | ✅ | ✅ |
| Run AI verification on a report | ❌ | ✅ |
| Approve/reject a discovery report | ❌ | ✅ |
| View Engineer Dashboard | ❌ | ✅ |
| View Analytics / Overview | ✅ | ✅ |

Role checks are enforced in `backend/src/lib/auth.js` (`requireAuth`,
`requireRole`) on the actual routes, not just in the frontend's nav/routing.

## API reference

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/health` | GET | — | Liveness check |
| `/api/auth/register` | POST | — | `{name, email, password, role}` → `{token, user}` |
| `/api/auth/login` | POST | — | `{email, password}` → `{token, user}` |
| `/api/auth/me` | GET | any | Validate the current token |
| `/api/utilities` | GET | — | Simulated + engineer-approved utility registry + base coordinate |
| `/api/excavations/analyze` | POST | — | `{latitude, longitude, depth, width, length, purpose}` → DigSafe score, breakdown, recommendations (also logged for Analytics) |
| `/api/excavations` | GET / POST | POST: any | List / start live excavation records (worker auto-attributed from token). **POST is gated**: rejects with `403 LOCATE_REQUEST_REQUIRED` unless a nearby locate request is `CONFIRMED` or `OVERRIDDEN` — see `/api/locate-requests` below |
| `/api/locate-requests` | GET / POST | POST: any | List / draft an 811-style locate request from a planned excavation — returns a formatted ticket body |
| `/api/locate-requests/status` | GET | — | `?lat=&lng=` → `{cleared, gatingRequest, nearby}` — whether a location is cleared to dig |
| `/api/locate-requests/:id/submit` | POST | any | Mark a draft as filed with the real one-call center |
| `/api/locate-requests/:id/confirm` | POST | any | Mark a locate as confirmed (site marked/cleared) — this is what actually authorizes digging |
| `/api/locate-requests/:id/override` | POST | engineer | Skip locate confirmation with a required, logged justification |
| `/api/discoveries` | GET / POST | POST: any | List / submit worker-reported new utilities (reporter auto-attributed) |
| `/api/discoveries/:id/verify` | POST | engineer | Run AI verification (Gemini or heuristic fallback) |
| `/api/discoveries/:id/approve` | POST | engineer | Writes a new record into the utility registry |
| `/api/discoveries/:id/reject` | POST | engineer | Marks the report rejected, no registry change |
| `/api/uploads/photo` | POST | — | multipart `photo` field → `{url}`, served at `/uploads/<file>` |
| `/api/analytics` | GET | — | Aggregated real usage stats for Analytics/Overview |
| `/api/assistant` | POST | — | `{question, context}` → AI explanation of the current result |
| `/api/devices` | GET | — | Latest ESP32 GPS check-ins |
| `/api/devices/gps` | POST | — | ESP32 GPS check-in — `{deviceId, latitude, longitude, timestamp}` |

## Next steps (from the original 18-phase plan)

Everything in the MUST HAVE and HIGH VALUE tiers is functional, and so is
most of ADVANCED (discovery reports, AI verification, engineer approval,
Firestore-ready persistence, real analytics, and auth). What's left:

- **ESP32 + NEO-6M hardware** (Phases 9–10) — firmware/wiring docs exist in
  `hardware/` but are untested on real hardware.
- **Live Gemini/Firestore credentials** — both integrations are coded and
  fail gracefully without them; drop real keys into `backend/.env` to swap
  from in-memory storage / heuristic fallback to the live versions. See
  `backend/CREDENTIALS.md` for exact setup steps, then run
  `npm run check-integrations` from `backend/` to confirm both work before
  demoing.
