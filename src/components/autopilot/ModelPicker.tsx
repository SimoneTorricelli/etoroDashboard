/**
 * Selettore dei modelli AI.
 *
 * Il catalogo gratuito di OpenRouter cambia spesso: un id valido oggi può
 * sparire fra un mese. Qui si legge l'elenco live invece di fidarsi di una
 * lista scritta a mano.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Cpu, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { autopilot } from '@/lib/agent/autopilot-api';

interface FreeModel {
  id: string;
  name: string;
  contextLength: number | null;
}

interface Props {
  models: string[];
  onChange: (models: string[]) => void;
}

export function ModelPicker({ models, onChange }: Props) {
  const [available, setAvailable] = useState<FreeModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const result = await autopilot.freeModels();
      setAvailable(result.models);
      toast.success(`${result.models.length} modelli gratuiti disponibili ora su OpenRouter`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const move = (index: number, delta: number) => {
    const next = [...models];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const filtered = (available ?? []).filter((model) =>
    !filter || `${model.id} ${model.name}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-text-0">
            <Cpu className="size-4 text-agent" /> Modelli AI
          </h3>
          <p className="text-xs leading-relaxed text-text-1">
            Vengono provati in ordine: si usa il primo che risponde con una proposta valida. Tenerne più di uno protegge dai rate limit
            e dai modelli ritirati.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Modelli disponibili
        </Button>
      </div>

      <div className="space-y-1.5">
        {models.map((model, index) => (
          <div key={model} className="flex items-center gap-2 rounded-md border border-hairline bg-bg-2/40 px-2 py-1.5">
            <Badge variant="outline" className="shrink-0 tabular-nums">{index + 1}</Badge>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-0">{model}</span>
            <Button variant="ghost" size="icon" className="size-7" disabled={index === 0} onClick={() => move(index, -1)}>
              <ArrowUp className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="size-7" disabled={index === models.length - 1} onClick={() => move(index, 1)}>
              <ArrowDown className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="size-7 text-loss" onClick={() => onChange(models.filter((item) => item !== model))}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
        {models.length === 0 && <p className="text-xs text-loss">Nessun modello configurato: la run fallirà.</p>}
      </div>

      {available && (
        <div className="space-y-2 rounded-lg border border-hairline bg-bg-0 p-2">
          <Input placeholder="Filtra per nome o id" value={filter} onChange={(event) => setFilter(event.target.value)} />
          <div className="max-h-56 space-y-1 overflow-auto">
            {filtered.map((model) => {
              const added = models.includes(model.id);
              return (
                <div key={model.id} className="flex items-center justify-between gap-2 rounded-md p-1.5 hover:bg-bg-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs text-text-0">{model.name}</p>
                    <p className="truncate font-mono text-[10px] text-text-2">
                      {model.id}{model.contextLength ? ` · ${(model.contextLength / 1000).toFixed(0)}k contesto` : ''}
                    </p>
                  </div>
                  {added ? (
                    <Badge variant="outline" className="shrink-0 text-[10px]">in uso</Badge>
                  ) : (
                    <Button variant="ghost" size="sm" className="shrink-0"
                      disabled={models.length >= 8}
                      onClick={() => onChange([...models, model.id])}>
                      <Plus className="size-3.5" /> Aggiungi
                    </Button>
                  )}
                </div>
              );
            })}
            {filtered.length === 0 && <p className="p-2 text-xs text-text-1">Nessun modello corrisponde al filtro.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
