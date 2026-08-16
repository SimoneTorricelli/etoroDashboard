/**
 * FxGuide — "Guida rapida" (design/fx.md Row 4, span 12):
 * tre card informative (conversione eToro con esempio numerico, strategie
 * di prelievo, tasse e tempistiche). Su mobile diventano accordion.
 */
import { motion } from 'framer-motion';
import { ChevronDown, Coins, Landmark, Repeat } from 'lucide-react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';

const CARDS = [
  {
    id: 'conversione',
    icon: Repeat,
    title: 'Come funziona la conversione su eToro',
    body: [
      'Il conto eToro è in USD: depositi e prelievi in EUR passano sempre per una conversione valutaria. eToro applica un costo in pips (1 pip = 0,0001 su EUR/USD), tipicamente 50–150 pips in base al metodo di pagamento.',
      'Esempio: $10.000 convertiti a 1,0842 con 100 pips → tasso effettivo 1,0942, ricevi € 9.139 invece di € 9.222: costo ≈ € 92 (circa l\u20191%).',
      'Il costo è addebitato sul tasso, non come commissione separata: lo vedi solo confrontando il tasso effettivo con quello di mercato.',
    ],
  },
  {
    id: 'strategie',
    icon: Coins,
    title: 'Strategie di prelievo',
    body: [
      'Converti a tranche: prelevare il 25–50% subito e il resto a target riduce il rischio di convertire tutto al tasso sbagliato.',
      'Usa le bande target del grafico: definisci una zona di prelievo ideale e imposta un avviso automatico invece di controllare il cambio ogni giorno.',
      'Evita le conversioni in trend avverso: se l\u2019EUR si sta rafforzando (EUR/USD in salita), ogni settimana di attesa può costare più dei pips di commissione.',
    ],
  },
  {
    id: 'tasse',
    icon: Landmark,
    title: 'Tasse e tempistiche',
    body: [
      'Le plusvalenze valutarie possono essere rilevanti fiscalmente: la conversione USD→EUR può generare una plusvalenza tassabile. Consulta un professionista.',
      'I prelievi eToro richiedono in genere 1–2 giorni lavorativi di elaborazione, più i tempi del circuito bancario o della carta.',
      'Questo strumento non fornisce consulenza fiscale né finanziaria: verifica sempre la normativa del tuo Paese.',
    ],
  },
];

export function FxGuide() {
  return (
    <div className="card-surface density-pad p-5">
      <h2 className="text-title text-text-0">Guida rapida — costi e strategie</h2>

      {/* Desktop: 3 card affiancate */}
      <div className="mt-4 hidden gap-4 md:grid md:grid-cols-3">
        {CARDS.map((c, i) => (
          <motion.div
            key={c.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, delay: i * 0.06 }}
            className="rounded-lg border border-hairline bg-bg-2/50 p-4"
          >
            <div className="flex items-center gap-2">
              <c.icon className="h-4 w-4 text-info" aria-hidden />
              <h3 className="text-body-strong text-text-0">{c.title}</h3>
            </div>
            <ul className="mt-3 space-y-2">
              {c.body.map((p, j) => (
                <li key={j} className="text-caption text-text-1">{p}</li>
              ))}
            </ul>
          </motion.div>
        ))}
      </div>

      {/* Mobile: accordion */}
      <Accordion type="single" collapsible className="mt-3 md:hidden">
        {CARDS.map((c) => (
          <AccordionItem key={c.id} value={c.id} className="border-hairline">
            <AccordionTrigger className="text-body-strong text-text-0 hover:no-underline">
              <span className="flex items-center gap-2">
                <c.icon className="h-4 w-4 text-info" aria-hidden />
                {c.title}
                <ChevronDown className="hidden" aria-hidden />
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <ul className="space-y-2 pb-2">
                {c.body.map((p, j) => (
                  <li key={j} className="text-caption text-text-1">{p}</li>
                ))}
              </ul>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );
}
