import type { MatchConfig } from '@game/shared';
import { CATEGORIES } from '../content/index.js';
import { Card } from '../ui/primitives.js';

export type MatchPresetId = 'quick_mixed' | 'football_night' | 'team_party' | 'football_derby';

export interface MatchPresetDefinition {
  id: MatchPresetId;
  emoji: string;
  titleAr: string;
  subtitleAr: string;
  badgeAr: string;
  noteAr?: string;
}

export const FOOTBALL_CATEGORY_ID = 'football';

export const MATCH_PRESETS: readonly MatchPresetDefinition[] = [
  {
    id: 'football_derby', emoji: '🏟️', titleAr: 'ديربي الكورة',
    subtitleAr: 'اختيارات، تخمين أرقام، مين أنا، والكذّابين — في عالم الكورة',
    badgeAr: '~١٠ جولات • فردي • ٤ ألعاب كروية',
  },
  {
    id: 'quick_mixed',
    emoji: '⚡',
    titleAr: 'سهرة سريعة',
    subtitleAr: 'خلطة متنوعة من الألعاب في كل المجالات المتاحة',
    badgeAr: '~٥ جولات • فردي • كل المجالات',
  },
  {
    id: 'football_night',
    emoji: '⚽',
    titleAr: 'ليلة كورة',
    subtitleAr: 'تحديات كروية خالصة بتبدّل بين ألعاب السرعة والتفكير',
    badgeAr: '~١٠ جولات • فردي • كورة بس',
  },
  {
    id: 'team_party',
    emoji: '🤝',
    titleAr: 'حفلة فرق',
    subtitleAr: 'الغرفة بتتقسم فريقين في مواجهة شاملة في كل المجالات',
    badgeAr: '~١٠ جولات • فريقين • كل المجالات',
    noteAr:
      'تقدر تختاره قبل ما صحابك يدخلوا — الألعاب التعاونية (وصّفهالي والتتابع) بتشتغل لما تكملوا 4 لاعيبة على الأقل.',
  },
];

function normalizeCategoryIds(availableCategoryIds: readonly string[]): string[] {
  const unique = Array.from(
    new Set(availableCategoryIds.map((id) => id.trim()).filter((id) => id.length > 0)),
  );
  if (unique.length > 0) {
    return unique;
  }
  return CATEGORIES.map((c) => c.id);
}

/**
 * Pure helper producing a fresh `MatchConfig` for one of the three canonical match presets.
 *
 * Never carries a `roundTypeId` property so switching from a `focused` setup to a preset starts
 * from a clean `mixed` configuration. Parent/lobby integration should explicitly clear any
 * focused `roundTypeId` state (`roundTypeId: undefined`) when patching an existing room.
 */
export function buildPresetConfig(
  presetId: MatchPresetId,
  availableCategoryIds: readonly string[],
): MatchConfig {
  const allCategories = normalizeCategoryIds(availableCategoryIds);

  switch (presetId) {
    case 'football_derby':
      return {
        format: 'mixed', roundCount: 10, teams: false,
        categoryIds: allCategories.includes(FOOTBALL_CATEGORY_ID) ? [FOOTBALL_CATEGORY_ID] : [allCategories[0]!],
        roundTypeIds: ['mcq_race', 'numeric_guess', 'who_am_i', 'fibbing'],
      };
    case 'quick_mixed':
      return {
        format: 'mixed',
        roundCount: 5,
        teams: false,
        categoryIds: [...allCategories],
      };

    case 'football_night': {
      const hasFootball = allCategories.includes(FOOTBALL_CATEGORY_ID);
      return {
        format: 'mixed',
        roundCount: 10,
        teams: false,
        categoryIds: hasFootball ? [FOOTBALL_CATEGORY_ID] : [allCategories[0]!],
      };
    }

    case 'team_party':
      return {
        format: 'mixed',
        roundCount: 10,
        teams: true,
        categoryIds: [...allCategories],
      };
  }
}

export function isPresetActive(
  presetId: MatchPresetId,
  currentConfig: MatchConfig | undefined,
  availableCategoryIds: readonly string[],
): boolean {
  if (!currentConfig) return false;
  if (currentConfig.format !== 'mixed') return false;
  if (currentConfig.roundTypeId !== undefined) return false;

  const expected = buildPresetConfig(presetId, availableCategoryIds);
  if (JSON.stringify(currentConfig.roundTypeIds ?? []) !== JSON.stringify(expected.roundTypeIds ?? [])) return false;
  if (currentConfig.roundCount !== expected.roundCount) return false;
  if (currentConfig.teams !== expected.teams) return false;

  const currentSet = new Set(currentConfig.categoryIds);
  if (currentSet.size !== expected.categoryIds.length) return false;
  return expected.categoryIds.every((id) => currentSet.has(id));
}

export interface MatchPresetsProps {
  availableCategoryIds: readonly string[];
  onSelect: (config: MatchConfig, presetId: MatchPresetId) => void;
  currentConfig?: MatchConfig;
  playerCount?: number;
  disabled?: boolean;
}

export function MatchPresets({
  availableCategoryIds,
  onSelect,
  currentConfig,
  playerCount,
  disabled = false,
}: MatchPresetsProps) {
  const normalizedCategories = normalizeCategoryIds(availableCategoryIds);
  const footballAvailable = normalizedCategories.includes(FOOTBALL_CATEGORY_ID);

  return (
    <Card className="flex w-full min-w-0 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold text-body">خلطات جاهزة بنقرة واحدة</h2>
        <span className="text-xs text-muted">تقدر تعدّل أي إعداد بعدها</span>
      </div>

      <div className="grid grid-cols-1 gap-2.5">
        {MATCH_PRESETS.map((preset) => {
          const active = isPresetActive(preset.id, currentConfig, normalizedCategories);
          const isFootballUnavailable = ['football_night', 'football_derby'].includes(preset.id) && !footballAvailable;
          const buttonDisabled = disabled || isFootballUnavailable;

          return (
            <button
              key={preset.id}
              type="button"
              disabled={buttonDisabled}
              aria-pressed={active}
              onClick={() => {
                const freshConfig = buildPresetConfig(preset.id, normalizedCategories);
                onSelect(freshConfig, preset.id);
              }}
              className={`flex min-h-14 w-full min-w-0 flex-col gap-1.5 rounded-2xl border p-3.5 text-start transition active:scale-[0.99] disabled:opacity-40 disabled:active:scale-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${
                active
                  ? 'border-[var(--accent)] bg-surface-2 text-body'
                  : 'border-line bg-surface text-body hover:border-muted'
              }`}
            >
              <div className="flex w-full flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-base font-black">
                  <span aria-hidden="true" className="text-xl">
                    {preset.emoji}
                  </span>
                  <span>{preset.titleAr}</span>
                </span>
                <span
                  className={`tabular rounded-full px-2.5 py-0.5 text-xs font-bold ${
                    active ? 'bg-[var(--accent)] text-ink' : 'bg-surface-2 text-muted'
                  }`}
                >
                  {preset.badgeAr}
                </span>
              </div>

              <p className="text-xs leading-relaxed text-muted">{preset.subtitleAr}</p>

              {preset.noteAr ? (
                <p
                  className="mt-0.5 rounded-xl bg-surface-2/80 px-2.5 py-1.5 text-[11px] leading-relaxed font-semibold"
                  style={{
                    color:
                      playerCount !== undefined && playerCount < 4
                        ? 'var(--color-accent-amber)'
                        : 'var(--color-muted)',
                  }}
                >
                  {preset.noteAr}
                </p>
              ) : null}
            </button>
          );
        })}
      </div>
    </Card>
  );
}
