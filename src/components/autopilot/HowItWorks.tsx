/**
 * Glossario dell'Autopilot. Esiste perché senza una spiegazione esplicita i
 * termini "shadow", "dry-run" e "snapshot" non significano nulla per chi non
 * ha scritto il motore.
 */
import { Brain, Database, Eye, FlaskConical, Radio, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';

const PIPELINE = [
  { icon: Database, title: 'Fotografa', text: 'Legge dal mirror eToro il capitale reale, la liquidità e le posizioni dell’Agent Portfolio. La conversione tecnica necessaria a eToro resta invisibile.' },
  { icon: Brain, title: 'Calcola', text: 'Il Worker calcola da solo rendimenti, volatilità, drawdown, RSI, momentum e il regime di mercato (VIX, S&P 500, curva dei tassi, notizie). Nessuna AI, solo matematica.' },
  { icon: Radio, title: 'Chiede un parere', text: 'Manda quei numeri a un modello AI gratuito su OpenRouter. Il modello risponde con una sola cosa: quale allocazione percentuale terrebbe, e quanto ne è sicuro.' },
  { icon: ShieldCheck, title: 'Verifica', text: 'Il codice controlla la proposta contro i tuoi limiti. Se sfora un tetto la riduce; se è troppo incerta o l’agente è congelato, la scarta del tutto. L’AI non può aggirare nulla.' },
  { icon: Eye, title: 'Esegue o simula', text: 'A seconda della modalità, gli ordini vengono solo registrati, simulati, oppure inviati davvero a eToro.' },
];

const MODES = [
  { key: 'shadow', color: 'text-text-1', title: 'Shadow — osserva e basta', text: 'Il ciclo gira tutto, ma si ferma prima di costruire gli ordini. Serve a leggere per settimane cosa avrebbe proposto l’AI, senza alcun rischio. È la modalità iniziale.' },
  { key: 'dry-run', color: 'text-warn', title: 'Dry-run — prova generale', text: 'Gli ordini vengono costruiti davvero, con importi reali, e viene chiesto a eToro se sarebbero ammissibili (mercato aperto, taglio minimo). Ma non vengono inviati. Serve a scoprire i problemi tecnici prima che contino.' },
  { key: 'live', color: 'text-loss', title: 'Live — soldi veri', text: 'Gli ordini partono davvero sull’Agent Portfolio, senza ulteriore conferma, alla cadenza che hai impostato. Richiede il token dell’Agent Portfolio.' },
];

const ACTIONS = [
  { title: 'Snapshot', text: 'Legge il capitale reale del portfolio e aggiorna gli indicatori. Non coinvolge l’AI e non genera ordini. Alimenta la curva percentuale e il controllo sul drawdown.' },
  { title: 'Run (ribilanciamento)', text: 'Il ciclo completo: fotografa, calcola, chiede all’AI, verifica e — secondo la modalità — esegue. È quello che parte in automatico alla cadenza configurata.' },
  { title: 'Congela', text: 'Blocco immediato. Nessuna run potrà più generare ordini finché non riattivi. Scatta anche da solo se il drawdown supera la soglia.' },
];

export function HowItWorks() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base text-text-0">
          <FlaskConical className="size-4 text-agent" /> Come funziona
        </CardTitle>
        <CardDescription className="text-text-1">
          L’Autopilot vive sul server di Cloudflare, non nel browser. Gira da solo alla cadenza impostata, anche con il sito chiuso e il computer spento.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {PIPELINE.map((step, index) => (
            <li key={step.title} className="rounded-lg border border-hairline bg-bg-2/60 p-3">
              <div className="flex items-center gap-2">
                <span className="flex size-5 items-center justify-center rounded-full bg-agent/20 text-[11px] font-semibold text-agent">{index + 1}</span>
                <step.icon className="size-4 text-text-1" />
                <span className="text-sm font-medium text-text-0">{step.title}</span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-text-1">{step.text}</p>
            </li>
          ))}
        </ol>

        <Accordion type="single" collapsible className="border-t border-hairline pt-1">
          <AccordionItem value="modalita" className="border-hairline">
            <AccordionTrigger className="text-sm text-text-0">Cosa cambia fra shadow, dry-run e live?</AccordionTrigger>
            <AccordionContent className="space-y-3">
              {MODES.map((mode) => (
                <div key={mode.key}>
                  <p className={`text-sm font-medium ${mode.color}`}>{mode.title}</p>
                  <p className="text-xs leading-relaxed text-text-1">{mode.text}</p>
                </div>
              ))}
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="azioni" className="border-hairline">
            <AccordionTrigger className="text-sm text-text-0">Snapshot, run, congela: che differenza c’è?</AccordionTrigger>
            <AccordionContent className="space-y-3">
              {ACTIONS.map((action) => (
                <div key={action.title}>
                  <p className="text-sm font-medium text-text-0">{action.title}</p>
                  <p className="text-xs leading-relaxed text-text-1">{action.text}</p>
                </div>
              ))}
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="token" className="border-hairline">
            <AccordionTrigger className="text-sm text-text-0">Cos’è il token dell’Agent Portfolio e perché serve?</AccordionTrigger>
            <AccordionContent className="space-y-2 text-xs leading-relaxed text-text-1">
              <p>
                L’<strong className="text-text-0">ID</strong> che vedi nella sezione Agent identifica il portafoglio. Il <strong className="text-text-0">token</strong> è un’altra cosa:
                è la credenziale che autorizza a operare su quel portafoglio, e va richiesta a eToro separatamente.
              </p>
              <p>
                Non è temporaneo: <strong className="text-text-0">resta valido finché non lo revochi</strong>. Sembra effimero perché finora la dashboard lo teneva
                in <code className="rounded bg-bg-2 px-1">sessionStorage</code>, che si svuota quando chiudi la scheda. Il valore però continua a esistere lato eToro.
              </p>
              <p>
                eToro te lo mostra <strong className="text-text-0">una sola volta</strong>, al momento della generazione. Copialo subito e incollalo nel campo
                “Token Agent Portfolio” qui sotto: finisce nel vault cifrato del Worker e resta disponibile al cron. Se l’hai perso, rigeneralo dalla sezione Agent.
              </p>
              <p>Senza token: shadow e dry-run funzionano lo stesso. Serve solo per la modalità live.</p>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="costi" className="border-b-0 border-hairline">
            <AccordionTrigger className="text-sm text-text-0">Quanto costa e ogni quanto gira?</AccordionTrigger>
            <AccordionContent className="space-y-2 text-xs leading-relaxed text-text-1">
              <p>
                Il cron si sveglia ogni ora. Nella quasi totalità dei casi non fa nulla: controlla solo se è il momento giusto secondo la cadenza che hai scelto.
              </p>
              <p>
                Con cadenza settimanale, il ciclo completo con l’AI parte <strong className="text-text-0">una volta a settimana</strong>. Il prompt è compresso sotto i 1.500 token,
                quindi con i modelli <code className="rounded bg-bg-2 px-1">:free</code> di OpenRouter il costo resta <strong className="text-text-0">zero</strong>. Anche Cloudflare Workers, D1 e KV
                restano nel piano gratuito.
              </p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
    </Card>
  );
}
