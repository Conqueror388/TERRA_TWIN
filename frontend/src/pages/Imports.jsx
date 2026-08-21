import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

const ACCEPT = '.geojson,.json,.csv';
const FORMAT_HINTS = [
  { ext: 'CSV', hint: 'type,latitude,longitude,depth_m,owner,confidence,criticality' },
  { ext: 'GeoJSON', hint: 'FeatureCollection of points — properties: type, depth, owner' },
  { ext: 'JSON', hint: 'array of { type, latitude, longitude, depth, owner, … }' },
];

const BATCH_LABEL = {
  water: '#4FD1E8',
  electric: '#F5A623',
  fiber: '#B58CFF',
  gas: '#E4483C',
  sewer: '#8CA3BF',
};

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString();
}

export default function Imports() {
  const [drag, setDrag] = useState(false);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [counts, setCounts] = useState(null);
  const [recent, setRecent] = useState([]);
  const [registryOpen, setRegistryOpen] = useState(false);
  const inputRef = useRef(null);

  const refreshCounts = () => {
    api.getUtilities().then((res) => {
      if (res) setCounts({ registry: res.utilities?.length || 0 });
    });
  };

  useEffect(() => {
    refreshCounts();
    api.getRegistryHistory({ kind: 'IMPORTED', limit: 50 }).then((res) => {
      if (res) setRecent(res.rows || []);
    });
  }, []);

  const pick = (f) => {
    if (!f) return;
    setFile(f);
    setResult(null);
    setError('');
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDrag(false);
    pick(e.dataTransfer.files?.[0]);
  };

  const upload = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    setResult(null);
    const res = await api.importUtilities(file);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setResult(res.data);
    refreshCounts();
    api.getRegistryHistory({ kind: 'IMPORTED', limit: 50 }).then((r) => {
      if (r) setRecent(r.rows || []);
    });
  };

  const downloadTemplate = async () => {
    const res = await api.getImportTemplate();
    if (!res) return;
    const url = URL.createObjectURL(res.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = res.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const dropCls =
    'rounded-lg border-2 border-dashed transition-colors cursor-pointer flex flex-col items-center justify-center px-6 py-10 text-center ' +
    (drag
      ? 'border-cyan bg-[var(--bg-panel-2)]'
      : 'border-[var(--border)] bg-[var(--bg-panel)] hover:border-cyan/60');

  return (
    <div>
      <header className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="font-display font-semibold text-[20px] tracking-tight">Import Data</h1>
          <p className="text-[12.5px] text-[var(--text-dim)] mt-1.5 max-w-[720px] leading-relaxed">
            The on-ramp for government and GIS datasets. Upload the underground utility records your agency holds
            (GeoJSON, CSV, or JSON) and they land straight in the registry with provenance — the planner, risk
            engine, and Digital Twin pick them up immediately. Duplicates within 2 m of an existing record of the
            same type are skipped automatically.
          </p>
        </div>
        <button
          onClick={downloadTemplate}
          className="font-semibold text-[11.5px] px-3.5 py-2 rounded-lg border border-[var(--border)] text-[var(--text-dim)] hover:text-cyan hover:border-cyan transition"
        >
          ⤓ CSV template
        </button>
      </header>

      <section>
        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={dropCls}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
        >
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => pick(e.target.files?.[0])}
          />
          <div className="font-display text-[15px] font-semibold">
            {file ? file.name : 'Drop your dataset here'}
          </div>
          <div className="text-[11.5px] text-[var(--text-faint)] mt-1">
            {file
              ? `${(file.size / 1024).toFixed(0)} KB — ${ACCEPT.split(',').join(' / ')} · click to choose another`
              : 'or click to browse · .geojson .json .csv · WGS84 coordinates (lat/lng)'}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
          {FORMAT_HINTS.map((f) => (
            <div key={f.ext} className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-3.5 py-3">
              <div className="font-mono text-[11px] text-cyan">{f.ext}</div>
              <div className="text-[11px] text-[var(--text-dim)] mt-1 leading-relaxed">{f.hint}</div>
            </div>
          ))}
        </div>

        {file && (
          <div className="mt-4 flex items-center justify-between gap-3 bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-4 py-3">
            <div className="text-[12px] text-[var(--text-dim)]">
              <span className="text-cyan font-semibold">{file.name}</span> — records are validated against the
              registry before anything is written. Nothing is overwritten.
            </div>
            <button
              onClick={upload}
              disabled={busy}
              className="font-semibold text-[11.5px] px-4 py-2 rounded-lg bg-cyan text-[#061013] hover:opacity-90 transition disabled:opacity-40 shrink-0"
            >
              {busy ? 'Importing…' : 'Import into registry'}
            </button>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-lg border border-[#E4483C]/40 bg-[#E4483C]/10 px-4 py-3 text-[12px] text-[#FF8F85]">
            ⚠ {error}
          </div>
        )}

        {result && (
          <div className="mt-4 bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--border)] font-semibold text-[12.5px]">
              Import complete — <span className="text-cyan">{result.sourceFile}</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-[var(--border)]">
              {[
                { label: 'Records in file', value: result.total, cls: 'text-[var(--text)]' },
                { label: 'Imported', value: result.imported, cls: 'text-emerald' },
                { label: 'Duplicates skipped', value: result.skippedDuplicates, cls: 'text-[var(--text-dim)]' },
                { label: 'Invalid rows', value: result.invalid, cls: 'text-amber' },
              ].map((s) => (
                <div key={s.label} className="bg-[var(--bg-panel)] px-4 py-3">
                  <div className="text-[10.5px] text-[var(--text-faint)]">{s.label}</div>
                  <div className={`font-display text-[20px] font-semibold mt-0.5 ${s.cls}`}>{s.value}</div>
                </div>
              ))}
            </div>
            {result.errors?.length > 0 && (
              <div className="px-4 py-3 border-t border-[var(--border)]">
                <div className="text-[10.5px] text-[var(--text-faint)] mb-2">Rows that need fixing ({result.errors.length})</div>
                <div className="max-h-40 overflow-y-auto font-mono text-[11px] leading-relaxed space-y-1">
                  {result.errors.map((e, i) => (
                    <div key={i} className="text-[var(--text-dim)]">
                      <span className="text-amber">row {e.row}:</span> {e.message}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {counts && (
          <div className="mt-4 flex items-center gap-x-5 gap-y-1 text-[11.5px] text-[var(--text-faint)]">
            <span>Registry now holds <span className="text-[var(--text)] font-semibold">{counts.registry}</span> engineer-approved records</span>
          </div>
        )}
      </section>

      <section className="mt-6">
        <button
          onClick={() => setRegistryOpen((v) => !v)}
          className="flex items-center gap-2 text-[12.5px] font-semibold text-[var(--text-dim)] hover:text-cyan transition"
        >
          <span className={`inline-block transition-transform ${registryOpen ? 'rotate-90' : ''}`}>▶</span>
          Recent bulk imports ({recent.length})
        </button>

        {registryOpen && (
          <div className="mt-3 bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg overflow-hidden">
            {recent.length === 0 ? (
              <div className="px-5 py-8 text-center text-[12px] text-[var(--text-dim)]">
                No bulk imports yet — upload your first dataset above. Every imported asset also appears under
                Registry History with its batch provenance.
              </div>
            ) : (
              <div className="divide-y divide-[var(--border)]">
                {recent.map((h) => (
                  <div key={h.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
                    <span className="w-20 shrink-0 rounded bg-[var(--bg-panel-2)] px-2 py-0.5 text-center font-mono text-[10.5px] text-emerald">
                      {h.utility?.type}
                    </span>
                    <span className="shrink-0 w-2 h-2 rounded-full" style={{ background: BATCH_LABEL[h.utility?.type] || '#8CA3BF' }} />
                    <span className="font-mono text-[11px] text-cyan">{h.utilityId}</span>
                    <span className="text-[11px] text-[var(--text-dim)] flex-1 min-w-[220px]">
                      {h.utility ? `${h.utility.owner} · depth ${h.utility.depth} m · confidence ${h.utility.confidence}%` : h.summary}
                    </span>
                    <span className="text-[10.5px] text-[var(--text-faint)]">{fmtTime(h.at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}