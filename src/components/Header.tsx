/**
 * Header — barra superiore 56px sticky, bg-0 80% + blur 12px (design.md).
 * Contiene: titolo pagina, search ⌘K, chip EUR/USD, toggle valuta di display,
 * density toggle, bell notifiche, badge ambiente REAL, chip account.
 */
import { useLocation } from 'react-router';
import { Bell, Rows3, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppData } from '@/lib/data/store';
import { formatFxRate, formatPercent } from '@/lib/format';
import { maskKey } from '@/lib/settings';
import { StatusDot } from './shared/StatusDot';

const TITLES: Record<string, string> = {
  '/': 'Panoramica',
  '/mercati': 'Mercati',
  '/portfolio': 'Portfolio',
  '/agent': 'eToro Agent',
  '/fx': 'EUR/USD',
  '/impostazioni': 'Impostazioni',
};

export function Header({ onOpenPalette }: { onOpenPalette(): void }) {
  const location = useLocation();
  const {
    fxRate, displayCurrency, setDisplayCurrency, density, setDensity,
    settings, logs, realExecutionActive,
  } = useAppData();

  const title = TITLES[location.pathname] ?? 'Torri';
  const unread = logs.filter((l) => l.level === 'warn' || l.level === 'error').length;
  const isReal = settings.mode === 'live' && settings.live.environment === 'real';

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-hairline bg-bg-0/80 px-4 backdrop-blur-[12px] md:px-6">
      <h1 className="font-display text-title text-text-0">{title}</h1>

      <div className="flex-1" />

      {/* Search ⌘K */}
      <button
        onClick={onOpenPalette}
        className="hidden items-center gap-2 rounded-lg border border-hairline bg-bg-1 px-3 py-1.5 text-caption text-text-2 transition-colors hover:border-hairline-strong hover:text-text-1 sm:flex"
      >
        <Search className="h-3.5 w-3.5" aria-hidden />
        <span className="font-mono">Cerca strumenti…</span>
        <kbd className="rounded border border-hairline bg-bg-2 px-1 font-mono text-[10px] text-text-2">⌘K</kbd>
      </button>
      <button
        onClick={onOpenPalette}
        aria-label="Cerca"
        className="rounded-lg border border-hairline bg-bg-1 p-2 text-text-2 transition-colors hover:text-text-1 sm:hidden"
      >
        <Search className="h-4 w-4" aria-hidden />
      </button>

      {/* EUR/USD mini-quote chip */}
      {fxRate && (
        <div className="hidden items-center gap-1.5 rounded-lg border border-hairline bg-bg-1 px-2.5 py-1.5 font-mono text-ticker md:flex">
          <span className="text-text-2">EUR/USD</span>
          <span className="text-text-0 tabular-nums">{formatFxRate(fxRate.rate)}</span>
          <span className={cn('tabular-nums', fxRate.changePct >= 0 ? 'text-gain' : 'text-loss')}>
            {formatPercent(fxRate.changePct, 2)}
          </span>
        </div>
      )}

      {/* Currency toggle EUR/USD */}
      <div className="grid grid-cols-2 rounded-lg border border-hairline bg-bg-1 p-0.5">
        {(['EUR', 'USD'] as const).map((c) => (
          <button
            key={c}
            onClick={() => setDisplayCurrency(c)}
            className={cn(
              'rounded-md px-2 py-1 text-micro font-medium transition-colors',
              displayCurrency === c ? 'bg-bg-3 text-text-0' : 'text-text-2 hover:text-text-1',
            )}
          >
            {c}
          </button>
        ))}
      </div>

      {/* Density toggle */}
      <button
        onClick={() => setDensity(density === 'comfy' ? 'compact' : 'comfy')}
        title={density === 'comfy' ? 'Densità: Comoda → Compatta' : 'Densità: Compatta → Comoda'}
        className={cn(
          'hidden rounded-lg border border-hairline p-2 transition-colors lg:block',
          density === 'compact' ? 'bg-bg-3 text-text-0' : 'bg-bg-1 text-text-2 hover:text-text-1',
        )}
      >
        <Rows3 className="h-4 w-4" aria-hidden />
      </button>

      {/* Bell */}
      <button
        aria-label="Notifiche"
        className="relative rounded-lg border border-hairline bg-bg-1 p-2 text-text-2 transition-colors hover:text-text-1"
      >
        <Bell className="h-4 w-4" aria-hidden />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-loss px-1 text-[10px] font-semibold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {/* Environment badge */}
      <span
        className={cn(
          'rounded-md px-2 py-1 text-micro font-semibold uppercase tracking-wide',
          isReal ? 'border border-loss text-loss' : 'border border-warn text-warn',
        )}
      >
        {isReal ? 'Real' : 'Live'}
      </span>

      {/* Account chip */}
      <div className="hidden items-center gap-2 rounded-lg border border-hairline bg-bg-1 px-2.5 py-1.5 xl:flex">
        <StatusDot variant={realExecutionActive ? 'error' : 'live'} />
        <span className="font-mono text-micro text-text-1">
          {maskKey(settings.live.userKey)}
        </span>
      </div>
    </header>
  );
}
