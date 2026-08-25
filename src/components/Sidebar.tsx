/**
 * Sidebar — navigazione principale (design.md / App Shell).
 * ≥1200px: 232px con label. 768–1199px: rail icone 64px. <768px: nascosta
 * (navigazione via MobileTabBar).
 * Include: stato connessione Live/Real e footer links.
 */
import { NavLink, useNavigate } from 'react-router';
import {
  Bot,
  CandlestickChart,
  LayoutDashboard,
  Radar,
  Repeat,
  Settings,
  Wallet,
  Github,
  CircleHelp,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppData } from '@/lib/data/store';
import { StatusDot } from './shared/StatusDot';
import type { StatusDotVariant } from './shared/StatusDot';

const NAV = [
  { to: '/', label: 'Panoramica', icon: LayoutDashboard },
  { to: '/mercati', label: 'Mercati', icon: CandlestickChart },
  { to: '/portfolio', label: 'Portfolio', icon: Wallet },
  { to: '/agent', label: 'Agent', icon: Bot },
  { to: '/autopilot', label: 'Autopilot', icon: Radar },
  { to: '/fx', label: 'EUR/USD', icon: Repeat },
  { to: '/impostazioni', label: 'Impostazioni', icon: Settings },
];

const STATUS_VARIANT: Record<string, StatusDotVariant> = {
  connecting: 'warn',
  connected: 'live',
  disconnected: 'idle',
  error: 'error',
};

const STATUS_LABEL: Record<string, string> = {
  connecting: 'Connessione in corso…',
  connected: 'Connesso a eToro',
  disconnected: 'Disconnesso',
  error: 'Errore di connessione',
};

export function Sidebar() {
  const { status, quotes } = useAppData();
  const navigate = useNavigate();
  const liveCount = Object.keys(quotes).length;

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-16 flex-col border-r border-hairline bg-bg-0 md:flex xl:w-[232px]">
      {/* Logo */}
      <div className="flex h-14 items-center gap-2.5 border-b border-hairline px-3 xl:px-5">
        <img src="./logo.svg" alt="Torri" className="h-7 w-7 shrink-0" />
        <span className="hidden font-display text-title font-semibold text-text-0 xl:inline">Torri</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-4 xl:px-3">
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            title={label}
            className={({ isActive }) =>
              cn(
                'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-body-strong transition-colors',
                isActive ? 'bg-bg-3 text-text-0' : 'text-text-1 hover:bg-bg-2 hover:text-text-0',
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-gain" aria-hidden />
                )}
                <Icon className="h-5 w-5 shrink-0" aria-hidden />
                <span className="hidden xl:inline">{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Status card connessione */}
      <div className="border-t border-hairline p-3">
        <div className="hidden items-center gap-2 rounded-lg border border-hairline bg-bg-1 px-3 py-2.5 xl:flex">
          <StatusDot variant={STATUS_VARIANT[status] ?? 'idle'} />
          <div className="min-w-0">
            <div className="truncate text-micro font-medium text-text-0">{STATUS_LABEL[status] ?? status}</div>
            <div className="truncate text-micro text-text-2">
              {status === 'connected' ? `${liveCount} strumenti in streaming` : 'Verifica Impostazioni'}
            </div>
          </div>
        </div>
      </div>

      {/* Footer links */}
      <div className="space-y-1 border-t border-hairline p-3">
        <button
          onClick={() => navigate('/impostazioni')}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-caption text-text-2 transition-colors hover:text-text-1"
        >
          <CircleHelp className="h-4 w-4 shrink-0" aria-hidden />
          <span className="hidden xl:inline">Guida</span>
        </button>
        <a
          href="https://github.com"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-3 rounded-lg px-3 py-1.5 text-caption text-text-2 transition-colors hover:text-text-1"
        >
          <Github className="h-4 w-4 shrink-0" aria-hidden />
          <span className="hidden xl:inline">GitHub</span>
        </a>
      </div>
    </aside>
  );
}
