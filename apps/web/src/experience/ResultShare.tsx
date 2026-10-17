import { useEffect, useRef, useState } from 'react';
import type { RoomView } from '@game/shared';
import { ar } from '../i18n/ar.js';
import { Button, Card } from '../ui/primitives.js';

export type MatchOutcomeKind = 'solo_winner' | 'team_winner' | 'tie' | 'abandoned';

export interface SummaryStandingRow {
  rank: number;
  playerId: string;
  displayName: string;
  total: number;
  isWinner: boolean;
  teamEmoji: string | null;
  seatColorHex: string;
}

export interface SummaryTeamRow {
  rank: number;
  teamId: string;
  nameAr: string;
  emoji: string;
  total: number;
  memberNames: string[];
  isWinner: boolean;
}

export interface MatchResultSummary {
  brandAr: string;
  taglineAr: string;
  outcome: MatchOutcomeKind;
  badgeAr: string;
  headlineAr: string;
  subtitleAr: string;
  wonByTieBreak: boolean;
  standings: SummaryStandingRow[];
  teamStandings: SummaryTeamRow[];
  siteUrl: string;
}

const SEAT_HEX_PALETTE = [
  '#2ee6a8', // emerald
  '#3dc7ff', // sky
  '#ff6b9d', // rose
  '#ffc94a', // amber
  '#b98cff', // violet
  '#c3ff4d', // lime
  '#ff64d8', // fuchsia
  '#ff9142', // orange
] as const;

const DEFAULT_MAX_NAME_CHARS = 18;

export function truncateDisplayName(name: string, maxChars = DEFAULT_MAX_NAME_CHARS): string {
  const trimmed = name.trim();
  const glyphs = Array.from(trimmed);
  if (glyphs.length <= maxChars) return trimmed;
  return `${glyphs.slice(0, Math.max(1, maxChars - 1)).join('')}…`;
}

/**
 * Strips paths, query parameters (`?code=...`, `?token=...`), and fragments so a shared card
 * only ever advertises the base site origin and never leaks a room code or session token.
 */
export function sanitizeShareUrl(rawUrl?: string): string {
  const candidate =
    rawUrl?.trim() ||
    (typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '');

  if (!candidate) return 'yalla-nelaab.web.app';

  try {
    const parsed = new URL(candidate);
    return parsed.origin;
  } catch {
    // Fallback for bare hostnames without protocol
    const withoutQueryOrHash = candidate.split(/[?#]/)[0] ?? '';
    const hostOnly = withoutQueryOrHash.replace(/^https?:\/\//i, '').split('/')[0] ?? '';
    return hostOnly || 'yalla-nelaab.web.app';
  }
}

function seatHexForPlayer(players: RoomView['players'], playerId: string): string {
  const idx = players.findIndex((p) => p.id === playerId);
  if (idx < 0) return '#a89bcb';
  return SEAT_HEX_PALETTE[idx % SEAT_HEX_PALETTE.length]!;
}

/**
 * Pure summary builder for the final podium state.
 *
 * Handles solo winners, sudden-death tie-break winners (where multiple players share rank 1
 * on total points while `winnerId` holds the tie-break victor), team winners, ties, and
 * abandoned matches without ever including `view.code` or reconnect tokens.
 */
export function summarizeMatchResult(view: RoomView, siteUrl?: string): MatchResultSummary {
  const cleanSiteUrl = sanitizeShareUrl(siteUrl);
  const playerById = new Map(view.players.map((p) => [p.id, p]));
  const teamById = new Map(view.teams.map((t) => [t.id, t]));

  const isTeamMatch = Boolean(view.config.teams || view.teamStandings.length > 0);

  const standings: SummaryStandingRow[] = view.standings.map((entry) => {
    const player = playerById.get(entry.playerId);
    const team = player?.teamId ? teamById.get(player.teamId) : undefined;
    const isWinner =
      view.endReason !== 'abandoned' &&
      (isTeamMatch
        ? Boolean(view.winningTeamId && player?.teamId === view.winningTeamId)
        : view.winnerId === entry.playerId);

    return {
      rank: entry.rank,
      playerId: entry.playerId,
      displayName: truncateDisplayName(player?.nickname ?? entry.playerId),
      total: entry.total,
      isWinner,
      teamEmoji: team?.emoji ?? null,
      seatColorHex: seatHexForPlayer(view.players, entry.playerId),
    };
  });

  const teamStandings: SummaryTeamRow[] = view.teamStandings.map((ts) => {
    const team = teamById.get(ts.teamId);
    const memberNames = ts.memberIds.map((id) =>
      truncateDisplayName(playerById.get(id)?.nickname ?? id, 14),
    );
    return {
      rank: ts.rank,
      teamId: ts.teamId,
      nameAr: team?.nameAr ?? ts.teamId,
      emoji: team?.emoji ?? '🏳️',
      total: ts.total,
      memberNames,
      isWinner: view.endReason !== 'abandoned' && view.winningTeamId === ts.teamId,
    };
  });

  if (view.endReason === 'abandoned') {
    return {
      brandAr: ar.appName,
      taglineAr: ar.tagline,
      outcome: 'abandoned',
      badgeAr: ar.podium,
      headlineAr: ar.endedEarly,
      subtitleAr: 'الماتش اتقفل قبل ما الجولات تكمل — ودي كانت النتيجة وقتها',
      wonByTieBreak: false,
      standings,
      teamStandings,
      siteUrl: cleanSiteUrl,
    };
  }

  // Team matches are evaluated strictly as team outcomes
  if (isTeamMatch) {
    const winningTeam = view.winningTeamId ? teamById.get(view.winningTeamId) : undefined;
    if (winningTeam) {
      const winningStanding = view.teamStandings.find((t) => t.teamId === winningTeam.id);
      const pointsText = winningStanding ? `${winningStanding.total} ${ar.points} في المتوسط` : '';
      return {
        brandAr: ar.appName,
        taglineAr: ar.tagline,
        outcome: 'team_winner',
        badgeAr: ar.winningTeam,
        headlineAr: `${winningTeam.emoji} ${winningTeam.nameAr}`,
        subtitleAr: pointsText || 'حسموا مواجهة الفرق في الصدارة',
        wonByTieBreak: false,
        standings,
        teamStandings,
        siteUrl: cleanSiteUrl,
      };
    }

    // Teams tied — must preserve team tie and never report an individual solo winner
    const tiedTeams = view.teamStandings
      .filter((ts) => ts.rank === 1)
      .map((ts) => teamById.get(ts.teamId)?.nameAr ?? ts.teamId);
    const subtitleAr =
      tiedTeams.length > 1
        ? `تعادل بين ${tiedTeams.join(' و ')} في الصدارة`
        : 'تعادل بين الفريقين في الصدارة';

    return {
      brandAr: ar.appName,
      taglineAr: ar.tagline,
      outcome: 'tie',
      badgeAr: ar.teamScoreboard,
      headlineAr: ar.sharedWin,
      subtitleAr,
      wonByTieBreak: false,
      standings,
      teamStandings,
      siteUrl: cleanSiteUrl,
    };
  }

  const winner = view.winnerId ? playerById.get(view.winnerId) : undefined;
  if (winner) {
    const winnerStanding = view.standings.find((s) => s.playerId === winner.id);
    const topRankCount = view.standings.filter((s) => s.rank === 1).length;
    const wonByTieBreak =
      view.suddenDeath?.resolvedWinner === winner.id || topRankCount > 1;
    const pointsLabel = `${winnerStanding?.total ?? winner.total} ${ar.points}`;

    return {
      brandAr: ar.appName,
      taglineAr: ar.tagline,
      outcome: 'solo_winner',
      badgeAr: wonByTieBreak ? `${ar.winner} • ${ar.suddenDeath}` : ar.winner,
      headlineAr: truncateDisplayName(winner.nickname, 20),
      subtitleAr: wonByTieBreak
        ? `${pointsLabel} • حسمها في ${ar.suddenDeath} ⚡`
        : pointsLabel,
      wonByTieBreak,
      standings,
      teamStandings,
      siteUrl: cleanSiteUrl,
    };
  }

  const tiedLeaders = standings
    .filter((s) => s.rank === 1)
    .map((s) => s.displayName)
    .slice(0, 4);

  return {
    brandAr: ar.appName,
    taglineAr: ar.tagline,
    outcome: 'tie',
    badgeAr: ar.podium,
    headlineAr: ar.sharedWin,
    subtitleAr:
      tiedLeaders.length > 1
        ? `تساوت الرؤوس بين: ${tiedLeaders.join(' و ')}`
        : 'منافسة متكافئة لآخر لحظة',
    wonByTieBreak: false,
    standings,
    teamStandings,
    siteUrl: cleanSiteUrl,
  };
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function fitCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidthPx: number,
): string {
  if (ctx.measureText(text).width <= maxWidthPx) return text;
  const glyphs = Array.from(text);
  while (glyphs.length > 1) {
    glyphs.pop();
    const candidate = `${glyphs.join('').trimEnd()}…`;
    if (ctx.measureText(candidate).width <= maxWidthPx) {
      return candidate;
    }
  }
  return text;
}

export async function renderResultCardBlob(summary: MatchResultSummary): Promise<Blob> {
  if (typeof document === 'undefined') {
    throw new Error('ميزة الصور متاحة جوه المتصفح بس');
  }

  if (document.fonts?.ready) {
    try {
      await document.fonts.ready;
    } catch {
      // Proceed with fallback system fonts if font readiness rejects
    }
  }

  const width = 1080;
  const teamBlockHeight = summary.teamStandings.length > 0 ? 220 : 0;
  const playerCount = Math.min(summary.standings.length, 8);
  const height = Math.max(1240, 680 + teamBlockHeight + playerCount * 76);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('مقدرناش نجهز لوحة الرسم للنتيجة');
  }

  const fontStack = "'Cairo', 'Segoe UI', 'Tahoma', sans-serif";
  ctx.direction = 'rtl';
  ctx.textBaseline = 'middle';

  // Background gradient
  const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
  bgGradient.addColorStop(0, '#120f1e');
  bgGradient.addColorStop(0.5, '#19142b');
  bgGradient.addColorStop(1, '#120f1e');
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  // Outer card frame
  drawRoundedRect(ctx, 44, 44, width - 88, height - 88, 44);
  ctx.fillStyle = '#1c1730';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#372c56';
  ctx.stroke();

  // Brand header
  ctx.textAlign = 'center';
  ctx.fillStyle = '#2ee6a8';
  ctx.font = `900 56px ${fontStack}`;
  ctx.fillText(summary.brandAr, width / 2, 120);

  ctx.fillStyle = '#a89bcb';
  ctx.font = `600 24px ${fontStack}`;
  ctx.fillText(summary.taglineAr, width / 2, 172);

  // Hero outcome card
  const heroY = 216;
  const heroH = 220;
  drawRoundedRect(ctx, 88, heroY, width - 176, heroH, 34);
  ctx.fillStyle = '#26203f';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle =
    summary.outcome === 'abandoned'
      ? '#ff6b9d'
      : summary.outcome === 'tie'
        ? '#3dc7ff'
        : '#ffc94a';
  ctx.stroke();

  ctx.fillStyle = '#a89bcb';
  ctx.font = `700 26px ${fontStack}`;
  ctx.fillText(summary.badgeAr, width / 2, heroY + 48);

  ctx.fillStyle = '#ffc94a';
  ctx.font = `900 54px ${fontStack}`;
  const headlineFitted = fitCanvasText(ctx, summary.headlineAr, width - 250);
  ctx.fillText(headlineFitted, width / 2, heroY + 116);

  ctx.fillStyle = '#f3efff';
  ctx.font = `700 26px ${fontStack}`;
  const subtitleFitted = fitCanvasText(ctx, summary.subtitleAr, width - 250);
  ctx.fillText(subtitleFitted, width / 2, heroY + 174);

  let cursorY = heroY + heroH + 42;

  // Optional Team Standings section
  if (summary.teamStandings.length > 0) {
    ctx.textAlign = 'right';
    ctx.fillStyle = '#a89bcb';
    ctx.font = `700 26px ${fontStack}`;
    ctx.fillText(ar.teamScoreboard, width - 92, cursorY);
    cursorY += 32;

    for (const team of summary.teamStandings.slice(0, 2)) {
      drawRoundedRect(ctx, 88, cursorY, width - 176, 68, 22);
      ctx.fillStyle = team.isWinner ? '#26203f' : '#161226';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = team.isWinner ? '#ffc94a' : '#372c56';
      ctx.stroke();

      ctx.textAlign = 'right';
      ctx.fillStyle = '#f3efff';
      ctx.font = `800 28px ${fontStack}`;
      const membersNote =
        team.memberNames.length > 0 ? ` (${team.memberNames.join('، ')})` : '';
      const label = fitCanvasText(
        ctx,
        `${team.emoji} ${team.nameAr}${membersNote}`,
        width - 380,
      );
      ctx.fillText(label, width - 116, cursorY + 34);

      ctx.textAlign = 'left';
      ctx.fillStyle = team.isWinner ? '#ffc94a' : '#f3efff';
      ctx.font = `900 30px ${fontStack}`;
      ctx.fillText(`${team.total} ${ar.points}`, 116, cursorY + 34);

      cursorY += 80;
    }

    cursorY += 12;
  }

  // Individual Standings section
  ctx.textAlign = 'right';
  ctx.fillStyle = '#a89bcb';
  ctx.font = `700 26px ${fontStack}`;
  ctx.fillText(ar.scoreboard, width - 92, cursorY);
  cursorY += 32;

  for (const row of summary.standings.slice(0, 8)) {
    drawRoundedRect(ctx, 88, cursorY, width - 176, 64, 20);
    ctx.fillStyle = row.isWinner ? '#26203f' : '#161226';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = row.isWinner ? '#ffc94a' : '#372c56';
    ctx.stroke();

    // Rank badge on the right (RTL start)
    ctx.textAlign = 'center';
    ctx.fillStyle = row.isWinner ? '#ffc94a' : '#a89bcb';
    ctx.font = `900 28px ${fontStack}`;
    ctx.fillText(`#${row.rank}`, width - 128, cursorY + 32);

    // Seat color dot
    ctx.beginPath();
    ctx.arc(width - 176, cursorY + 32, 9, 0, Math.PI * 2);
    ctx.fillStyle = row.seatColorHex;
    ctx.fill();

    // Player name + crown/team badge
    ctx.textAlign = 'right';
    ctx.fillStyle = '#f3efff';
    ctx.font = `700 28px ${fontStack}`;
    const prefix = row.isWinner ? '👑 ' : '';
    const suffix = row.teamEmoji ? ` ${row.teamEmoji}` : '';
    const fittedName = fitCanvasText(
      ctx,
      `${prefix}${row.displayName}${suffix}`,
      width - 440,
    );
    ctx.fillText(fittedName, width - 202, cursorY + 32);

    // Points on the left (RTL end)
    ctx.textAlign = 'left';
    ctx.fillStyle = row.isWinner ? '#ffc94a' : '#f3efff';
    ctx.font = `900 30px ${fontStack}`;
    ctx.fillText(`${row.total} ${ar.points}`, 116, cursorY + 32);

    cursorY += 74;
  }

  // Footer with sanitized base site URL ONLY (never room code or token)
  ctx.textAlign = 'center';
  ctx.fillStyle = '#a89bcb';
  ctx.font = `700 24px ${fontStack}`;
  ctx.fillText(`العبوا مجانًا على: ${summary.siteUrl}`, width / 2, height - 86);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('مقدرناش نجهز صورة النتيجة دلوقتي'));
          return;
        }
        resolve(blob);
      },
      'image/png',
      0.95,
    );
  });
}

export function canNativeShareFiles(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') {
    return false;
  }
  if (typeof File === 'undefined') return false;

  try {
    const probe = new File([new Uint8Array([137, 80, 78, 71])], 'result.png', {
      type: 'image/png',
    });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

export interface ResultShareProps {
  view: RoomView;
  siteUrl?: string;
  onError?: (message: string) => void;
}

export function ResultShare({ view, siteUrl, onError }: ResultShareProps) {
  const [pendingAction, setPendingAction] = useState<'idle' | 'downloading' | 'sharing'>('idle');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const activeObjectUrlsRef = useRef<Set<string>>(new Set());

  const summary = summarizeMatchResult(view, siteUrl);
  const supportsFileShare = canNativeShareFiles();

  const revokeAllObjectUrls = () => {
    for (const url of activeObjectUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    activeObjectUrlsRef.current.clear();
  };

  useEffect(() => {
    return () => {
      revokeAllObjectUrls();
    };
  }, []);

  const triggerBlobDownload = (blob: Blob) => {
    const objectUrl = URL.createObjectURL(blob);
    activeObjectUrlsRef.current.add(objectUrl);

    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = 'yalla-nelaab-result.png';
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => {
      if (activeObjectUrlsRef.current.has(objectUrl)) {
        URL.revokeObjectURL(objectUrl);
        activeObjectUrlsRef.current.delete(objectUrl);
      }
    }, 1000);
  };

  const reportError = (msg: string) => {
    setLocalError(msg);
    onError?.(msg);
  };

  const handleDownload = async () => {
    if (pendingAction !== 'idle') return;
    setPendingAction('downloading');
    setLocalError(null);
    setStatusMessage(null);

    try {
      const blob = await renderResultCardBlob(summary);
      triggerBlobDownload(blob);
      setStatusMessage('تم تحميل كارت النتيجة بنجاح ✓');
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'حصلت مشكلة أثناء تجهيز صورة النتيجة';
      reportError(message);
    } finally {
      setPendingAction('idle');
    }
  };

  const handleShare = async () => {
    if (pendingAction !== 'idle') return;
    setPendingAction('sharing');
    setLocalError(null);
    setStatusMessage(null);

    try {
      const blob = await renderResultCardBlob(summary);
      const file = new File([blob], 'yalla-nelaab-result.png', { type: 'image/png' });

      if (typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({
            files: [file],
            title: `${summary.brandAr} — ${summary.badgeAr}`,
            text: `${summary.headlineAr} (${summary.subtitleAr}) — ${summary.siteUrl}`,
          });
          setStatusMessage('تمت مشاركة النتيجة ✓');
          return;
        } catch (shareErr) {
          // User dismissing the native share sheet is normal and should stay quiet
          if (shareErr instanceof Error && shareErr.name === 'AbortError') {
            return;
          }
          // Any non-cancel share failure falls back cleanly to downloading the card
          triggerBlobDownload(blob);
          setStatusMessage('المشاركة المباشرة مكمّلتش، فحمّلنا صورة النتيجة على جهازك ✓');
          return;
        }
      }

      triggerBlobDownload(blob);
      setStatusMessage('تم تحميل صورة النتيجة عشان تشاركها براحتك ✓');
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'مقدرناش نجهز كارت المشاركة دلوقتي';
      reportError(message);
    } finally {
      setPendingAction('idle');
    }
  };

  const isBusy = pendingAction !== 'idle';

  return (
    <Card className="flex w-full min-w-0 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-body">شارك كارت النتيجة</h2>
          <p className="text-xs text-muted">
            صورة جاهزة بالترتيب النهائي من غير كود الغرفة
          </p>
        </div>
        <span className="rounded-full bg-surface-2 px-3 py-1 text-xs font-bold text-muted">
          PNG
        </span>
      </div>

      {/* Compact preview of what the generated PNG card highlights */}
      <div className="flex flex-col gap-1 rounded-2xl border border-line bg-surface-2 p-3 text-center">
        <span className="text-xs font-bold text-muted">{summary.badgeAr}</span>
        <p className="truncate text-lg font-black" style={{ color: 'var(--accent)' }}>
          {summary.headlineAr}
        </p>
        <p className="text-xs text-muted">{summary.subtitleAr}</p>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {supportsFileShare ? (
          <Button
            type="button"
            variant="accent"
            disabled={isBusy}
            onClick={() => void handleShare()}
          >
            {pendingAction === 'sharing' ? 'بنجهّز الصورة...' : 'مشاركة النتيجة 📤'}
          </Button>
        ) : null}

        <Button
          type="button"
          variant={supportsFileShare ? 'ghost' : 'accent'}
          disabled={isBusy}
          onClick={() => void handleDownload()}
        >
          {pendingAction === 'downloading' ? 'بنجهّز الصورة...' : 'تحميل صورة النتيجة ⬇️'}
        </Button>
      </div>

      {statusMessage ? (
        <p role="status" className="text-center text-xs font-bold text-accent-emerald">
          {statusMessage}
        </p>
      ) : null}

      {localError ? (
        <p role="alert" className="text-center text-xs font-bold text-accent-rose">
          {localError}
        </p>
      ) : null}
    </Card>
  );
}
