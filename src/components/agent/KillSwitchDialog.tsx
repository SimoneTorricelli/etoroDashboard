/**
 * KillSwitchDialog — conferma a due passi per il kill switch (design/agent.md):
 * strip rossa, copy esplicita, input mono in cui digitare STOP e bottone
 * rosso press-and-hold 800ms con barra di avanzamento.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { OctagonX } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const HOLD_MS = 800;

export interface KillSwitchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEngage: () => void;
}

export function KillSwitchDialog({ open, onOpenChange, onEngage }: KillSwitchDialogProps) {
  const [typed, setTyped] = useState('');
  const [progress, setProgress] = useState(0);
  const rafRef = useRef(0);
  const startRef = useRef(0);

  const stopHold = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    setProgress(0);
  }, []);

  useEffect(() => stopHold, [stopHold]);

  const handleOpenChange = (o: boolean) => {
    if (!o) {
      setTyped('');
      stopHold();
    }
    onOpenChange(o);
  };

  const ready = typed.trim().toUpperCase() === 'STOP';

  const startHold = () => {
    if (!ready) return;
    startRef.current = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - startRef.current) / HOLD_MS);
      setProgress(t);
      if (t >= 1) {
        onEngage();
        handleOpenChange(false);
        return;
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-md" showCloseButton>
        {/* strip rossa */}
        <div className="bg-loss/15 border-b border-loss/40 px-6 py-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-loss">
              <OctagonX className="h-5 w-5" aria-hidden />
              Kill switch — Interrompi tutto
            </DialogTitle>
            <DialogDescription className="text-text-1">
              Interrompi immediatamente tutte le regole e cancella la coda di conferma.
              Le posizioni aperte non verranno chiuse.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="space-y-4 px-6 pb-6 pt-2">
          <div>
            <label htmlFor="kill-confirm" className="overline mb-2 block">
              Digita STOP per confermare
            </label>
            <Input
              id="kill-confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="STOP"
              autoComplete="off"
              className="font-mono uppercase tracking-widest"
            />
          </div>

          <button
            type="button"
            disabled={!ready}
            onPointerDown={startHold}
            onPointerUp={stopHold}
            onPointerLeave={stopHold}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') startHold();
            }}
            onKeyUp={stopHold}
            className={cn(
              'relative w-full select-none overflow-hidden rounded-lg border px-4 py-3 text-body-strong transition-colors',
              ready
                ? 'border-loss/60 bg-loss/10 text-loss hover:bg-loss/15'
                : 'cursor-not-allowed border-hairline bg-bg-2 text-text-2',
            )}
          >
            <span
              className="absolute inset-y-0 left-0 bg-loss/25 transition-none"
              style={{ width: `${progress * 100}%` }}
              aria-hidden
            />
            <span className="relative">
              {ready ? 'Tieni premuto per interrompere tutto' : 'Pulsante bloccato'}
            </span>
          </button>
          <p className="text-caption text-text-2">
            Azione immediata e definitiva per questa sessione: l'Agent si fermerà e
            servirà un riavvio manuale.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
