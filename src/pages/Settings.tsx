/**
 * Impostazioni (/impostazioni) — design/settings.md.
 * Header con chip di stato connessione; nav sinistra sticky (span 3) con
 * scroll-spy (IntersectionObserver); contenuto (span 9) con 5 sezioni:
 * Connessione API · Proxy CORS · Import CSV · Preferenze · Rischio e privacy.
 * Supporta ?import=csv (scroll diretto alla sezione Import).
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { useAppData } from '@/lib/data/store';
import { StatusDot } from '@/components/shared/StatusDot';
import { ConnectionSection } from '@/components/settings/ConnectionSection';
import { ProxySection } from '@/components/settings/ProxySection';
import { CsvImportSection } from '@/components/settings/CsvImportSection';
import { PreferencesSection } from '@/components/settings/PreferencesSection';
import { RiskSection } from '@/components/settings/RiskSection';

const NAV = [
  { id: 'connessione', label: 'Connessione API' },
  { id: 'proxy', label: 'Proxy CORS' },
  { id: 'import', label: 'Import CSV' },
  { id: 'preferenze', label: 'Preferenze' },
  { id: 'rischio', label: 'Rischio e privacy' },
] as const;

export default function Settings() {
  const { mode, status, settings } = useAppData();
  const [searchParams] = useSearchParams();
  const [active, setActive] = useState<string>('connessione');

  /* Scroll-spy: la sezione più vicina alla cima del viewport è attiva */
  useEffect(() => {
    const sections = Array.from(document.querySelectorAll<HTMLElement>('[data-settings-section]'));
    if (!sections.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActive(e.target.id);
        }
      },
      { rootMargin: '-20% 0px -70% 0px', threshold: 0 },
    );
    for (const s of sections) observer.observe(s);
    return () => observer.disconnect();
  }, []);

  /* ?import=csv → scroll diretto alla sezione Import CSV */
  useEffect(() => {
    if (searchParams.get('import') === 'csv') {
      const t = setTimeout(() => {
        document.getElementById('import')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 150);
      return () => clearTimeout(t);
    }
  }, [searchParams]);

  const scrollTo = (id: string) => {
    setActive(id);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  /* Chip di stato connessione (header) */
  const chip = (() => {
    if (mode === 'demo') {
      return { variant: 'idle' as const, cls: 'border-info/40 bg-info/10 text-info', label: 'Modalità Demo' };
    }
    if (status === 'connected') {
      const env = settings.live.environment === 'real' ? 'Real' : 'Demo';
      const perm = settings.live.permissions === 'write' ? 'Lettura+Scrittura' : 'Sola lettura';
      return { variant: 'ok' as const, cls: 'border-gain/40 bg-gain-dim text-gain', label: `Connesso · ${env} · ${perm}` };
    }
    return { variant: 'error' as const, cls: 'border-loss/40 bg-loss-dim text-loss', label: 'Non connesso' };
  })();

  return (
    <div className="grid grid-cols-12 gap-4">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28 }}
        className="col-span-12 flex flex-wrap items-center justify-between gap-3"
      >
        <div>
          <h1 className="font-display text-display-lg text-text-0">Impostazioni</h1>
          <p className="mt-1 text-caption text-text-1">
            Connessione, chiavi API, proxy, import dati e preferenze.
          </p>
        </div>
        <motion.span
          key={chip.label}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2 }}
          className={cn('flex items-center gap-2 rounded-full border px-3 py-1.5 text-caption font-medium', chip.cls)}
        >
          <StatusDot variant={chip.variant} />
          {chip.label}
        </motion.span>
      </motion.div>

      {/* Nav sinistra — sticky su desktop, chip bar orizzontale su mobile */}
      <motion.nav
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, delay: 0.05 }}
        className="col-span-12 lg:col-span-3"
        aria-label="Sezioni impostazioni"
      >
        <div className="flex gap-1 overflow-x-auto pb-1 lg:sticky lg:top-20 lg:flex-col lg:gap-0 lg:overflow-visible lg:pb-0">
          {NAV.map((item) => (
            <button
              key={item.id}
              onClick={() => scrollTo(item.id)}
              className={cn(
                'shrink-0 whitespace-nowrap rounded-lg border-l-[3px] px-3 py-2 text-left text-body-strong transition-colors duration-100',
                active === item.id
                  ? 'border-gain bg-bg-2 text-text-0'
                  : 'border-transparent text-text-2 hover:bg-bg-2/60 hover:text-text-1',
              )}
              aria-current={active === item.id ? 'true' : undefined}
            >
              {item.label}
            </button>
          ))}
        </div>
      </motion.nav>

      {/* Contenuto */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, delay: 0.1 }}
        className="col-span-12 space-y-10 lg:col-span-9"
      >
        <ConnectionSection />
        <ProxySection />
        <CsvImportSection />
        <PreferencesSection />
        <RiskSection />
      </motion.div>
    </div>
  );
}
