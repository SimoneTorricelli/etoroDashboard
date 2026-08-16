/**
 * GroupEditor — crea/modifica un gruppo di investimento (design/agent.md):
 * nome, strumenti assegnati (multi-select a chip) e limite massimo
 * investibile (slider + input, hard cap).
 */
import { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/format';
import { InstrumentAvatar } from '@/components/shared/InstrumentAvatar';
import type { AgentGroup, Instrument } from '@/lib/data/types';

export interface GroupEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = nuovo gruppo. */
  group: AgentGroup | null;
  instruments: Instrument[];
  /** Strumenti assegnati (sidecar) del gruppo in modifica. */
  initialInstrumentIds: number[];
  displayCurrency: 'EUR' | 'USD';
  fromUsd: (usd: number) => number;
  toUsd: (display: number) => number;
  onSave: (name: string, capitalLimitUsd: number, instrumentIds: number[]) => void;
}

const LIMIT_MAX = 20000;
const LIMIT_STEP = 50;

export function GroupEditor({
  open, onOpenChange, group, instruments, initialInstrumentIds,
  displayCurrency, fromUsd, toUsd, onSave,
}: GroupEditorProps) {
  const [name, setName] = useState('');
  const [limit, setLimit] = useState(1000);
  const [selected, setSelected] = useState<number[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (open) {
      setName(group?.name ?? '');
      setLimit(group ? Math.round(fromUsd(group.capitalLimit)) : 1000);
      setSelected(group ? [...initialInstrumentIds] : []);
      setQuery('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, group]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return instruments;
    return instruments.filter(
      (i) => i.symbol.toLowerCase().includes(q) || i.name.toLowerCase().includes(q),
    );
  }, [instruments, query]);

  const toggle = (id: number) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const valid = name.trim().length > 0 && limit > 0;

  const handleSave = () => {
    if (!valid) return;
    onSave(name.trim(), toUsd(limit), selected);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{group ? 'Modifica gruppo' : 'Nuovo gruppo'}</DialogTitle>
          <DialogDescription>
            I gruppi definiscono il tetto di capitale entro cui l'Agent può operare.
            Il limite è un hard cap: raggiunto il tetto, nessun nuovo ordine.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div>
            <Label htmlFor="group-name" className="overline mb-2 block">Nome gruppo</Label>
            <Input
              id="group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Es. Importantissimo"
              maxLength={40}
            />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <Label htmlFor="group-limit" className="overline">Limite massimo investibile</Label>
              <span className="font-mono text-ticker text-agent tabular-nums">
                {formatCurrency(limit, displayCurrency, 0)}
              </span>
            </div>
            <Slider
              id="group-limit"
              min={LIMIT_STEP}
              max={LIMIT_MAX}
              step={LIMIT_STEP}
              value={[Math.min(limit, LIMIT_MAX)]}
              onValueChange={([v]) => setLimit(v)}
            />
            <div className="mt-2 flex items-center gap-2">
              <Input
                type="number"
                min={LIMIT_STEP}
                step={LIMIT_STEP}
                value={limit}
                onChange={(e) => setLimit(Math.max(0, Number(e.target.value) || 0))}
                className="w-32 tabular-nums"
                aria-label="Limite in valuta di conto"
              />
              <span className="text-caption text-text-2">
                Hard cap — l'Agent non supererà mai questo importo.
              </span>
            </div>
          </div>

          <div>
            <Label className="overline mb-2 block">
              Strumenti del gruppo ({selected.length})
            </Label>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filtra strumenti…"
              className="mb-2 font-mono"
            />
            <div className="max-h-44 overflow-y-auto rounded-lg border border-hairline bg-bg-0 p-2">
              <div className="flex flex-wrap gap-1.5">
                {filtered.map((inst) => {
                  const active = selected.includes(inst.instrumentId);
                  return (
                    <button
                      key={inst.instrumentId}
                      type="button"
                      onClick={() => toggle(inst.instrumentId)}
                      className={cn(
                        'flex items-center gap-1.5 rounded-full border px-2 py-1 text-micro font-medium transition-colors',
                        active
                          ? 'border-agent/60 bg-agent/15 text-agent'
                          : 'border-hairline bg-bg-2 text-text-1 hover:border-hairline-strong hover:text-text-0',
                      )}
                    >
                      <InstrumentAvatar symbol={inst.symbol} size={16} />
                      <span className="font-mono">{inst.symbol}</span>
                      {active && <Check className="h-3 w-3" aria-hidden />}
                    </button>
                  );
                })}
                {filtered.length === 0 && (
                  <span className="px-2 py-1 text-caption text-text-2">Nessuno strumento trovato.</span>
                )}
              </div>
            </div>
            <p className="mt-1.5 text-caption text-text-2">
              Gli strumenti assegnati vengono proposti quando crei una regola in questo gruppo.
            </p>
          </div>
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-lg border border-hairline-strong px-4 py-2 text-body-strong text-text-0 transition-colors hover:bg-bg-2"
          >
            Annulla
          </button>
          <button
            type="button"
            disabled={!valid}
            onClick={handleSave}
            className="rounded-lg bg-agent px-4 py-2 text-body-strong text-bg-0 transition-colors hover:bg-agent/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {group ? 'Salva modifiche' : 'Crea gruppo'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
