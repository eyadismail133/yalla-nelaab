import { ar } from '../i18n/ar.js';

export function BrandLogo({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`brand-logo ${compact ? 'brand-logo--compact' : ''}`}>
      <img src="/brand/logo-graphite.svg" alt="" width="56" height="56" />
      <span className="brand-wordmark">{ar.appName}<span className="brand-caption">اللّمة تحلى باللعب</span></span>
    </span>
  );
}
