/**
 * SuggestionsCard — "Valutazione e prossimi passi":
 * lista ordinata di azioni (numeri Space Grotesk, bordo per severità,
 * razionale con numeri reali, CTA contestuale) + checklist "Prossimi passi"
 * spuntabile e persistita in localStorage (design/portfolio.md Row 5).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { motion } from 'framer-motion';
import { ArrowRight, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Suggestion } from './analytics';

const CHECKLIST_KEY = 'torino.portfolio.checklist.v1';

export interface ChecklistItem {
  id: string;
  label: string;
}

const SEVERITY_STYLES: Record<Suggestion['severity'], { border: string; chip: string; label: string }> = {
  alta: { border: 'border-l-loss', chip: 'bg-loss-dim text-loss', label: 'Alta' },
  media: { border: 'border-l-warn', chip: 'bg-warn/15 text-warn', label: 'Media' },
  bassa: { border: 'border-l-info', chip: 'bg-info/15 text-info', label: 'Bassa' },
};

function loadChecklist(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(CHECKLIST_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch { return {}; }
}

export function SuggestionsCard({ suggestions, checklist }: { suggestions: Suggestion[]; checklist: ChecklistItem[] }) {
  const [checked, setChecked] = useState<Record<string, boolean>>(loadChecklist);

  useEffect(() => {
    try { localStorage.setItem(CHECKLIST_KEY, JSON.stringify(checked)); } catch { /* ignora */ }
  }, [checked]);

  const toggle = (id: string) => setChecked((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <div>
      <h2 className="text-title text-text-0">Valutazione e prossimi passi</h2>

      <ol className="mt-4 space-y-3">
        {suggestions.map((s, i) => {
          const st = SEVERITY_STYLES[s.severity];
          return (
            <motion.li
              key={s.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.28, delay: i * 0.06, ease: [0.2, 0.8, 0.2, 1] }}
              className={cn('rounded-lg border border-hairline border-l-[3px] bg-bg-0 p-3.5', st.border)}
            >
              <div className="flex items-start gap-3">
                <span className="font-display text-[22px] font-semibold leading-none text-text-2">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-body-strong text-text-0">{s.title}</span>
                    <span className={cn('rounded-full px-1.5 py-0.5 text-micro font-medium', st.chip)}>
                      {st.label}
                    </span>
                  </div>
                  <p className="mt-1 text-caption leading-relaxed text-text-1">{s.rationale}</p>
                  <Link
                    to={s.ctaHref}
                    className="mt-2 inline-flex items-center gap-1 text-caption font-medium text-info transition-colors hover:text-text-0"
                  >
                    {s.ctaLabel}
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                  </Link>
                </div>
              </div>
            </motion.li>
          );
        })}
        {suggestions.length === 0 && (
          <li className="rounded-lg border border-hairline bg-bg-0 p-4 text-caption text-text-1">
            Nessuna criticità rilevata: il portafoglio è ben bilanciato rispetto alle soglie di concentrazione.
          </li>
        )}
      </ol>

      <h3 className="mt-6 text-label font-medium uppercase tracking-[0.04em] text-text-2">Prossimi passi</h3>
      <ul className="mt-2 space-y-1">
        {checklist.map((item) => {
          const done = !!checked[item.id];
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => toggle(item.id)}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-bg-2"
                aria-pressed={done}
              >
                <span
                  className={cn(
                    'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border transition-all duration-200',
                    done ? 'border-gain bg-gain' : 'border-hairline-strong bg-bg-3',
                  )}
                  aria-hidden
                >
                  {done && <Check className="h-3 w-3 text-bg-0" strokeWidth={3} />}
                </span>
                <span
                  className={cn(
                    'text-body transition-all duration-200',
                    done ? 'text-text-2 line-through decoration-gain/60' : 'text-text-1',
                  )}
                >
                  {item.label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
