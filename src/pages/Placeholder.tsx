/**
 * Placeholder — stub "In costruzione" per le pagine non ancora implementate.
 * Verrà sostituito dagli altri agenti con le pagine complete.
 */
import { Construction } from 'lucide-react';
import { EmptyState } from '@/components/shared/EmptyState';

export function Placeholder({ title }: { title: string }) {
  return (
    <EmptyState
      icon={<Construction className="mb-4 h-10 w-10 text-text-2" aria-hidden />}
      headline={title}
      copy="Questa sezione è in costruzione. Torna presto."
    />
  );
}
