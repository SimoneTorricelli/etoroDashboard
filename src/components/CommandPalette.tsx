/**
 * CommandPalette — ⌘K fuzzy search su strumenti, pagine e azioni (design.md).
 * Modale bg-1, risultati mono, navigabile da tastiera (cmdk).
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Command } from 'cmdk';
import {
  Bot, CandlestickChart, FileUp, LayoutDashboard, Plus, Repeat, Settings, Wallet,
} from 'lucide-react';
import { useAppData } from '@/lib/data/store';
import { InstrumentAvatar } from './shared/InstrumentAvatar';
import type { Instrument } from '@/lib/data/types';

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange(open: boolean): void;
}

const PAGES = [
  { to: '/', label: 'Panoramica', icon: LayoutDashboard },
  { to: '/mercati', label: 'Mercati', icon: CandlestickChart },
  { to: '/portfolio', label: 'Portfolio', icon: Wallet },
  { to: '/agent', label: 'eToro Agent', icon: Bot },
  { to: '/fx', label: 'Modulo EUR/USD', icon: Repeat },
  { to: '/impostazioni', label: 'Impostazioni', icon: Settings },
];

const ACTIONS = [
  { to: '/agent?new=rule', label: 'Crea regola Agent', icon: Plus },
  { to: '/impostazioni?import=csv', label: 'Importa CSV Account Statement', icon: FileUp },
  { to: '/fx', label: 'Vai a FX (EUR/USD)', icon: Repeat },
];

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { searchInstruments } = useAppData();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Instrument[]>([]);

  /* ⌘K / Ctrl+K globale gestito da Layout; qui solo ricerca */
  const close = (v: boolean) => {
    if (!v) { setQuery(''); setResults([]); }
    onOpenChange(v);
  };

  useEffect(() => {
    let cancelled = false;
    void searchInstruments(query).then((r) => { if (!cancelled) setResults(r); });
    return () => { cancelled = true; };
  }, [query, searchInstruments]);

  const go = (to: string) => {
    close(false);
    navigate(to);
  };

  const grouped = useMemo(() => results.slice(0, 8), [results]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]"
      onClick={() => close(false)}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-hairline-strong bg-bg-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <Command label="Command palette" shouldFilter={false}>
          <div className="border-b border-hairline px-4">
            <Command.Input
              value={query}
              onValueChange={setQuery}
              placeholder="Cerca strumenti, pagine, azioni…"
              autoFocus
              className="h-12 w-full bg-transparent font-mono text-ticker text-text-0 outline-none placeholder:text-text-2"
            />
          </div>
          <Command.List className="max-h-80 overflow-y-auto p-2">
            {grouped.length > 0 && (
              <Command.Group heading={<GroupLabel>Strumenti</GroupLabel>}>
                {grouped.map((inst) => (
                  <PaletteItem
                    key={inst.instrumentId}
                    onSelect={() => go(`/mercati?instrument=${inst.instrumentId}`)}
                  >
                    <InstrumentAvatar symbol={inst.symbol} size={24} imageUrl={inst.imageUrl} backgroundColor={inst.imageBackgroundColor} textColor={inst.imageTextColor} />
                    <span className="font-mono text-ticker text-text-0">{inst.symbol}</span>
                    <span className="truncate text-caption text-text-1">{inst.name}</span>
                  </PaletteItem>
                ))}
              </Command.Group>
            )}
            <Command.Group heading={<GroupLabel>Pagine</GroupLabel>}>
              {PAGES.filter((p) => match(p.label, query)).map((p) => (
                <PaletteItem key={p.to} onSelect={() => go(p.to)}>
                  <p.icon className="h-4 w-4 text-text-2" aria-hidden />
                  <span className="text-body text-text-0">{p.label}</span>
                </PaletteItem>
              ))}
            </Command.Group>
            <Command.Group heading={<GroupLabel>Azioni</GroupLabel>}>
              {ACTIONS.filter((a) => match(a.label, query)).map((a) => (
                <PaletteItem key={a.label} onSelect={() => go(a.to)}>
                  <a.icon className="h-4 w-4 text-agent" aria-hidden />
                  <span className="text-body text-text-0">{a.label}</span>
                </PaletteItem>
              ))}
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

function match(label: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  // fuzzy semplice: tutti i caratteri della query in ordine
  let i = 0;
  for (const ch of label.toLowerCase()) if (ch === q[i]) i++;
  return i >= q.length;
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <span className="px-2 text-micro font-medium uppercase tracking-wide text-text-2">{children}</span>;
}

function PaletteItem({ children, onSelect }: { children: React.ReactNode; onSelect(): void }) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-body text-text-1 transition-colors data-[selected=true]:bg-bg-3 data-[selected=true]:text-text-0"
    >
      {children}
    </Command.Item>
  );
}
