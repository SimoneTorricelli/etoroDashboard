import {
  ArrowDown,
  Check,
  CircleAlert,
  CircleDashed,
  Cpu,
  FileCheck2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { StrategyCollaboration, StrategyTraceEvent } from '@/lib/agent/autopilot-api';
import './strategy-collaboration-trace.css';

interface StrategyCollaborationTraceProps {
  events?: StrategyTraceEvent[];
  collaboration?: StrategyCollaboration | null;
  live?: boolean;
  compact?: boolean;
  className?: string;
}

const STAGE_LABEL: Record<StrategyTraceEvent['stage'], string> = {
  intake: 'Brief',
  lead: 'Proposta',
  review: 'Revisione',
  synthesis: 'Sintesi',
  deterministic: 'Guardrail',
  complete: 'Pronta',
};

function statusIcon(status: StrategyTraceEvent['status']) {
  if (status === 'running') return <RefreshCw className="sct-spin" size={16} aria-hidden />;
  if (status === 'passed') return <Check size={16} aria-hidden />;
  if (status === 'failed') return <CircleAlert size={16} aria-hidden />;
  return <CircleDashed size={16} aria-hidden />;
}

function providerName(model?: string | null) {
  if (!model) return null;
  const [provider, ...rest] = model.split('/');
  const providerLabel: Record<string, string> = {
    'workers-ai': 'Cloudflare',
    openrouter: 'OpenRouter',
    gemini: 'Gemini',
    groq: 'Groq',
  };
  return `${providerLabel[provider] ?? provider} · ${rest.join('/') || model}`;
}

export function StrategyCollaborationTrace({
  events,
  collaboration,
  live = false,
  compact = false,
  className,
}: StrategyCollaborationTraceProps) {
  const trace = events?.length ? events : collaboration?.trace ?? [];
  const visibleTrace = compact ? trace.slice(-5) : trace;
  const finished = Boolean(collaboration) || trace.some((event) => event.stage === 'complete');

  return (
    <section className={cn('sct-shell', compact && 'sct-shell--compact', className)} aria-labelledby="strategy-collaboration-title">
      <header className="sct-header">
        <div className="sct-heading-icon" aria-hidden><Sparkles size={19} /></div>
        <div>
          <p>{live && !finished ? 'Collaborazione in corso' : 'Strategia verificata da più AI'}</p>
          <h3 id="strategy-collaboration-title">
            {live && !finished ? 'Stanno costruendo e controllando la policy' : 'Una proposta, più controlli, un solo set di guardrail'}
          </h3>
        </div>
        <span className={cn('sct-state', finished && 'is-finished')}>
          <span aria-hidden /> {finished ? 'Traccia completa' : 'Live'}
        </span>
      </header>

      <p className="sct-intro">
        Mostriamo decisioni, documenti passati e controlli effettuati. I ragionamenti interni dei modelli restano privati.
      </p>

      {visibleTrace.length ? (
        <ol className="sct-timeline" aria-live={live ? 'polite' : 'off'}>
          {visibleTrace.map((event, index) => (
            <li key={event.id} data-status={event.status}>
              <div className="sct-marker">{statusIcon(event.status)}</div>
              <div className="sct-event">
                <div className="sct-event-meta">
                  <span>{STAGE_LABEL[event.stage]}</span>
                  {event.model ? <small><Cpu size={12} aria-hidden /> {providerName(event.model)}</small> : null}
                </div>
                <strong>{event.title}</strong>
                <p>{event.summary}</p>
                {event.handoff?.length ? (
                  <div className="sct-handoff">
                    <span><FileCheck2 size={13} aria-hidden /> Passa avanti</span>
                    <p>{event.handoff.join(' · ')}</p>
                  </div>
                ) : null}
                {event.details?.length ? (
                  <ul>{event.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
                ) : null}
              </div>
              {index < visibleTrace.length - 1 ? <ArrowDown className="sct-connector" size={14} aria-hidden /> : null}
            </li>
          ))}
        </ol>
      ) : (
        <div className="sct-empty">
          <CircleDashed size={20} aria-hidden />
          <span>La traccia comparirà qui appena parte la generazione.</span>
        </div>
      )}

      {collaboration?.reviews.length ? (
        <div className="sct-review-grid">
          {collaboration.reviews.map((review) => (
            <article key={review.reviewer} data-verdict={review.verdict}>
              <div>
                {review.verdict === 'approve' ? <ShieldCheck size={16} aria-hidden /> : <CircleAlert size={16} aria-hidden />}
                <strong>{review.verdict === 'approve' ? 'Approvata' : 'Con attenzioni'}</strong>
                <span>{Math.round(review.confidence * 100)}% confidenza</span>
              </div>
              <small>{providerName(review.reviewer)}</small>
              <p>{review.summary}</p>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export default StrategyCollaborationTrace;
