/**
 * InstrumentAvatar — quadrato 32px arrotondato con monogramma mono di 2 lettere
 * su sfondo pastel-dark derivato da hash del simbolo (design.md, logo-less).
 */
import { cn } from '@/lib/utils';

const PALETTE = [
  ['#1D3A2F', '#00C390'],
  ['#2A2A44', '#9B8CFF'],
  ['#3A2A1D', '#F5A623'],
  ['#1D2A3A', '#4C9AFF'],
  ['#3A1D26', '#F4556B'],
  ['#22333A', '#4CC9F0'],
  ['#2F3A1D', '#A3E635'],
  ['#331D3A', '#E879F9'],
];

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export interface InstrumentAvatarProps {
  symbol: string;
  size?: number;
  className?: string;
}

export function InstrumentAvatar({ symbol, size = 32, className }: InstrumentAvatarProps) {
  const [bg, fg] = PALETTE[hashCode(symbol) % PALETTE.length];
  const monogram = symbol.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || symbol.slice(0, 2).toUpperCase();
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-lg font-mono font-medium', className)}
      style={{
        width: size,
        height: size,
        backgroundColor: bg,
        color: fg,
        fontSize: Math.max(9, Math.round(size * 0.34)),
      }}
      aria-hidden
    >
      {monogram}
    </span>
  );
}
