import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  pageName: string;
}

interface State {
  error: Error | null;
}

/** Evita che un payload inatteso lasci l'intera applicazione bianca. */
export class PageErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.pageName}] errore di rendering`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="mx-auto grid min-h-[60vh] max-w-2xl place-items-center p-4">
        <div className="w-full rounded-2xl border border-warn/30 bg-bg-1 p-6 shadow-sm">
          <AlertTriangle className="mb-3 size-7 text-warn" aria-hidden />
          <h1 className="text-xl font-semibold text-text-0">{this.props.pageName} non è riuscito a mostrare i dati</h1>
          <p className="mt-2 text-sm leading-relaxed text-text-1">
            La connessione non è stata cancellata. Ricarica la pagina per riallineare applicazione e Worker.
          </p>
          <details className="mt-3 text-xs text-text-2">
            <summary className="cursor-pointer">Dettaglio tecnico</summary>
            <p className="mt-1 break-words font-mono">{this.state.error.message}</p>
          </details>
          <button
            type="button"
            className="mt-5 inline-flex h-10 items-center gap-2 rounded-lg bg-agent px-4 text-sm font-semibold text-white"
            onClick={() => window.location.reload()}
          >
            <RefreshCw className="size-4" aria-hidden /> Ricarica {this.props.pageName}
          </button>
        </div>
      </section>
    );
  }
}
