/**
 * Selettore del profilo di strategia. Cambiare profilo riscrive in blocco i
 * guardrail correlati: è il modo rapido di configurare l'agente senza tarare
 * quindici numeri a mano.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Check, Loader2, Target } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { autopilot, type StrategyProfileInfo } from '@/lib/agent/autopilot-api';

interface Props {
  current: string;
  onApplied: () => Promise<void> | void;
}

export function ProfileSelector({ current, onApplied }: Props) {
  const [profiles, setProfiles] = useState<StrategyProfileInfo[]>([]);
  const [pending, setPending] = useState<StrategyProfileInfo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    autopilot.profiles()
      .then((result) => setProfiles(result.profiles))
      .catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
  }, []);

  const apply = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await autopilot.setProfile(pending.id);
      toast.success(`Profilo ${pending.label} applicato`);
      await onApplied();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base text-text-0">
          <Target className="size-4 text-agent" /> Profilo di strategia
        </CardTitle>
        <CardDescription className="text-text-1">
          Definisce in un colpo solo volatilità target, classi ammesse, numero di posizioni, disciplina di rotazione e soglia di
          congelamento. Puoi sempre ritoccare i singoli valori dopo averlo applicato.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {profiles.map((profile) => {
          const active = profile.id === current;
          return (
            <button
              key={profile.id}
              type="button"
              onClick={() => (active ? null : setPending(profile))}
              className={cn(
                'rounded-lg border p-3 text-left transition',
                active ? 'border-agent bg-agent/10' : 'border-hairline bg-bg-2/40 hover:border-hairline-strong',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-text-0">{profile.label}</span>
                {active && <Check className="ml-auto size-4 text-agent" />}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-text-1">{profile.summary}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                <Badge variant="outline" className="text-[10px]">vol {profile.targetVolPct[0]}–{profile.targetVolPct[1]}%</Badge>
                <Badge variant="outline" className="text-[10px]">max {profile.maxHoldings} titoli</Badge>
                <Badge variant="outline" className="text-[10px]">
                  crypto {profile.cryptoCap === 0 ? 'no' : `${(profile.cryptoCap * 100).toFixed(0)}%`}
                </Badge>
                <Badge variant="outline" className="text-[10px]">stop {(profile.drawdownStopPct * 100).toFixed(0)}%</Badge>
                {profile.watcherEnabled && <Badge variant="secondary" className="text-[10px]">watcher</Badge>}
              </div>
            </button>
          );
        })}
      </CardContent>

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Applicare il profilo {pending?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Sovrascrive i guardrail correlati: numero di posizioni, tetti per classe, cassa minima e massima, turnover, banda di
              ribilanciamento, confidence minima, stop drawdown, disciplina anti-churn, watcher e profilo di rischio testuale.
              Restano invariati budget, cadenza, universo e credenziali.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annulla</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void apply()}>
              {busy && <Loader2 className="size-4 animate-spin" />} Applica
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
