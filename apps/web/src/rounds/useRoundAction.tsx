import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { ar } from '../i18n/ar.js';
import type { GameTransport } from '../net/transport.js';

export const ACTION_BOUND_TIMEOUT_MS = 10_500;

/**
 * Clears the input draft after an accepted submission only if the user has not changed
 * the text since the submission started.
 */
export function reconcileSubmittedDraft(currentDraft: string, submittedDraft: string): string {
  return currentDraft === submittedDraft ? '' : currentDraft;
}

export function normalizeRoundActionError(error: unknown): string {
  if (typeof error === 'string' && error.trim().length > 0) {
    return error.trim();
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return ar.actionFailed;
}

/**
 * Executes `client.act(roundNo, action)` with a bounded timeout and full rejection handling
 * so UI callers never produce an unhandled Promise rejection or stay stuck pending forever.
 */
export async function performRoundAction(
  client: Pick<GameTransport, 'act'>,
  roundNo: number,
  action: unknown,
  timeoutMs = ACTION_BOUND_TIMEOUT_MS,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<{ ok: false; error: string }>((resolve) => {
      timer = setTimeout(() => {
        resolve({ ok: false, error: 'انتهت مهلة الطلب — جرب تاني' });
      }, timeoutMs);
    });

    const result = await Promise.race([client.act(roundNo, action), timeoutPromise]);
    if (!result || typeof result !== 'object' || !('ok' in result)) {
      return { ok: false, error: ar.actionFailed };
    }
    if (!result.ok) {
      return { ok: false, error: normalizeRoundActionError(result.error) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: normalizeRoundActionError(err) };
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

export function useRoundAction<Action = unknown>(client: GameTransport, roundNo: number) {
  const [pending, setPending] = useState(false);
  const [submittedAction, setSubmittedAction] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const roundRef = useRef(roundNo);
  roundRef.current = roundNo;
  const requestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    inFlightRef.current = false;
    requestRef.current += 1;
    setPending(false);
    setSubmittedAction(null);
    setError(null);
  }, [roundNo]);

  const act = async (action: Action, onSuccess?: () => void): Promise<boolean> => {
    if (inFlightRef.current) return false;
    inFlightRef.current = true;
    const requestId = ++requestRef.current;
    const isCurrent = () => mountedRef.current && roundRef.current === roundNo && requestRef.current === requestId;
    if (mountedRef.current) {
      setPending(true);
      setSubmittedAction(action);
      setError(null);
    }

    try {
      const result = await performRoundAction(client, roundNo, action);
      if (!isCurrent()) return false;
      if (!result.ok) {
        setSubmittedAction(null);
        setError(result.error);
        return false;
      }
      onSuccess?.();
      return true;
    } finally {
      if (isCurrent()) {
        inFlightRef.current = false;
        setPending(false);
      }
    }
  };

  const submitDraft = async (
    draft: string,
    setDraft: Dispatch<SetStateAction<string>>,
    buildAction: (submittedText: string) => Action,
  ): Promise<boolean> => {
    const captured = draft;
    return act(buildAction(captured), () => {
      setDraft((current) => reconcileSubmittedDraft(current, captured));
    });
  };

  return {
    pending,
    submittedAction,
    error,
    clearError: () => setError(null),
    act,
    submitDraft,
  };
}

export function RoundActionStatus({
  error,
  pending = false,
}: {
  error: string | null;
  pending?: boolean;
}) {
  if (!error && !pending) return null;

  return (
    <div className="min-h-6 text-center" aria-live={error ? 'assertive' : 'polite'}>
      {error ? (
        <p role="alert" className="text-sm font-bold text-accent-rose">
          {error}
        </p>
      ) : (
        <p role="status" className="text-xs font-bold text-muted">
          {ar.sendingAction}
        </p>
      )}
    </div>
  );
}
