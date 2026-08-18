import { useState } from 'react';
import { CheckCircle2, Eye, EyeOff, KeyRound, Trash2 } from 'lucide-react';
import { useAppData } from '@/lib/data/store';
import { maskKey } from '@/lib/settings';
import { Section } from './common';

export function ExternalDataSection() {
  const { settings, updateSettings } = useAppData();
  const [editing, setEditing] = useState(!settings.fmpApiKey);
  const [key, setKey] = useState(settings.fmpApiKey);
  const [visible, setVisible] = useState(false);

  const save = () => {
    updateSettings({ fmpApiKey: key.trim() });
    setEditing(false);
  };

  const remove = () => {
    setKey('');
    updateSettings({ fmpApiKey: '' });
    setEditing(true);
  };

  return (
    <Section id="dati-esterni" title="Dati esterni" description="Calendari societari non esposti dalla Public API eToro.">
      <div className="card-surface density-pad p-5">
        <div className="flex items-start gap-3">
          <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden />
          <div className="min-w-0 flex-1">
            <h3 className="text-body-strong text-text-0">Financial Modeling Prep · dividendi</h3>
            <p className="mt-1 text-caption leading-relaxed text-text-1">
              La chiave serve solo per leggere i dividendi già dichiarati. Rimane nel localStorage di questo browser e non viene inviata a eToro.
            </p>
            {settings.fmpApiKey && !editing ? (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <span className="rounded-lg border border-hairline bg-bg-1 px-3 py-2 font-mono text-caption text-text-1">API key {maskKey(settings.fmpApiKey)}</span>
                <span className="flex items-center gap-1 text-micro text-gain"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Configurata</span>
                <button type="button" onClick={() => { setKey(settings.fmpApiKey); setEditing(true); }} className="text-caption font-medium text-info hover:text-text-0">Sostituisci</button>
                <button type="button" onClick={remove} className="flex items-center gap-1 text-caption text-loss hover:text-text-0"><Trash2 className="h-3.5 w-3.5" aria-hidden /> Rimuovi</button>
              </div>
            ) : (
              <div className="mt-4 flex max-w-xl flex-col gap-2 sm:flex-row">
                <div className="relative min-w-0 flex-1">
                  <input
                    type={visible ? 'text' : 'password'}
                    value={key}
                    onChange={(event) => setKey(event.target.value)}
                    placeholder="FMP API key"
                    autoComplete="off"
                    className="h-10 w-full rounded-lg border border-hairline bg-bg-0 px-3 pr-10 font-mono text-caption text-text-0 outline-none focus:border-info"
                    aria-label="Financial Modeling Prep API key"
                  />
                  <button type="button" onClick={() => setVisible((current) => !current)} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-2 hover:text-text-0" aria-label={visible ? 'Nascondi chiave' : 'Mostra chiave'}>
                    {visible ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                  </button>
                </div>
                <button type="button" onClick={save} disabled={!key.trim()} className="h-10 rounded-lg bg-info px-4 text-caption font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">Salva</button>
                {settings.fmpApiKey ? <button type="button" onClick={() => { setKey(settings.fmpApiKey); setEditing(false); }} className="h-10 rounded-lg border border-hairline px-4 text-caption text-text-1">Annulla</button> : null}
              </div>
            )}
            <p className="mt-3 text-micro text-text-2">Il totale resta una stima lorda: ritenute, cambio e accredito effettivo vengono confermati solo dall’Account Statement eToro.</p>
          </div>
        </div>
      </div>
    </Section>
  );
}
