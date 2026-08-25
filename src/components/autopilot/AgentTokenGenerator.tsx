/**
 * Genera un nuovo token operativo per un Agent Portfolio esistente.
 *
 * Risolve il problema del token "perso": eToro lo mostra una sola volta, ma un
 * nuovo token si può sempre creare. Qui il valore non passa nemmeno dal
 * browser — il Worker lo genera e lo salva direttamente nel vault.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { KeyRound, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { autopilot, type AgentPortfolioSummary } from '@/lib/agent/autopilot-api';

interface Props {
  onGenerated: () => Promise<void> | void;
}

export function AgentTokenGenerator({ onGenerated }: Props) {
  const [portfolios, setPortfolios] = useState<AgentPortfolioSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const result = await autopilot.agentPortfolios();
      setPortfolios(result.portfolios);
      if (!result.portfolios.length) toast.info('Nessun Agent Portfolio trovato: creane uno dalla sezione Agent.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const generate = async (portfolio: AgentPortfolioSummary) => {
    setBusy(portfolio.id);
    try {
      const result = await autopilot.generateAgentToken(portfolio.id);
      toast.success(`Token generato e salvato nel vault (${result.hint})`);
      await onGenerated();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-hairline bg-bg-2/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="flex items-center gap-2 text-sm font-medium text-text-0">
            <KeyRound className="size-4 text-agent" /> Hai perso il token?
          </p>
          <p className="text-xs leading-relaxed text-text-1">
            Non è un problema: il token si rigenera quante volte vuoi. Il Worker ne crea uno nuovo e lo salva direttamente nel vault,
            senza mostrartelo. Il precedente resta valido finché non lo revochi da eToro.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Carica portfolio
        </Button>
      </div>

      {portfolios?.length === 0 && (
        <Alert>
          <AlertDescription className="text-text-1">
            Nessun Agent Portfolio sul tuo account. Creane uno dalla sezione Agent, poi torna qui.
          </AlertDescription>
        </Alert>
      )}

      {portfolios && portfolios.length > 0 && (
        <div className="space-y-2">
          {portfolios.map((portfolio) => (
            <div key={portfolio.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-hairline bg-bg-1 p-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text-0">{portfolio.name}</p>
                <p className="font-mono text-[11px] text-text-2">{portfolio.id}</p>
              </div>
              <div className="flex items-center gap-2">
                {portfolio.virtualBalanceUsd > 0 && (
                  <Badge variant="outline" className="tabular-nums">{portfolio.virtualBalanceUsd} USD virtuali</Badge>
                )}
                <Button size="sm" disabled={busy !== null} onClick={() => void generate(portfolio)}>
                  {busy === portfolio.id ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
                  Genera token
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
