/**
 * Elementi condivisi delle sezioni Impostazioni:
 * - Section: wrapper con id (scroll-spy) + titolo
 * - Segmented: controllo segmentato a 2+ opzioni
 * - SavedCaption: "Salvato ✓" transiente (visibilità da useSavedFeedback)
 */
import { AnimatePresence, motion } from 'framer-motion';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Section({
  id, title, description, children,
}: {
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} data-settings-section className="scroll-mt-20">
      <h2 className="font-display text-display-md text-text-0">{title}</h2>
      {description && <p className="mt-1 text-caption text-text-1">{description}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

export function Segmented<T extends string>({
  options, value, onChange, ariaLabel,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="inline-flex gap-1 rounded-lg border border-hairline bg-bg-3 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            'rounded-md px-3 py-1.5 text-caption font-medium transition-colors duration-150',
            value === o.value ? 'bg-gain/15 text-gain' : 'text-text-2 hover:text-text-1',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SavedCaption({ visible }: { visible: boolean }) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.span
          initial={{ opacity: 0, y: 2 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="flex items-center gap-1 text-micro text-gain"
        >
          <Check className="h-3 w-3" aria-hidden /> Salvato
        </motion.span>
      )}
    </AnimatePresence>
  );
}
