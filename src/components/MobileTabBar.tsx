/**
 * MobileTabBar — bottom tab bar <768px con 5 voci (design.md):
 * Panoramica, Portfolio, Agent, Autopilot, Altro (→ Mercati/FX/Impostazioni).
 */
import { useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { Bot, CandlestickChart, LayoutDashboard, Menu, Radar, Repeat, Settings, Wallet, X } from 'lucide-react';
import { cn } from '@/lib/utils';

const TABS = [
  { to: '/', label: 'Panoramica', icon: LayoutDashboard },
  { to: '/portfolio', label: 'Portfolio', icon: Wallet },
  { to: '/agent', label: 'Agent', icon: Bot },
  { to: '/autopilot', label: 'Autopilot', icon: Radar },
];

const MORE = [
  { to: '/mercati', label: 'Mercati', icon: CandlestickChart },
  { to: '/fx', label: 'EUR/USD', icon: Repeat },
  { to: '/impostazioni', label: 'Impostazioni', icon: Settings },
];

export function MobileTabBar() {
  const [moreOpen, setMoreOpen] = useState(false);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // Senza questo, aprendo una voce del menu la tab bar non segnala nulla come attivo.
  const moreActive = MORE.some((item) => pathname.startsWith(item.to));

  return (
    <>
      {moreOpen && (
        <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setMoreOpen(false)}>
          <div
            className="absolute bottom-16 left-4 right-4 rounded-xl border border-hairline-strong bg-bg-1 p-2"
            onClick={(e) => e.stopPropagation()}
          >
            {MORE.map((m) => (
              <button
                key={m.to}
                onClick={() => { setMoreOpen(false); navigate(m.to); }}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-body-strong transition-colors hover:bg-bg-2',
                  pathname.startsWith(m.to) ? 'bg-bg-2 text-gain' : 'text-text-0',
                )}
              >
                <m.icon className={cn('h-5 w-5', pathname.startsWith(m.to) ? 'text-gain' : 'text-text-1')} aria-hidden />
                {m.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex h-16 items-stretch border-t border-hairline bg-bg-0/95 backdrop-blur-[12px] md:hidden">
        {TABS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              cn(
                'flex flex-1 flex-col items-center justify-center gap-1 text-micro transition-colors',
                isActive ? 'text-gain' : 'text-text-2',
              )
            }
          >
            <Icon className="h-5 w-5" aria-hidden />
            {label}
          </NavLink>
        ))}
        <button
          onClick={() => setMoreOpen((v) => !v)}
          className={cn(
            'flex flex-1 flex-col items-center justify-center gap-1 text-micro transition-colors',
            moreOpen || moreActive ? 'text-gain' : 'text-text-2',
          )}
        >
          {moreOpen ? <X className="h-5 w-5" aria-hidden /> : <Menu className="h-5 w-5" aria-hidden />}
          Altro
        </button>
      </nav>
    </>
  );
}
