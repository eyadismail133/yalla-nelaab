import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { BrandLogo } from './BrandLogo.js';

/** Minimum comfortable tap target. People play this fast, standing up, on a phone. */
const TAP = 'min-h-14';

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'accent' }) {
  const base = `game-button ${TAP} w-full rounded-2xl px-5 text-lg font-bold transition active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100`;
  const styles = {
    primary: 'bg-body text-ink hover:bg-white',
    accent: 'text-ink glow-accent hover:brightness-110',
    ghost: 'bg-surface-2 text-body hover:bg-line border border-line',
  }[variant];

  return (
    <button
      {...props}
      className={`${base} ${styles} ${className}`}
      style={variant === 'accent' ? { background: 'var(--accent)', ...props.style } : props.style}
    />
  );
}

export function TextField({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`game-input ${TAP} w-full rounded-2xl border border-line bg-surface px-5 text-lg text-body outline-none placeholder:text-muted focus:border-[var(--accent)] ${className}`}
    />
  );
}

export function Screen({
  children,
  accent,
  className = '',
  brand = true,
}: {
  children: ReactNode;
  accent?: string;
  className?: string;
  brand?: boolean;
}) {
  return (
    <div
      className={`game-screen mx-auto flex min-h-full w-full max-w-lg flex-col gap-5 px-4 pb-8 pt-6 ${className}`}
      style={accent ? ({ ['--accent' as string]: `var(--color-accent-${accent})` } as never) : undefined}
    >
      {brand ? <div className="game-brand"><BrandLogo compact /></div> : null}
      {children}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`game-card rounded-3xl border border-line bg-surface p-5 ${className}`}>{children}</div>
  );
}

/**
 * A shrinking ring rather than a number.
 *
 * The countdown has to be readable out of the corner of the eye while the player is reading
 * the question — a bar draining is legible peripherally in a way a digit is not.
 */
export function CountdownRing({
  remainingMs,
  totalMs,
  size = 56,
}: {
  remainingMs: number;
  totalMs: number;
  size?: number;
}) {
  const ratio = totalMs > 0 ? Math.max(0, Math.min(1, remainingMs / totalMs)) : 0;
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const radius = size / 2 - 4;
  const circumference = 2 * Math.PI * radius;
  const urgent = seconds <= 5;

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-line)"
          strokeWidth={4}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={urgent ? 'var(--color-accent-rose)' : 'var(--accent)'}
          strokeWidth={4}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
          style={{ transition: 'stroke-dashoffset 200ms linear' }}
        />
      </svg>
      <span
        className={`tabular absolute inset-0 grid place-items-center text-lg font-bold ${
          urgent ? 'text-accent-rose' : 'text-body'
        }`}
      >
        {seconds}
      </span>
    </div>
  );
}

export function Pill({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'accent' }) {
  return (
    <span
      className={`rounded-full px-3 py-1 text-sm font-bold ${
        tone === 'accent' ? 'text-ink' : 'bg-surface-2 text-muted'
      }`}
      style={tone === 'accent' ? { background: 'var(--accent)' } : undefined}
    >
      {children}
    </span>
  );
}
