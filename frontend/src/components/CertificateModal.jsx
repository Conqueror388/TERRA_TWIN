import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

// DigSafe clearance certificate modal. Fetches the certificate metadata (number
// + verification code) and the official printable HTML document, then lets the
// engineer preview it, print/save as PDF, download the file, and test the code
// the way a site inspector would.
export default function CertificateModal({ planId, onClose }) {
  const [cert, setCert] = useState(null);
  const [docUrl, setDocUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [verifyCode, setVerifyCode] = useState('');
  const [verifyResult, setVerifyResult] = useState(null);
  const iframeRef = useRef(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const meta = await api.getPlanCertificate(planId);
      if (cancel) return;
      if (!meta || !meta.certificate) {
        setError(meta?.error || 'Could not load the certificate. Start the backend and make sure the plan is APPROVED.');
        setLoading(false);
        return;
      }
      setCert(meta.certificate);
      const doc = await api.getPlanCertificateDocument(planId);
      if (!cancel) {
        if (doc) setDocUrl(URL.createObjectURL(doc.blob));
        setLoading(false);
      }
    })();
    return () => {
      cancel = true;
      if (docUrl) URL.revokeObjectURL(docUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId]);

  const copyCode = () => {
    if (!cert) return;
    navigator.clipboard?.writeText(cert.verificationCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const download = () => {
    if (!docUrl) return;
    const a = document.createElement('a');
    a.href = docUrl;
    a.download = `terratwin-clearance-${cert.planId}.html`;
    a.click();
  };

  const runVerify = async () => {
    const code = verifyCode.trim().toUpperCase();
    if (!code) return;
    const res = await api.verifyCertificate(code);
    if (!res) {
      setVerifyResult({ ok: false, message: 'Could not reach the verification service.' });
      return;
    }
    if (res.valid) {
      setVerifyResult({
        ok: true,
        message: `Valid — certificate ${res.certificate.id} for plan "${res.certificate.planName}" (${res.certificate.riskLevel ?? '—'}, score ${res.certificate.score ?? '—'}).`,
      });
    } else {
      setVerifyResult({ ok: false, message: res.error || 'No certificate found for that code.' });
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-3xl bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg shadow-2xl flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--border)]">
          <div>
            <div className="font-display font-semibold text-[15px]">DigSafe clearance certificate</div>
            {cert && (
              <div className="text-[11px] text-[var(--text-faint)] mt-0.5">
                {cert.id} · {cert.plan?.name} · {cert.verificationCode}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="font-semibold text-[12px] px-2.5 py-1.5 rounded-md border border-[var(--border)] text-[var(--text-dim)] hover:text-red hover:border-red transition"
          >
            Close
          </button>
        </div>

        {loading ? (
          <div className="px-5 py-12 text-center text-[12.5px] text-[var(--text-dim)]">Loading certificate…</div>
        ) : error ? (
          <div className="px-5 py-12 text-center text-[12.5px] text-[#FF8F85]">⚠ {error}</div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2.5 px-5 py-3 border-b border-[var(--border)]">
              <div className="flex items-center gap-2">
                <span className="text-[10.5px] text-[var(--text-faint)] uppercase tracking-wide">Verification code</span>
                <code className="font-mono text-[13px] font-bold text-cyan">{cert.verificationCode}</code>
              </div>
              <button
                onClick={copyCode}
                className="font-semibold text-[11px] px-2.5 py-1 rounded-md border border-[var(--border)] text-[var(--text-dim)] hover:text-cyan hover:border-cyan transition"
              >
                {copied ? 'Copied ✓' : 'Copy'}
              </button>
              <div className="ml-auto flex gap-2">
                <button
                  onClick={() => iframeRef.current?.contentWindow?.print()}
                  className="font-semibold text-[11px] px-3 py-1.5 rounded-md bg-cyan text-[#061013] hover:opacity-90 transition"
                >
                  Print / Save as PDF
                </button>
                <button
                  onClick={download}
                  className="font-semibold text-[11px] px-3 py-1.5 rounded-md border border-[var(--border)] text-[var(--text-dim)] hover:text-cyan hover:border-cyan transition"
                >
                  ⤓ Download
                </button>
              </div>
            </div>

            {docUrl ? (
              <iframe ref={iframeRef} title="Clearance certificate" src={docUrl} className="w-full flex-1 min-h-[52vh] bg-white" />
            ) : (
              <div className="px-5 py-12 text-center text-[12.5px] text-[var(--text-dim)]">
                Document failed to load — download it below instead.
              </div>
            )}

            <div className="px-5 py-3.5 border-t border-[var(--border)]">
              <div className="text-[10.5px] text-[var(--text-faint)] uppercase tracking-wide mb-2">
                Verify (as a site inspector would)
              </div>
              <div className="flex gap-2">
                <input
                  value={verifyCode}
                  onChange={(e) => { setVerifyCode(e.target.value.toUpperCase()); setVerifyResult(null); }}
                  placeholder="TT-XXXX-XXXX"
                  className="flex-1 font-mono rounded-md bg-[var(--bg-panel-2)] border border-[var(--border)] px-3 h-9 text-[12px] focus:outline-none focus:border-cyan"
                />
                <button
                  onClick={runVerify}
                  className="font-semibold text-[11.5px] px-4 py-2 rounded-md border border-cyan text-cyan hover:bg-[var(--bg-panel-2)] transition"
                >
                  Check
                </button>
              </div>
              {verifyResult && (
                <div className={`mt-2 text-[11.5px] ${verifyResult.ok ? 'text-green' : 'text-[#FF8F85]'}`}>
                  {verifyResult.message}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}