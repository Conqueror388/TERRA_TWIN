// Lazy, optional Firebase Admin init.
// If FIREBASE_SERVICE_ACCOUNT (JSON string) or GOOGLE_APPLICATION_CREDENTIALS
// isn't set, the app falls back to in-memory storage so the API still runs
// for local prototyping without any Firebase project configured.

import admin from 'firebase-admin';
// firebase-admin v12+ uses a fully modular API: cert()/applicationDefault()
// live directly on the default export, and firestore access moved out of
// admin.firestore() into its own 'firebase-admin/firestore' submodule.
// Aliased to avoid colliding with this file's own exported getFirestore().
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';

let db = null;
let initialized = false;

export function getFirestore() {
  if (process.env.SIMULATE_FIRESTORE_ERROR === 'true') {
    console.log('[firebase] Simulating Firestore Quota Exceeded (RESOURCE_EXHAUSTED) error.');
    return {
      collection: () => ({
        doc: () => ({
          set: () => Promise.reject(new Error('8 RESOURCE_EXHAUSTED: Quota exceeded.')),
          get: () => Promise.reject(new Error('8 RESOURCE_EXHAUSTED: Quota exceeded.')),
        }),
        get: () => Promise.reject(new Error('8 RESOURCE_EXHAUSTED: Quota exceeded.')),
        where: () => ({
          limit: () => ({
            get: () => Promise.reject(new Error('8 RESOURCE_EXHAUSTED: Quota exceeded.')),
          }),
        }),
      }),
    };
  }

  if (initialized) return db;
  initialized = true;

  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const creds = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      const app = admin.initializeApp({ credential: admin.cert(creds) });
      db = getAdminFirestore(app);
      // Records built for the in-memory store carry `undefined` fields (e.g.
      // certificate.locate.overriddenBy when the locate was confirmed, not
      // overridden). Firestore rejects undefined by default — drop them so the
      // same records persist cleanly.
      db.settings({ ignoreUndefinedProperties: true });
      console.log('[firebase] Connected using FIREBASE_SERVICE_ACCOUNT.');
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      const app = admin.initializeApp({ credential: admin.applicationDefault() });
      db = getAdminFirestore(app);
      db.settings({ ignoreUndefinedProperties: true });
      console.log('[firebase] Connected using application default credentials.');
    } else {
      console.warn('[firebase] No credentials found — running with in-memory storage only.');
    }
  } catch (err) {
    console.error('[firebase] Failed to initialize, falling back to in-memory storage:', err.message);
    db = null;
  }

  return db;
}
