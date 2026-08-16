/**
 * Layout — app shell completa (pattern B: nested routes + <Outlet/>).
 * Sidebar fissa + Header sticky + content max-w 1440px + MobileTabBar.
 * Gestisce ⌘K globale, classe densità e footer con disclaimer.
 */
import { useEffect, useState } from 'react';
import { Outlet } from 'react-router';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { CommandPalette } from './CommandPalette';
import { MobileTabBar } from './MobileTabBar';
import { useAppData } from '@/lib/data/store';
import { cn } from '@/lib/utils';

export function Layout() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { density } = useAppData();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if (e.key === 'Escape') setPaletteOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={cn('min-h-[100dvh] bg-bg-0', density === 'compact' ? 'density-compact' : 'density-comfy')}>
      <Sidebar />
      <div className="flex min-h-[100dvh] flex-col md:pl-16 xl:pl-[232px]">
        <Header onOpenPalette={() => setPaletteOpen(true)} />
        <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 pb-24 pt-4 md:px-6 md:pb-8">
          <Outlet />
        </main>
        <footer className="mx-auto w-full max-w-[1440px] px-4 pb-20 md:px-6 md:pb-4">
          <p className="text-caption text-text-2">
            Dati: eToro Public API · Strumento non affiliato ad eToro · Non costituisce consulenza finanziaria.
            Il trading comporta rischio di perdita del capitale.
          </p>
        </footer>
      </div>
      <MobileTabBar />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
