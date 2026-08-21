import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { BASE } from '../lib/utilities';
import { EmptyState, OfflinePanel } from '../components/Feedback';
import { ClipboardList } from 'lucide-react';

const STATUS_BADGE = {
  'PENDING REVIEW': 'bg-[var(--bg-panel-2)] text-amber',
  'AI VERIFIED — PENDING ENGINEER REVIEW': 'bg-[var(--bg-panel-2)] text-cyan',
  APPROVED: 'bg-[var(--bg-panel-2)] text-green',
  REJECTED: 'bg-[var(--bg-panel-2)] text-red',
};

const UTILITY_TYPES = ['water', 'electric', 'fiber', 'gas', 'sewer'];

export default function DiscoveryReports() {
  const { user } = useAuth();
  const [reports, setReports] = useState([]);
  const [connected, setConnected] = useState(true);

  const [utilityType, setUtilityType] = useState('fiber');
  const [estimatedDepth, setEstimatedDepth] = useState(1.4);
  const [lat, setLat] = useState(BASE.lat);
  const [lng, setLng] = useState(BASE.lng);
  const [notes, setNotes] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [photoPreview, setPhotoPreview] = useState(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [justSubmitted, setJustSubmitted] = useState(null);

  async function refresh() {
    const remote = await api.listDiscoveries();
    if (remote) {
      setReports([...remote].reverse());
      setConnected(true);
    } else {
      setConnected(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handlePhotoSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setPhotoPreview(URL.createObjectURL(file));
    setPhotoUrl('');
    setUploadingPhoto(true);
    const result = await api.uploadPhoto(file);
    setUploadingPhoto(false);
    if (result?.url) {
      setPhotoUrl(result.url);
    } else {
      setUploadError('Upload failed — check the backend is running, then try again.');
    }
  }

  function clearPhoto() {
    setPhotoPreview(null);
    setPhotoUrl('');
    setUploadError(null);
  }

  async function submit(e) {
    e.preventDefault();
    if (uploadingPhoto) return;
    setSubmitting(true);
    const record = await api.reportDiscovery({
      utilityType,
      estimatedDepth,
      latitude: lat,
      longitude: lng,
      notes,
      photoUrl: photoUrl || null,
    });
    setSubmitting(false);
    if (record) {
      setJustSubmitted(record.id);
      setNotes('');
      clearPhoto();
      refresh();
    }
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="font-display font-bold text-[22px]">Discovery reports</h1>
          <p className="text-[12.5px] text-[var(--text-dim)] mt-1">
            Report an unrecorded utility found during excavation. AI verification and engineer approval happen on
            the Engineer Dashboard &mdash; a report never updates the utility database on its own.
          </p>
        </div>
        {!connected && (
          <span className="text-[10px] text-red border border-red/35 bg-red/10 px-2.5 py-1.5 rounded-md">
            BACKEND UNREACHABLE
          </span>
        )}
      </div>

      {!connected && (
        <OfflinePanel
          className="mb-5"
          label="Report history unavailable"
          message="The backend is unreachable, so new reports can&apos;t be filed or listed. Start it and reload."
        />
      )}

      <div className="grid lg:grid-cols-[1fr_360px] gap-5 items-start">
        <div>
          <h3 className="font-display font-semibold text-[14.5px] mb-3">Report history</h3>
          {reports.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No discovery reports yet"
              message="Report an unrecorded utility found during excavation — it goes straight to the engineer review queue."
            />
          ) : (
            <div className="flex flex-col gap-3">
              {reports.map((r) => (
                <div key={r.id} className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-5 py-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="font-display font-semibold text-[14px]">
                        {r.utilityType[0].toUpperCase() + r.utilityType.slice(1)}{' '}
                        <span className="font-mono text-[10.5px] text-[var(--text-faint)]">{r.id}</span>
                      </div>
                      <div className="font-mono text-[11.5px] text-[var(--text-dim)] mt-1">
                        {Number(r.latitude).toFixed(5)}, {Number(r.longitude).toFixed(5)} &middot; {r.estimatedDepth} m
                      </div>
                    </div>
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md whitespace-nowrap ${STATUS_BADGE[r.status] || 'bg-[var(--bg-panel-2)] text-[var(--text-faint)]'}`}>
                      {r.status}
                    </span>
                  </div>
                  {r.notes && <p className="text-[12px] text-[var(--text-dim)] mt-2.5">{r.notes}</p>}
                  {r.photoUrl && (
                    <img
                      src={r.photoUrl}
                      alt={`${r.utilityType} discovery site`}
                      className="mt-2.5 w-full max-w-[220px] h-28 object-cover rounded-md border border-[var(--border)]"
                    />
                  )}
                  {typeof r.aiConfidence === 'number' && (
                    <div className="text-[11.5px] text-[var(--text-dim)] mt-2.5 pt-2.5 border-t border-white/5">
                      AI confidence: <span className="text-cyan font-mono">{r.aiConfidence}%</span> &mdash; {r.aiVerdict}
                    </div>
                  )}
                  <div className="text-[10.5px] text-[var(--text-faint)] mt-2">
                    Reported by {r.reportedBy} &middot; {r.reportedAt ? new Date(r.reportedAt).toLocaleString() : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <form onSubmit={submit} className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-5 py-5">
          <h3 className="font-display font-semibold text-[14.5px] mb-3.5">Report new utility</h3>

          <Field label="Utility type">
            <select value={utilityType} onChange={(e) => setUtilityType(e.target.value)}>
              {UTILITY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t[0].toUpperCase() + t.slice(1)}
                </option>
              ))}
            </select>
          </Field>

          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Estimated depth (m)">
              <input type="number" step="0.1" min="0" value={estimatedDepth} onChange={(e) => setEstimatedDepth(parseFloat(e.target.value) || 0)} />
            </Field>
            <Field label="Reporting as">
              <div className="text-[13px] text-cyan font-semibold py-1.5">{user?.name}</div>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Latitude">
              <input type="number" step="0.00001" value={lat} onChange={(e) => setLat(parseFloat(e.target.value) || 0)} />
            </Field>
            <Field label="Longitude">
              <input type="number" step="0.00001" value={lng} onChange={(e) => setLng(parseFloat(e.target.value) || 0)} />
            </Field>
          </div>

          <Field label="Photo (optional)">
            {photoPreview ? (
              <div className="relative">
                <img src={photoPreview} alt="Discovery preview" className="w-full h-32 object-cover rounded-md border border-[var(--border)]" />
                <button
                  type="button"
                  onClick={clearPhoto}
                  className="absolute top-1.5 right-1.5 font-mono text-[10px] font-bold bg-black/70 text-white px-2 py-1 rounded-md hover:bg-black/90 transition"
                >
                  Remove
                </button>
                <div className="mt-1.5 text-[11px] font-mono">
                  {uploadingPhoto ? (
                    <span className="text-amber">Uploading&hellip;</span>
                  ) : photoUrl ? (
                    <span className="text-green">Uploaded &mdash; will attach to report</span>
                  ) : null}
                </div>
              </div>
            ) : (
              <label className="flex flex-col items-center justify-center gap-1 border border-dashed border-[var(--border)] rounded-md py-5 text-[11.5px] text-[var(--text-faint)] cursor-pointer hover:border-cyan hover:text-cyan transition">
                <span>Tap to attach a site photo</span>
                <input type="file" accept="image/*" capture="environment" onChange={handlePhotoSelect} className="hidden" />
              </label>
            )}
            {uploadError && <p className="text-[11px] text-red mt-1.5">{uploadError}</p>}
          </Field>

          <Field label="Notes">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full bg-[var(--bg-panel-2)] border border-[var(--border)] text-[var(--text)] px-2.5 py-2 rounded-md text-[13px] font-mono resize-none focus:outline-none focus:border-cyan"
              placeholder="Cable discovered during excavation…"
            />
          </Field>

          <button
            type="submit"
            disabled={submitting || uploadingPhoto}
            className="w-full mt-1.5 font-semibold text-[13.5px] py-2.5 rounded-md bg-cyan text-[#03151F] hover:opacity-90 transition disabled:opacity-60"
          >
            {submitting ? 'Submitting…' : uploadingPhoto ? 'Waiting for photo upload…' : 'Submit report'}
          </button>
          {justSubmitted && (
            <div className="mt-2 font-mono text-[10px] text-green text-center">Submitted as {justSubmitted} — pending review</div>
          )}
        </form>
      </div>
    </section>
  );
}

function Field({ label, children }) {
  return (
    <div className="mb-2.5">
      <label className="block text-[11.5px] text-[var(--text-dim)] mb-1.5">{label}</label>
      {children}
    </div>
  );
}
