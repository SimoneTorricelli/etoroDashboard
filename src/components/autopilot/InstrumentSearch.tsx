/**
 * Ricerca nel catalogo eToro. Sostituisce la digitazione a mano del ticker:
 * i simboli interni di eToro non coincidono sempre con quelli di borsa, quindi
 * si sceglie dalla lista reale invece di indovinare.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { autopilot, type InstrumentHit } from '@/lib/agent/autopilot-api';

interface Props {
  /** Simboli già presenti, per marcarli come aggiunti. */
  existing: string[];
  onPick: (hit: InstrumentHit) => void;
}

export function InstrumentSearch({ existing, onPick }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<InstrumentHit[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) { setResults(null); return; }
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        setResults((await autopilot.searchInstruments(term)).results);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [query]);

  const owned = new Set(existing.map((item) => item.toUpperCase()));

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-2" />
        <Input
          className="pl-9"
          placeholder="Cerca su eToro: nome o ticker (es. Apple, S&P 500, Bitcoin, gold)"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {loading && <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-text-2" />}
      </div>

      {results && results.length === 0 && !loading && (
        <p className="text-xs text-text-1">Nessun risultato nel catalogo eToro per «{query}».</p>
      )}

      {results && results.length > 0 && (
        <div className="max-h-64 space-y-1 overflow-auto rounded-lg border border-hairline bg-bg-0 p-1">
          {results.map((hit) => {
            const added = hit.aliases.some((alias) => owned.has(alias));
            return (
              <div key={hit.instrumentId} className="flex items-center justify-between gap-2 rounded-md p-2 hover:bg-bg-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-text-0">
                    <span className="font-medium">{hit.symbol}</span>
                    <span className="text-text-1"> · {hit.name}</span>
                  </p>
                  <p className="text-[11px] text-text-2">
                    #{hit.instrumentId}
                    {hit.assetClass ? ` · ${hit.assetClass}` : ''}
                    {hit.price ? ` · ${hit.price} ${hit.currency}` : ''}
                  </p>
                </div>
                {added ? (
                  <Badge variant="outline" className="shrink-0">già presente</Badge>
                ) : (
                  <Button size="sm" variant="ghost" className="shrink-0" onClick={() => onPick(hit)}>
                    <Plus className="size-4" /> Aggiungi
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
