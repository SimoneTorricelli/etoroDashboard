/**
 * CsvImportSection — Impostazioni §3 "Import CSV" (design/settings.md):
 * dropzone drag&drop per l'Account Statement eToro, parsing via
 * importAccountStatementFile (@/lib/data/CsvImporter), anteprima risultato
 * (posizioni importate, righe saltate, errori, prime 5 righe) e azioni
 * "Usa per le analisi storiche" / "Scarta".
 */
import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, FileUp, Upload, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { importAccountStatementFile } from '@/lib/data/CsvImporter';
import type { CsvImportResult } from '@/lib/data/CsvImporter';
import { formatCurrency, formatPrice, formatUnits } from '@/lib/format';
import { Section } from './common';

const IMPORTED_KEY = 'torino.csv.positions.v1';

export function CsvImportSection() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [result, setResult] = useState<CsvImportResult | null>(null);
  const [fileName, setFileName] = useState('');
  const [saved, setSaved] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setParsing(true);
    setReadError(null);
    setSaved(false);
    setFileName(file.name);
    try {
      const res = await importAccountStatementFile(file);
      setResult(res);
    } catch {
      setReadError('Lettura del file fallita. Riprova con un CSV valido.');
      setResult(null);
    } finally {
      setParsing(false);
    }
  };

  const useForAnalysis = () => {
    if (!result) return;
    try {
      localStorage.setItem(IMPORTED_KEY, JSON.stringify({ importedAt: Date.now(), fileName, positions: result.positions }));
    } catch { /* storage pieno: ignora */ }
    setSaved(true);
  };

  return (
    <Section
      id="import"
      title="Import CSV"
      description="Importa l'Account Statement eToro per le analisi storiche."
    >
      {/* Dropzone */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Carica l'Account Statement eToro in formato CSV"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void handleFile(e.dataTransfer.files?.[0]);
        }}
        className={cn(
          'flex h-40 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed transition-colors duration-200',
          dragOver ? 'border-gain bg-gain-dim' : 'border-hairline-strong hover:border-info/50 hover:bg-bg-2/50',
        )}
      >
        <motion.div animate={dragOver ? { y: [-2, 2, -2] } : { y: 0 }} transition={{ duration: 0.4, repeat: dragOver ? Infinity : 0 }}>
          <Upload className={cn('h-7 w-7', dragOver ? 'text-gain' : 'text-text-2')} aria-hidden />
        </motion.div>
        <p className="mt-2 text-body-strong text-text-0">
          {parsing ? 'Analisi in corso…' : 'Trascina qui l\u2019Account Statement eToro (.csv) o clicca per scegliere'}
        </p>
        <p className="mt-1 text-micro text-text-2">
          Dove trovarlo: eToro → Portafoglio → Cronologia → Estratto conto → Esporta.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => { void handleFile(e.target.files?.[0]); e.target.value = ''; }}
        />
      </div>

      {readError && (
        <div className="flex items-center gap-2 rounded-lg border border-loss/30 bg-loss-dim px-3 py-2 text-caption text-loss">
          <XCircle className="h-4 w-4 shrink-0" aria-hidden /> {readError}
        </div>
      )}

      {/* Riepilogo parsing */}
      <AnimatePresence>
        {result && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.28 }}
            className="card-surface density-pad p-5"
          >
            <div className="flex items-center gap-2">
              <FileUp className="h-4 w-4 text-info" aria-hidden />
              <h3 className="text-body-strong text-text-0">{fileName}</h3>
            </div>
            <p className="mt-2 text-caption text-text-1 tabular-nums">
              <span className="text-gain">{result.positions.length} posizioni importate</span>
              {' · '}
              <span className="text-text-1">{result.skipped} righe saltate</span>
              {' · '}
              <span className={result.errors.length ? 'text-loss' : 'text-text-1'}>{result.errors.length} errori</span>
            </p>

            {result.errors.length > 0 && (
              <ul className="mt-2 space-y-1 rounded-lg border border-loss/20 bg-loss-dim p-3">
                {result.errors.map((e, i) => (
                  <li key={i} className="font-mono text-micro text-loss">{e}</li>
                ))}
              </ul>
            )}

            {result.positions.length > 0 && (
              <div className="mt-3 overflow-x-auto rounded-lg border border-hairline">
                <table className="w-full text-caption">
                  <thead>
                    <tr className="bg-bg-2 text-left text-micro text-text-2">
                      <th className="px-3 py-1.5 font-medium">Simbolo</th>
                      <th className="px-3 py-1.5 font-medium">Direzione</th>
                      <th className="px-3 py-1.5 text-right font-medium">Unità</th>
                      <th className="px-3 py-1.5 text-right font-medium">Prezzo apertura</th>
                      <th className="px-3 py-1.5 text-right font-medium">Investito</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline font-mono tabular-nums">
                    {result.positions.slice(0, 5).map((p) => (
                      <tr key={p.positionId}>
                        <td className="px-3 py-1.5 text-text-0">{p.symbol}</td>
                        <td className={cn('px-3 py-1.5', p.isBuy ? 'text-gain' : 'text-loss')}>{p.isBuy ? 'BUY' : 'SELL'}</td>
                        <td className="px-3 py-1.5 text-right text-text-1">{formatUnits(p.units)}</td>
                        <td className="px-3 py-1.5 text-right text-text-1">{formatPrice(p.openPrice)}</td>
                        <td className="px-3 py-1.5 text-right text-text-0">{formatCurrency(p.invested, 'USD')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {result.positions.length > 5 && (
                  <p className="border-t border-hairline px-3 py-1.5 text-micro text-text-2">
                    … e altre {result.positions.length - 5} posizioni.
                  </p>
                )}
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                onClick={useForAnalysis}
                disabled={result.positions.length === 0 || saved}
                className="rounded-lg bg-gain px-4 py-2 text-body-strong text-bg-0 transition-colors hover:bg-gain/90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Usa per le analisi storiche
              </button>
              <button
                onClick={() => { setResult(null); setSaved(false); }}
                className="rounded-lg border border-hairline px-4 py-2 text-body-strong text-text-1 transition-colors hover:bg-bg-2"
              >
                Scarta
              </button>
              {saved && (
                <span className="flex items-center gap-1 text-caption text-gain">
                  <CheckCircle2 className="h-4 w-4" aria-hidden /> Import salvato nel browser.
                </span>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Section>
  );
}
