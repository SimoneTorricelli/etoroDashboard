import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'

/**
 * Basename runtime per GitHub Pages project sites (base './' in vite.config):
 * le route sono tutte a un livello (/mercati, /portfolio, …), quindi la
 * directory che ospita index.html è tutto ciò che precede l'ultimo segmento.
 * Funziona anche in dev (/) e su user sites.
 */
function computeBasename(): string {
  const path = window.location.pathname;
  if (path.endsWith('/index.html')) return path.slice(0, -'index.html'.length);
  if (path.endsWith('/')) return path;
  return path.slice(0, path.lastIndexOf('/') + 1);
}

// Nota: niente StrictMode (react-dev.md) — evita doppia esecuzione degli effetti live.
createRoot(document.getElementById('root')!).render(
  <BrowserRouter basename={computeBasename()}>
    <App />
  </BrowserRouter>,
)

// Attende che anche CSS e risorse critiche siano caricati prima di chiudere il
// recupero. Evita loop sui browser mobili che sospendono sessionStorage.
window.addEventListener('load', () => {
  window.setTimeout(() => {
    try {
      window.sessionStorage.removeItem('torri.asset-recovery-at');
      const url = new URL(window.location.href);
      if (url.searchParams.has('__torri_reload')) {
        url.searchParams.delete('__torri_reload');
        window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
      }
    } catch { /* storage e history sono best effort su Safari privato */ }
  }, 1500);
}, { once: true });
