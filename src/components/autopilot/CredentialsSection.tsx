/**
 * Credenziali dell'Autopilot: si inseriscono qui e finiscono nel vault cifrato
 * su D1, così restano disponibili al cron anche a browser chiuso.
 *
 * I valori non tornano mai indietro dal server: si vedono solo presenza,
 * provenienza e ultime quattro cifre.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Eraser, KeyRound, Send, Trash2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { AgentTokenGenerator } from '@/components/autopilot/AgentTokenGenerator';
import { autopilot, type CredentialKey, type CredentialStatus } from '@/lib/agent/autopilot-api';

const GROUPS: Array<{ title: string; description: string; keys: CredentialKey[] }> = [
  {
    title: 'eToro',
    description: 'Chiavi del tuo account, dal portale sviluppatori eToro. Il token Agent Portfolio serve solo per la modalità live.',
    keys: ['etoroApiKey', 'etoroUserKey', 'etoroAgentToken'],
  },
  {
    title: 'Modello AI',
    description: 'Tutte opzionali: Cloudflare Workers AI è già attivo e gratuito, senza chiavi. Queste servono solo come alternative o riserva.',
    keys: ['geminiApiKey', 'groqApiKey', 'openrouterApiKey'],
  },
  {
    title: 'Notifiche',
    description: 'Se compili bot token e chat id, l\'agente ti invia il piano appena attivato e ti aggiorna su run, ordini, blocchi e freeze.',
    keys: ['telegramBotToken', 'telegramChatId', 'notifyWebhookUrl'],
  },
  {
    title: 'Fonti dati opzionali',
    description: 'Le fonti senza chiave sono già attive. Queste aggiungono news e fondamentali.',
    keys: ['finnhubKey', 'marketauxKey', 'fmpKey'],
  },
];

interface Props {
  credentials: CredentialStatus[];
  notificationsActive: boolean;
  onChanged: () => Promise<void> | void;
}

export function CredentialsSection({ credentials, notificationsActive, onChanged }: Props) {
  const [draft, setDraft] = useState<Partial<Record<CredentialKey, string>>>({});
  const [busy, setBusy] = useState(false);

  const byKey = new Map(credentials.map((item) => [item.key, item]));
  const pending = Object.entries(draft).filter(([, value]) => value !== undefined && value !== '');

  const run = async (label: string, task: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await task();
      toast.success(label);
      await onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const save = () => run('Credenziali salvate nel vault', async () => {
    await autopilot.saveCredentials(Object.fromEntries(pending) as Partial<Record<CredentialKey, string>>);
    setDraft({});
  });

  const remove = (key: CredentialKey) => run('Credenziale rimossa', async () => {
    await autopilot.saveCredentials({ [key]: '' } as Partial<Record<CredentialKey, string>>);
    setDraft((current) => ({ ...current, [key]: undefined }));
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="size-4" /> Credenziali dell'agente</CardTitle>
        <CardDescription>
          Salvate cifrate (AES-GCM) sul database del Worker, non nel browser. Servono al cron, che gira quando il sito è chiuso.
          I valori inseriti non sono più rileggibili: puoi solo sovrascriverli.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {GROUPS.map((group) => (
          <div key={group.title} className="space-y-3">
            <div>
              <h3 className="text-sm font-medium">{group.title}</h3>
              <p className="text-xs text-text-1">{group.description}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {group.keys.map((key) => {
                const status = byKey.get(key);
                if (!status) return null;
                return (
                  <div key={key} className="grid gap-1.5">
                    <Label htmlFor={`cred-${key}`} className="flex flex-wrap items-center gap-2">
                      {status.label}
                      {status.required && !status.configured && <Badge variant="destructive" className="text-[10px]">obbligatoria</Badge>}
                      {status.configured && (
                        <Badge variant={status.origin === 'vault' ? 'default' : 'secondary'} className="gap-1 text-[10px]">
                          <CheckCircle2 className="size-3" />
                          {status.origin === 'vault' ? 'dashboard' : 'worker secret'} {status.hint}
                        </Badge>
                      )}
                    </Label>
                    <div className="flex gap-1.5">
                      <Input
                        id={`cred-${key}`}
                        type="password"
                        autoComplete="off"
                        placeholder={status.configured ? 'sovrascrivi…' : 'non configurata'}
                        value={draft[key] ?? ''}
                        onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
                      />
                      {status.configured && status.origin === 'vault' && (
                        <Button variant="ghost" size="icon" disabled={busy} title="Rimuovi dal vault" onClick={() => void remove(key)}>
                          <Eraser className="size-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {group.title === 'eToro' && <AgentTokenGenerator onGenerated={onChanged} />}
            <Separator />
          </div>
        ))}

        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy || pending.length === 0} onClick={() => void save()}>
            Salva {pending.length > 0 && `(${pending.length})`}
          </Button>
          <Button
            variant="outline"
            disabled={busy || !notificationsActive}
            onClick={() => void run('Notifica di prova inviata', () => autopilot.testNotifications())}
          >
            <Send className="size-4" /> Invia notifica di prova
          </Button>
          <Button
            variant="ghost"
            className="text-destructive"
            disabled={busy}
            onClick={() => void run('Vault svuotato', () => autopilot.clearCredentials())}
          >
            <Trash2 className="size-4" /> Svuota vault
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
