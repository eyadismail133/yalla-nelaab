import { useEffect, useState } from 'react';
import { ar } from '../i18n/ar.js';
import { Button, Card } from './primitives.js';

export function normalizeRoomCodeInput(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 5);
}

export function isValidRoomCode(code: string): boolean {
  return /^[A-Z0-9]{5}$/.test(code.trim());
}

/**
 * Builds the canonical invitation URL using `origin + '/?code=' + encodeURIComponent(code)`.
 */
export function buildInviteUrl(code: string, origin?: string): string {
  const cleanCode = code.trim().toUpperCase();
  const resolvedOrigin = (
    origin?.trim() ||
    (typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'https://yalla-nelaab.web.app')
  ).replace(/\/+$/, '');

  return `${resolvedOrigin}/?code=${encodeURIComponent(cleanCode)}`;
}

/**
 * Builds a compose-only WhatsApp `wa.me` link with the room code and exact invite URL.
 */
export function buildWhatsAppInviteHref(code: string, inviteUrl: string): string {
  const cleanCode = code.trim().toUpperCase();
  const message = `يلا نلعب! ادخل معايا الغرفة بكود ${cleanCode} أو افتح اللينك علطول:\n${inviteUrl}`;
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

export async function generateInviteQrDataUrl(inviteUrl: string): Promise<string> {
  const { default: QRCode } = await import('qrcode');
  return QRCode.toDataURL(inviteUrl, {
    width: 220,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: {
      dark: '#121313',
      light: '#f3eee5',
    },
  });
}

export function canNativeShareInvite(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

export interface InvitationPanelProps {
  code: string;
  origin?: string;
  onError?: (message: string) => void;
}

export function InvitationPanel({ code, origin, onError }: InvitationPanelProps) {
  const cleanCode = code.trim().toUpperCase();
  const inviteUrl = buildInviteUrl(cleanCode, origin);
  const whatsAppHref = buildWhatsAppInviteHref(cleanCode, inviteUrl);
  const supportsShare = canNativeShareInvite();

  const [copied, setCopied] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [manualFallbackMessage, setManualFallbackMessage] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setQrFailed(false);

    generateInviteQrDataUrl(inviteUrl)
      .then((url) => {
        if (!cancelled) {
          setQrDataUrl(url);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setQrDataUrl(null);
          setQrFailed(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [inviteUrl]);

  const copyLink = async () => {
    setManualFallbackMessage(null);
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      const msg = `انسخ اللينك أو الكود يدوي: ${cleanCode}`;
      setManualFallbackMessage(msg);
      onError?.(msg);
    }
  };

  const shareNative = async () => {
    if (sharing || !supportsShare) return;
    setSharing(true);
    setManualFallbackMessage(null);
    try {
      await navigator.share({
        title: `${ar.appName} — غرفة ${cleanCode}`,
        text: `ادخل معايا في ${ar.appName}! كود الغرفة: ${cleanCode}`,
        url: inviteUrl,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      await copyLink();
    } finally {
      setSharing(false);
    }
  };

  return (
    <Card className="flex w-full min-w-0 flex-col gap-3 p-4 text-center">
      <div>
        <p className="text-xs font-bold text-muted">{ar.inviteFriends}</p>
        <p className="mt-0.5 text-xs text-muted">{ar.roomCode}</p>
        <p
          dir="ltr"
          className="tabular my-1 select-all text-4xl font-black tracking-[0.28em] sm:text-5xl"
          style={{ color: 'var(--accent)' }}
        >
          {cleanCode}
        </p>
      </div>

      {/* Visible, selectable invitation link so manual copy always works */}
      <div className="rounded-2xl border border-line bg-surface-2 px-3 py-2 text-center">
        <p
          dir="ltr"
          className="tabular select-all break-all text-xs font-bold text-body"
          aria-label="رابط الدعوة للغرفة"
        >
          {inviteUrl}
        </p>
      </div>

      {/* Action buttons: Copy link, Optional Native Share, and WhatsApp compose link */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Button type="button" variant="ghost" onClick={() => void copyLink()}>
          {copied ? ar.linkCopied : ar.copyLink}
        </Button>

        {supportsShare ? (
          <Button
            type="button"
            variant="accent"
            disabled={sharing}
            onClick={() => void shareNative()}
          >
            {sharing ? ar.sendingAction : ar.inviteShareNative}
          </Button>
        ) : null}

        <a
          href={whatsAppHref}
          target="_blank"
          rel="noopener noreferrer"
          className={`min-h-14 w-full rounded-2xl border border-line bg-surface-2 px-5 text-base font-bold text-body transition hover:bg-line active:scale-[0.98] flex items-center justify-center ${
            supportsShare ? 'sm:col-span-2' : ''
          }`}
        >
          {ar.inviteWhatsApp}
        </a>
      </div>

      {manualFallbackMessage ? (
        <p role="status" aria-live="polite" className="text-xs font-bold text-accent-amber">
          {manualFallbackMessage}
        </p>
      ) : null}

      {/* Local QR Code inside compact details/card area */}
      <div className="mt-1 flex flex-col items-center gap-2 rounded-2xl border border-line bg-surface-2/60 p-3">
        {qrDataUrl ? (
          <img
            src={qrDataUrl}
            alt={`${ar.inviteQrAlt} ${cleanCode}`}
            className="aspect-square h-auto w-full max-w-[152px] rounded-2xl border border-line bg-body p-1.5"
          />
        ) : qrFailed ? (
          <p role="status" className="text-xs text-muted">
            {ar.inviteQrFallback}
          </p>
        ) : (
          <div
            aria-hidden="true"
            className="grid aspect-square w-full max-w-[152px] place-items-center rounded-2xl border border-dashed border-line text-xs text-muted"
          >
            QR...
          </div>
        )}
        <p className="text-[11px] text-muted">امسح الكود بالموبايل عشان تدخل الغرفة علطول</p>
      </div>
    </Card>
  );
}
