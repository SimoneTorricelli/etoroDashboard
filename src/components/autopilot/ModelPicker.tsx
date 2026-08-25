/**
 * Selezione dei provider AI e dei relativi modelli.
 *
 * I provider indicano soltanto i canali abilitati. Il Worker costruisce poi
 * una priorità globale dei modelli per qualità del reasoning, senza favorire
 * il provider mostrato per primo.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Cpu, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { autopilot, type LlmProvider } from '@/lib/agent/autopilot-api';

interface FreeModel {
  id: string;
  name: string;
  contextLength: number | null;
  recommendedRank?: number | null;
  fit?: string | null;
  reasoning?: boolean;
  structuredOutput?: boolean;
}

interface Props {
  providers: string[];
  models: Record<string, string[]>;
  onChange: (patch: { llmProviders?: string[]; llmModels?: Record<string, string[]> }) => void;
}

export function ModelPicker({ providers, models, onChange }: Props) {
  const [catalog, setCatalog] = useState<LlmProvider[]>([]);
  const [freeModels, setFreeModels] = useState<FreeModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    autopilot.freeModels()
      .then((result) => { setCatalog(result.providers ?? []); setFreeModels(result.models); })
      .catch(() => { /* il catalogo si carica su richiesta */ });
  }, []);

  const reload = async () => {
    setLoading(true);
    try {
      const result = await autopilot.freeModels();
      setCatalog(result.providers ?? []);
      setFreeModels(result.models);
      toast.success(`${result.models.length} modelli gratuiti su OpenRouter in questo momento`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const toggleProvider = (id: string) => {
    onChange({
      llmProviders: providers.includes(id) ? providers.filter((item) => item !== id) : [...providers, id],
    });
  };

  const setProviderModels = (provider: string, list: string[]) =>
    onChange({ llmModels: { ...models, [provider]: list } });

  const known: LlmProvider[] = catalog.length
    ? catalog
    : providers.map((id) => ({ id, label: id, note: '', needsKey: false, defaultModels: [] }));
  const inactive = known.filter((provider) => !providers.includes(provider.id));
  const filtered = (freeModels ?? []).filter((model) =>
    !filter || `${model.id} ${model.name}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-text-0">
            <Cpu className="size-4 text-agent" /> Provider AI
          </h3>
          <p className="text-xs leading-relaxed text-text-1">
            Priorità globale per capacità di reasoning: il modello più forte disponibile viene provato prima, anche se appartiene
            a un provider mostrato più sotto. Llama 70B resta soltanto un fallback tardivo.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Ricarica catalogo
        </Button>
      </div>

      <div className="space-y-2">
        {providers.map((providerId) => {
          const meta = known.find((item) => item.id === providerId);
          const list = models[providerId] ?? [];
          return (
            <div key={providerId} className="rounded-lg border border-hairline bg-bg-2/40 p-2.5">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="shrink-0">attivo</Badge>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-0">{meta?.label ?? providerId}</span>
                {meta?.needsKey && <Badge variant="secondary" className="shrink-0 text-[10px]">richiede chiave</Badge>}
                <Button variant="ghost" size="icon" className="size-7 text-loss" onClick={() => toggleProvider(providerId)}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              {meta?.note && <p className="mt-1 text-[11px] leading-relaxed text-text-1">{meta.note}</p>}

              <div className="mt-2 space-y-1">
                {list.map((model) => (
                  <div key={model} className="flex items-center gap-2 rounded-md bg-bg-1 px-2 py-1">
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-1">{model}</span>
                    <Button variant="ghost" size="icon" className="size-6 text-loss"
                      onClick={() => setProviderModels(providerId, list.filter((item) => item !== model))}>
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                ))}
                {list.length === 0 && (
                  <p className="text-[11px] text-text-2">Nessun modello indicato: verranno usati quelli predefiniti del provider.</p>
                )}
                {providerId === 'openrouter' && meta?.defaultModels?.length ? (
                  <p className="text-[11px] leading-relaxed text-text-2">
                    Priorità gratuita automatica: {meta.defaultModels.slice(0, 4).join(' → ')}.
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {inactive.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {inactive.map((provider) => (
            <Button key={provider.id} variant="outline" size="sm" onClick={() => toggleProvider(provider.id)}>
              <Plus className="size-3.5" /> {provider.label}
            </Button>
          ))}
        </div>
      )}

      {providers.includes('openrouter') && freeModels && (
        <div className="space-y-2 rounded-lg border border-hairline bg-bg-0 p-2">
          <p className="text-xs text-text-1">
            Modelli gratuiti disponibili ora su OpenRouter ({freeModels.length}). Il catalogo cambia spesso: quelli che aggiungi oggi
            potrebbero sparire fra qualche settimana.
          </p>
          <Input placeholder="Filtra per nome o id" value={filter} onChange={(event) => setFilter(event.target.value)} />
          <div className="max-h-52 space-y-1 overflow-auto">
            {filtered.slice(0, 60).map((model) => {
              const added = (models.openrouter ?? []).includes(model.id);
              return (
                <div key={model.id} className={cn('flex items-center justify-between gap-2 rounded-md p-1.5', !added && 'hover:bg-bg-2')}>
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 truncate text-xs text-text-0">
                      <span className="truncate">{model.name}</span>
                      {model.recommendedRank ? <Badge variant="secondary" className="shrink-0 text-[9px]">scelta {model.recommendedRank}</Badge> : null}
                    </p>
                    <p className="truncate font-mono text-[10px] text-text-2">
                      {model.id}{model.contextLength ? ` · ${(model.contextLength / 1000).toFixed(0)}k contesto` : ''}
                    </p>
                    {model.fit ? <p className="text-[10px] text-agent">{model.fit}{model.reasoning ? ' · reasoning' : ''}{model.structuredOutput ? ' · JSON' : ''}</p> : null}
                  </div>
                  {added ? (
                    <Badge variant="outline" className="shrink-0 text-[10px]">in uso</Badge>
                  ) : (
                    <Button variant="ghost" size="sm" className="shrink-0"
                      onClick={() => setProviderModels('openrouter', [...(models.openrouter ?? []), model.id])}>
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
