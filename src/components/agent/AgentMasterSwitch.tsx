import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { AgentEngine } from '@/lib/agent/engine';

export function AgentMasterSwitch({ agent, realExecutionActive, disabled, onChanged, label = 'Agent' }: {
  agent: AgentEngine;
  realExecutionActive: boolean;
  disabled?: boolean;
  onChanged?: (enabled: boolean) => void;
  label?: string;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const setEnabled = (enabled: boolean) => {
    if (!enabled) {
      agent.setMasterEnabled(false);
      onChanged?.(false);
      return;
    }
    if (realExecutionActive) {
      setConfirmOpen(true);
      return;
    }
    agent.setMasterEnabled(true);
    onChanged?.(true);
  };
  const confirm = () => {
    agent.setMasterEnabled(true);
    onChanged?.(true);
    setConfirmOpen(false);
  };
  return (
    <>
      <label className="flex items-center gap-2">
        <span className="text-label text-text-1">{label}</span>
        <Switch checked={agent.masterEnabled} onCheckedChange={setEnabled} disabled={disabled} className="data-[state=checked]:bg-agent" aria-label="Master switch Agent" />
      </label>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Abilitare l’Agent sul conto reale?</AlertDialogTitle>
            <AlertDialogDescription>Il master switch inizierà a valutare le regole sui dati live. Con auto-esecuzione attiva e permessi di scrittura, una regola può inviare ordini reali entro i limiti configurati.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annulla</AlertDialogCancel>
            <AlertDialogAction onClick={confirm} className="bg-loss text-white hover:bg-loss/90">Confermo, abilita Agent</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
