/**
 * Sparkline — SVG polyline 1.5px, colore piatto per segno (verde/rosso),
 * draw-in 600ms al primo mount, end-dot pulsante opzionale quando live.
 */
import { useId, useMemo } from 'react';
import { cn } from '@/lib/utils';

export interface SparklineProps {
  /** Serie di valori (min 2 punti per disegnare). */
  data: number[];
  width?: number;
  height?: number;
  /** Forza il colore indipendentemente dal segno. */
  color?: string;
  /** Mostra il dot pulsante sull'ultimo punto. */
  live?: boolean;
  className?: string;
}

export function Sparkline({ data, width = 80, height = 28, color, live = false, className }: SparklineProps) {
  const id = useId();
  const { path, lastPoint, positive } = useMemo(() => {
    if (data.length < 2) return { path: '', lastPoint: null as { x: number; y: number } | null, positive: true };
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const stepX = width / (data.length - 1);
    const pad = 2;
    const pts = data.map((v, i) => ({
      x: i * stepX,
      y: pad + (1 - (v - min) / range) * (height - pad * 2),
    }));
    return {
      path: pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
      lastPoint: pts[pts.length - 1],
      positive: data[data.length - 1] >= data[0],
    };
  }, [data, width, height]);

  if (!path) {
    return <svg width={width} height={height} className={className} aria-hidden />;
  }

  const stroke = color ?? (positive ? '#00C390' : '#F4556B');

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cn('overflow-visible', className)} aria-hidden>
      <defs>
        <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.18" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${path} L${width},${height} L0,${height} Z`} fill={`url(#spark-${id})`} stroke="none" />
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={0}
        className="motion-safe:animate-[spark-draw_600ms_ease-out_1]"
      />
      {live && lastPoint && (
        <circle cx={lastPoint.x} cy={lastPoint.y} r="2" fill={stroke} className="animate-pulse-dot motion-reduce:animate-none" />
      )}
      <style>{`@keyframes spark-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }`}</style>
    </svg>
  );
}
