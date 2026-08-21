import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen w-full flex-col items-center justify-center gap-4 text-center px-6 py-16">
          <div className="text-[11px] text-[var(--text-faint)] border border-[var(--border)] rounded-full px-3 py-1">
            Runtime error
          </div>
          <div className="font-display text-2xl font-bold text-[var(--text)]">Something went wrong</div>
          <pre className="max-w-[720px] w-full overflow-auto font-mono text-xs text-[var(--text-dim)] border border-[var(--border)] bg-[#0B0E11] rounded-lg p-4 text-left">
            {String(this.state.error?.message || this.state.error)}
          </pre>
          <button
            onClick={() => window.location.reload()}
            className="font-semibold text-xs px-4 py-2 rounded-md bg-cyan text-[#04121A] hover:opacity-90"
          >
            Reload page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}