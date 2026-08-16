/**
 * useSavedFeedback — caption "Salvato ✓" transiente (fade dopo 1.2s).
 * Ritorna [visible, trigger].
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export function useSavedFeedback(): [boolean, () => void] {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trigger = useCallback(() => {
    setVisible(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setVisible(false), 1200);
  }, []);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  return [visible, trigger];
}
