import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, X, Send } from 'lucide-react';
import { api } from '../lib/api';

const SUGGESTIONS = ['Why is this high risk?', 'Which utility is closest?', 'What should I verify before digging?'];

const LOGO_GRADIENT = 'linear-gradient(135deg, #7FE0EF, #3BA9BD)';

// Floating chat widget — "LUXY", a labeled launcher pill pinned to the
// bottom-right that pops up a compact chat card. The assistant explains the
// last DigSafe result — it never overrides the risk engine.
export default function AIAssistant({ context }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [asking, setAsking] = useState(false);

  const widgetRef = useRef(null);
  const chatEndRef = useRef(null);

  const hasResult = !!context;

  // Auto-scroll to the latest message
  useEffect(() => {
    if (open) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, asking, open]);

  // Click outside & Escape key listeners to close widget
  useEffect(() => {
    function handleClickOutside(event) {
      if (widgetRef.current && !widgetRef.current.contains(event.target)) {
        setOpen(false);
      }
    }
    
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }

    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  async function ask(question) {
    if (!question.trim() || asking) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', text: question }]);
    setAsking(true);

    const res = await api.askAssistant(question, context);
    const answer = res?.answer || 'The assistant is unreachable right now — the backend may not be running.';
    setMessages((m) => [...m, { role: 'assistant', text: answer, source: res?.source }]);
    setAsking(false);
  }

  // Simple Markdown & line break formatter for assistant responses
  function formatMessageText(text) {
    if (!text) return null;
    const lines = text.split(/\n/);
    return lines.map((line, i) => {
      const trimmed = line.trim();
      if (!trimmed) return <div key={i} className="h-1.5" />;

      // Check if it's a bullet point
      const isBullet = trimmed.startsWith('*') || trimmed.startsWith('-') || /^\d+\./.test(trimmed);
      const cleanText = trimmed.replace(/^[\*\-\d\.\s]+/, '');

      // Parse bold tags: **text**
      const parts = (isBullet ? cleanText : trimmed).split(/(\*\*.*?\*\*)/g);
      const formattedContent = parts.map((part, idx) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return (
            <strong key={idx} className="font-semibold text-cyan">
              {part.slice(2, -2)}
            </strong>
          );
        }
        return part;
      });

      if (isBullet) {
        return (
          <div key={i} className="flex gap-2 pl-2 mb-1.5 items-start text-[12.5px] leading-relaxed">
            <span className="text-cyan mt-1 select-none text-[10px]">•</span>
            <div>{formattedContent}</div>
          </div>
        );
      }

      return (
        <p key={i} className="mb-2 text-[12.5px] leading-relaxed last:mb-0">
          {formattedContent}
        </p>
      );
    });
  }

  return createPortal(
    <div ref={widgetRef}>
      {/* Launcher pill — floats gently, pinned top-right below the header */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Close LUXY assistant' : 'Open LUXY assistant'}
        className="tt-float fixed top-16 right-6 z-[2000] flex items-center gap-2.5 rounded-full border border-cyan/50 bg-[var(--bg-panel)] py-2 pl-2.5 pr-4 shadow-[0_10px_34px_rgba(0,0,0,0.5)] transition hover:border-cyan hover:bg-[var(--bg-panel-2)] hover:scale-[1.03]"
      >
        <span className="relative shrink-0">
          <span className="flex h-9 w-9 items-center justify-center rounded-full text-[#03151F]" style={{ background: LOGO_GRADIENT }}>
            {open ? <X className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
          </span>
          {!open && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-green animate-pulse ring-2 ring-[var(--bg-panel)]" />}
        </span>
        <span className="text-left leading-tight">
          <span className="block font-display font-bold text-[13.5px] tracking-tight">LUXY</span>
          <span className="block text-[10px] text-[var(--text-faint)]">
            {open ? 'Close assistant' : 'Ask about this dig'}
          </span>
        </span>
      </button>

      {/* Chat popup */}
      {open && (
        <div
          role="dialog"
          aria-label="LUXY assistant"
          className="tt-pop-in fixed top-[128px] right-6 z-[2100] flex w-[340px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] shadow-2xl"
        >
          <div className="h-1 w-full" style={{ background: LOGO_GRADIENT }} />
          <div className="flex items-center gap-2.5 border-b border-[var(--border)] bg-[var(--bg-panel-2)] px-4 py-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-full text-[#03151F]" style={{ background: LOGO_GRADIENT }}>
              <Sparkles className="h-4 w-4" />
            </span>
            <div className="leading-tight">
              <div className="font-display font-bold text-[14px] tracking-tight">LUXY</div>
              <div className="text-[10.5px] text-[var(--text-faint)]">Explains — never overrides the risk engine</div>
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="ml-auto rounded-md p-1 text-[var(--text-faint)] transition hover:text-[var(--text)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex max-h-[300px] flex-col gap-2.5 overflow-y-auto px-4 py-3.5">
            {messages.length === 0 ? (
              hasResult ? (
                <div className="flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => ask(s)}
                      className="text-[11.5px] px-3 py-1.5 rounded-md border border-[var(--border)] text-[var(--text-dim)] hover:border-cyan hover:text-cyan transition"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-[12px] leading-relaxed text-[var(--text-faint)]">
                  Run an analysis above first, then come back here to ask questions about the result.
                </p>
              )
            ) : (
              <>
                {messages.map((m, i) => (
                  <div
                    key={i}
                    className={`text-[12.5px] leading-relaxed px-3.5 py-2.5 rounded-md ${
                      m.role === 'user'
                        ? 'bg-[var(--bg-panel-2)] border border-[var(--border)] ml-6'
                        : 'bg-[var(--bg-panel-2)] border border-cyan/30 mr-6'
                    }`}
                  >
                    {m.role === 'user' ? m.text : formatMessageText(m.text)}
                    {m.source === 'fallback' && (
                      <div className="text-[10.5px] text-[var(--text-faint)] mt-1.5 border-t border-[var(--border)] pt-1">
                        Explained locally — Gemini not configured
                      </div>
                    )}
                  </div>
                ))}
                {asking && (
                  <div className="flex items-center gap-1 px-3.5 py-2.5 rounded-md bg-[var(--bg-panel-2)] border border-cyan/15 mr-12 w-fit">
                    <span className="h-1.5 w-1.5 rounded-full bg-cyan animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="h-1.5 w-1.5 rounded-full bg-cyan animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="h-1.5 w-1.5 rounded-full bg-cyan animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                )}
                <div ref={chatEndRef} />
              </>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              ask(input);
            }}
            className="flex items-center gap-2 border-t border-[var(--border)] p-3"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={hasResult ? 'Ask about this result…' : 'Run an analysis first…'}
              disabled={!hasResult || asking}
              className="text-[12.5px] flex-1 bg-[var(--bg-panel-2)] border border-[var(--border)] rounded px-3 py-1.5 text-[var(--text)] focus:border-cyan focus:outline-none"
            />
            <button
              type="submit"
              disabled={!hasResult || asking || !input.trim()}
              aria-label="Send"
              className="shrink-0 flex h-9 w-9 items-center justify-center rounded-md bg-cyan text-[#03151F] transition hover:opacity-90 disabled:opacity-40"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </div>
      )}
    </div>,
    document.body
  );
}