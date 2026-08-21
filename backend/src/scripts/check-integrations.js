// Standalone credential check for the two optional integrations
// (Firestore + Gemini). Run this after filling in backend/.env to confirm
// both are actually reachable, before trusting the full app to use them.
//
// Usage (from backend/):
//   node src/scripts/check-integrations.js
//
// Exits 0 if every configured integration works. Unconfigured integrations
// are reported as "skipped", not failed — that's expected, the app falls
// back gracefully either way.

import 'dotenv/config';
import { getFirestore } from '../lib/firebase.js';

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

let hadFailure = false;

async function checkFirestore() {
  const configured = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS);
  if (!configured) {
    console.log('[firestore] SKIPPED — no FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS set.');
    return;
  }
  try {
    const db = getFirestore();
    if (!db) throw new Error('getFirestore() returned null despite credentials being set — check the logged init error above.');
    // Round-trip write + read + delete against a throwaway doc so this never
    // pollutes real collections.
    const ref = db.collection('_integration_check').doc('ping');
    await ref.set({ at: new Date().toISOString() });
    const doc = await ref.get();
    if (!doc.exists) throw new Error('Wrote a doc but could not read it back.');
    await ref.delete();
    console.log('[firestore] OK — write/read/delete round-trip succeeded.');
  } catch (err) {
    hadFailure = true;
    console.error('[firestore] FAILED —', err.message);
  }
}

async function checkGemini() {
  if (!process.env.GEMINI_API_KEY) {
    console.log('[gemini] SKIPPED — no GEMINI_API_KEY set.');
    return;
  }
  try {
    const r = await fetch(`${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Reply with exactly one word: OK' }] }],
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} ${r.statusText}: ${body.slice(0, 300)}`);
    }
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) throw new Error('Response had no text content — check the API response shape hasn\'t changed.');
    console.log(`[gemini] OK — model "${GEMINI_MODEL}" responded: "${text}"`);
  } catch (err) {
    hadFailure = true;
    console.error('[gemini] FAILED —', err.message);
  }
}

await checkFirestore();
await checkGemini();

if (hadFailure) {
  console.error('\nOne or more configured integrations failed. See CREDENTIALS.md for setup steps.');
  process.exit(1);
} else {
  console.log('\nAll configured integrations are working (unconfigured ones fall back automatically).');
}
