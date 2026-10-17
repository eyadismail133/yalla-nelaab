import { useState } from 'react';
import type { AnyRoundType, Category } from '@game/shared';
import { ROUND_TYPES } from '@game/rounds';
import { CATEGORIES } from '../content/index.js';
import { Card, Pill } from '../ui/primitives.js';

export interface GameExample {
  promptAr: string;
  playAr: string;
  outcomeAr: string;
}

export type CatalogFilter = 'all' | 'fast' | 'thinking' | 'teams' | 'eligible';

export interface GameEligibility {
  eligible: boolean;
  reasonsAr: string[];
  badgeAr: string;
  statusAr: string;
  minPlayers: number;
  requiresTeams: boolean;
}

export interface CatalogEntry {
  id: string;
  nameAr: string;
  taglineAr: string;
  scoringHintAr: string;
  minPlayers: number;
  requiresTeams: boolean;
  pacing: 'fast' | 'thinking';
  long: boolean;
  accent: string;
  example: GameExample;
  eligibility: GameEligibility;
}

export interface HowToPlayStep {
  stepNumber: 1 | 2 | 3;
  titleAr: string;
  detailAr: string;
}

export const HOW_TO_PLAY_STEPS: readonly HowToPlayStep[] = [
  {
    stepNumber: 1,
    titleAr: 'افتح غرفة أو ادخل بكود من موبايلك',
    detailAr:
      'اكتب اسمك واعمل غرفة في ثانية، أو ادخل بكود من ٥ حروف مع أصحابك من غير حساب ولا تحميل.',
  },
  {
    stepNumber: 2,
    titleAr: 'اختاروا الخلطة أو نظام الفرق والمجالات',
    detailAr:
      'الهوست بيختار من ١٤ مجال مختلف أو يفعّل نظام الفرق، واللعب بيشتغل من ٢ لحد ٨ لاعيبة في نفس الغرفة.',
  },
  {
    stepNumber: 3,
    titleAr: 'العبوا جولات متنوعة واحسموا الصدارة',
    detailAr:
      'كل جولة بتغيّر شكل الشاشة وطريقة اللعب، وسؤال الحسم في الآخر بـ ×٢ نقط عشان المنافسة تفضل مولّعة للآخر.',
  },
];

/**
 * Concrete illustrative examples keyed by canonical round type id.
 * Names, rules, scoring hints, and player/team minimums always come from `ROUND_TYPES`.
 */
export const GAME_EXAMPLES: Readonly<Record<string, GameExample>> = {
  mcq_race: {
    promptAr: 'سؤال على الشاشة: «مين الهداف التاريخي لمنتخب مصر؟» مع ٤ اختيارات.',
    playAr: 'أحمد وسارة داسوا «حسام حسن» في أول ٣ ثواني، وكريم جاوب صح بعدها بـ ٨ ثواني.',
    outcomeAr: 'أحمد وسارة خدوا ٢٠٠ نقطة كاملة، وكريم خد نقط الإجابة الصح مع بونص سرعة أقل.',
  },
  numeric_guess: {
    promptAr: 'سؤال رقمي: «في أي سنة اتأسس النادي الأهلي؟» من غير اختيارات.',
    playAr: 'سارة كتبت ١٩٠٧ بالظبط، وأحمد كتب ١٩٠٩، وكريم كتب ١٩٢٠.',
    outcomeAr: 'سارة جابت العلامة الكاملة ٢٠٠ نقطة، وأحمد خد ١٥٠ لأنه الأقرب، وكريم ١١٠.',
  },
  quickfire_tf: {
    promptAr: '٥ عبارات ورا بعض في ٢٤ ثانية مثلًا: «نهر النيل بيصب في البحر الأحمر».',
    playAr: 'كل لاعب بيجري لوحده ويحكم «صح» أو «غلط» — الاستعجال بغلط بيخصم ٢٠ نقطة.',
    outcomeAr: 'اللي يجاوب الـ ٥ صح ياخد ٢٠٠ نقطة، واللي يغامر ويغلط بينقص من رصيده.',
  },
  fill_blank: {
    promptAr: 'جملة ناقصة: «اللي اختشوا ____» ومعاك ٣ محاولات للكتابة.',
    playAr: 'تكتب الكلمة الناقصة «ماتوا» بإيدك؛ العربي بيقبل الهمزات والتاء المربوطة بمرونة.',
    outcomeAr: 'الإجابة الصح في أول ٦ ثواني بتديك ٢٠٠ نقطة، وبعدها البونص بيقل بالتدريج.',
  },
  fibbing: {
    promptAr: 'سؤال غريب: «إيه الاسم القديم لمدينة طوكيو؟» والكل يكتب إجابة مضروبة.',
    playAr: 'تظهر كذبات اللاعيبة وسط الإجابة الصح «إيدو»، وكل واحد يصوّت على اللي فاكرها حقيقية.',
    outcomeAr: 'لو قفشت الحقيقة تاخد ١٠٠ نقطة، وكل صاحب يقع في كذبتك بيزوّد رصيدك.',
  },
  who_among_us: {
    promptAr: 'سؤال عن الشلة: «مين أكتر واحد فينا بيقول جاي في السكة وهو لسه في البيت؟».',
    playAr: 'مفيش إجابة علمية — كل لاعب بيصوّت على اسم واحد من الموجودين في الغرفة.',
    outcomeAr: 'كل ما اختيارك يتفق مع أغلبية الغرفة، تاخد نقط أعلى لحد ٢٠٠ نقطة.',
  },
  who_am_i: {
    promptAr: 'أربع تلميحات تدريجية عن شخصية أو نادي تبدأ غامضة وتوضح كل ٩ ثواني.',
    playAr: 'التلميح الأول صعب وبـ ٢٠٠ نقطة؛ لو استنيت التلميح التالت هتعرفها أسهل بس بـ ١٠٠ نقطة.',
    outcomeAr: 'اللي يخمّن من أول تلميح يكسب الصدارة، واللي يتسرّع ليه عدد محاولات محدود.',
  },
  ordering: {
    promptAr: '٤ أحداث أو أرقام مطلوبة بالترتيب: «رتّب كؤوس العالم دي من الأقدم للأحدث».',
    playAr: 'تدوس على الاختيارات بالترتيب واحد ورا التاني، وتقدر ترجع خطوة قبل ما تقفل إجابتك.',
    outcomeAr: 'كل عنصر في مكانه الصح بـ ٥٠ نقطة — الترتيب الكامل المظبوط بـ ٢٠٠ نقطة.',
  },
  steal: {
    promptAr: 'سؤال اختيارات عادي في الأول، وبعد ما الكل يجاوب بتفتح مرحلة السرقة.',
    playAr: 'لو جاوبت صح، تختار لاعب تاني تسرق منه لو شاكك إنه جاوب غلط — أو تعدّي من غير مخاطرة.',
    outcomeAr: 'السرقة الناجحة بتزوّدك ٨٠ نقطة فوق الـ ١٢٠، بس لو طلع مجاوب صح بتخسر ٤٠ نقطة!',
  },
  bidding: {
    promptAr: 'قبل ما تشوف الـ ٤ أسئلة، تقرر هتقدر تجاوب كام واحد صح (من ١ لـ ٤).',
    playAr: 'لو زايدت بـ ٣، لازم تجيب ٣ صح على الأقل في مرحلة الأسئلة عشان تاخد نقطك.',
    outcomeAr: 'لو وفيت بمزايدتك تاخد (المزايدة × ٥٠ نقطة)، ولو نقصت سؤال واحد تخرج بصفر.',
  },
  land_grab: {
    promptAr: 'شبكة مربعات على الشاشة، كل مربع فاضي وراه سؤال مستقل.',
    playAr: 'تختار مربع وتجاوب سؤاله صح عشان تلونه بلونك وتعمل خطوط متصلة قبل غيرك.',
    outcomeAr: 'كل مربع بتملكه بينقّطك، وتقفيل صف أو عمود كامل بيديك بونص إضافي.',
  },
  describe_it: {
    promptAr: 'كلمة سرية بتظهر لواحد بس في كل فريق (مثلًا: «كشري») والباقي بيخمّنوا.',
    playAr: 'الواصف يبعت تلميحات مكتوبة لفريقه من غير ما يكتب الكلمة نفسها أو جزء منها.',
    outcomeAr: 'أول فريق يعرف الكلمة بيكسب ٢٠٠ نقطة لكل أعضائه، والفريق التاني ١٣٠ لو لحق يحلها.',
  },
  odd_one_out: {
    promptAr: '٣ مجموعات ورا بعض، كل مجموعة فيها ٤ كلمات وتلاتة منهم بس ليهم رابط مشترك.',
    playAr: 'في مجموعة «ريال مدريد، برشلونة، ليفربول، إشبيلية» تدوس على «ليفربول» لأنه برا إسبانيا.',
    outcomeAr: 'كل مجموعة صح بـ ٦٧ نقطة تقريبًا، والتلاتة صح مع بعض بـ ٢٠٠ نقطة.',
  },
  emoji_rush: {
    promptAr: '٥ ألغاز مرسومة بالإيموجي بس، زي «🦁👑» أو «🕷️🧑».',
    playAr: 'تكتب اسم الفيلم أو المصطلح بالعربي وتتنقل للغز اللي بعده فورًا خلال الدقيقة.',
    outcomeAr: 'كل لغز بتحله بـ ٤٠ نقطة — حل الخمسة كلهم يديك ٢٠٠ نقطة.',
  },
  ladder: {
    promptAr: 'سلّم من ٥ درجات: كل سؤال صح يطلعك درجة أعلى، بس الغلطة بتوقعك لصفر.',
    playAr: 'بعد كل إجابة صح تقرر: تكمل للسؤال الأصعب ولا تدوس «اقفل واحفظ» وتأمن نقطك؟',
    outcomeAr:
      'الدرجات بـ ٢٥ ثم ٦٠ ثم ١١٠ ثم ١٥٥ لحد ٢٠٠ نقطة — لازم تقفل عشان تأمن، بس الوصول إلى الدرجة الخامسة بيقفل ويحفظ الـ ٢٠٠ تلقائيًا.',
  },
  higher_lower: {
    promptAr: '٤ مقارنات سريعة بين رقمين من غير ما تشوف القيمة، زي «عدد أهداف صلاح» ولا «عدد أهداف ميسي».',
    playAr: 'تختار بسرعة مين فيهم رقمه أكبر في كل زوج من الأربعة.',
    outcomeAr: 'كل مقارنة صح بـ ٥٠ نقطة — ٤ من ٤ بيدوك ٢٠٠ نقطة.',
  },
  relay: {
    promptAr:
      'سباق تتابع بين الفريقين: السؤال بيظهر لأعضاء الفريق كلهم، بس واحد بس اللي يقدر يجاوب بالدور والباقي بيوجّهوه.',
    playAr: 'كل ما لاعب يجاوب صح الفريق يطلع درجة والدور يتنقل لزميله، والغلطة بترجع الفريق درجة.',
    outcomeAr:
      'النقط بتتحسب حسب الدرجة اللي الفريق وصلها — ٤ إجابات صح بتدي الـ ٢٠٠ نقطة كاملة للفريق.',
  },
  word_race: {
    promptAr: 'حرف عشوائي (مثلًا «م») وأربع خانات: اسم، حيوان، جماد، بلاد.',
    playAr: 'تملا الخانات بكلمات تبدأ بالحرف قبل الوقت، وبعدها اللاعيبة يراجعوا ويرفضوا الكلمات المضروبة.',
    outcomeAr: 'الكلمة الصحيحة بـ ٣٠ نقطة، ولو محدش غيرك كتبها تاخد ٢٠ نقطة زيادة للتميز.',
  },
};

const FALLBACK_EXAMPLE: GameExample = {
  promptAr: 'سؤال تفاعلي بيظهر لكل اللاعيبة في نفس اللحظة على الموبايل.',
  playAr: 'كل لاعب بيتفاعل حسب قانون الجولة قبل ما العد التنازلي يخلص.',
  outcomeAr: 'النقط بتتحسب تلقائيًا بحد أقصى ٢٠٠ نقطة للجولة العادية.',
};

export function evaluateGameEligibility(
  roundType: AnyRoundType,
  context?: { playerCount?: number; teams?: boolean },
): GameEligibility {
  const minPlayers = roundType.minPlayers;
  const requiresTeams = roundType.requiresTeams;

  const badgeAr = requiresTeams
    ? `فرق • ${minPlayers}+ لاعيبة`
    : `${minPlayers}+ لاعيبة`;

  const reasonsAr: string[] = [];

  if (context?.teams !== undefined && requiresTeams && !context.teams) {
    reasonsAr.push('محتاجة تفعيل نظام الفرق في إعدادات الغرفة');
  }

  if (context?.playerCount !== undefined && context.playerCount < minPlayers) {
    if (requiresTeams) {
      reasonsAr.push(
        `الألعاب التعاونية محتاجة ${minPlayers} لاعيبة على الأقل (الموجودين دلوقتي ${context.playerCount})`,
      );
    } else {
      reasonsAr.push(
        `محتاجة ${minPlayers} لاعيبة على الأقل (الموجودين دلوقتي ${context.playerCount})`,
      );
    }
  }

  const eligible = reasonsAr.length === 0;
  const hasContext = context?.playerCount !== undefined || context?.teams !== undefined;

  const statusAr = !eligible
    ? reasonsAr.join(' • ')
    : hasContext
      ? 'متاحة بالإعدادات الحالية ✓'
      : requiresTeams
        ? `تشتغل مع نظام الفرق ومن ${minPlayers} لاعيبة`
        : `تشتغل من ${minPlayers} لاعيبة`;

  return {
    eligible,
    reasonsAr,
    badgeAr,
    statusAr,
    minPlayers,
    requiresTeams,
  };
}

export function buildDiscoveryCatalog(
  context?: { playerCount?: number; teams?: boolean },
  filter: CatalogFilter = 'all',
  roundTypes: readonly AnyRoundType[] = ROUND_TYPES,
): CatalogEntry[] {
  const entries = roundTypes.map((type): CatalogEntry => ({
    id: type.id,
    nameAr: type.nameAr,
    taglineAr: type.taglineAr,
    scoringHintAr: type.scoringHintAr,
    minPlayers: type.minPlayers,
    requiresTeams: type.requiresTeams,
    pacing: type.pacing,
    long: type.long,
    accent: type.accent,
    example: GAME_EXAMPLES[type.id] ?? FALLBACK_EXAMPLE,
    eligibility: evaluateGameEligibility(type, context),
  }));

  switch (filter) {
    case 'fast':
      return entries.filter((entry) => entry.pacing === 'fast');
    case 'thinking':
      return entries.filter((entry) => entry.pacing === 'thinking');
    case 'teams':
      return entries.filter((entry) => entry.requiresTeams);
    case 'eligible':
      return entries.filter((entry) => entry.eligibility.eligible);
    case 'all':
    default:
      return entries;
  }
}

export function getDiscoveryCategories(): readonly Category[] {
  return CATEGORIES;
}

export interface GameDiscoveryProps {
  playerCount?: number;
  teams?: boolean;
  defaultCatalogOpen?: boolean;
  defaultHowToPlayOpen?: boolean;
  selectedRoundTypeId?: string;
  onSelectRoundType?: (roundTypeId: string) => void;
}

export function GameDiscovery({
  playerCount,
  teams,
  defaultCatalogOpen = false,
  defaultHowToPlayOpen = false,
  selectedRoundTypeId,
  onSelectRoundType,
}: GameDiscoveryProps) {
  const [filter, setFilter] = useState<CatalogFilter>('all');
  const hasRoomContext = playerCount !== undefined || teams !== undefined;

  const categories = getDiscoveryCategories();
  const allEntries = buildDiscoveryCatalog({ playerCount, teams }, 'all');
  const filteredEntries = buildDiscoveryCatalog({ playerCount, teams }, filter);
  const eligibleCount = allEntries.filter((e) => e.eligibility.eligible).length;

  const filterOptions: Array<{ id: CatalogFilter; labelAr: string }> = [
    { id: 'all', labelAr: `كل الألعاب (${allEntries.length})` },
    { id: 'fast', labelAr: 'سريعة وحماسية' },
    { id: 'thinking', labelAr: 'تفكير وتكتيك' },
    { id: 'teams', labelAr: 'ألعاب الفرق' },
    ...(hasRoomContext
      ? [{ id: 'eligible' as const, labelAr: `متاحة دلوقتي (${eligibleCount})` }]
      : []),
  ];

  return (
    <section aria-label="دليل الألعاب والمجالات" className="flex w-full min-w-0 flex-col gap-3">
      {/* Compact expandable 3-step How to Play */}
      <details
        open={defaultHowToPlayOpen}
        className="group rounded-3xl border border-line bg-surface px-4 py-3 text-body"
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 font-bold select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]">
          <span className="flex items-center gap-2 text-base">
            <span aria-hidden="true">🎯</span>
            <span>إزاي بتتلعب؟ (٣ خطوات سريعة)</span>
          </span>
          <span className="rounded-full bg-surface-2 px-3 py-1 text-xs font-bold text-muted transition group-open:bg-[var(--accent)] group-open:text-ink">
            التفاصيل
          </span>
        </summary>

        <ol className="mt-3 flex flex-col gap-2.5 border-t border-line pt-3">
          {HOW_TO_PLAY_STEPS.map((step) => (
            <li
              key={step.stepNumber}
              className="flex items-start gap-3 rounded-2xl bg-surface-2 p-3"
            >
              <span
                className="tabular grid size-7 shrink-0 place-items-center rounded-full text-sm font-black text-ink"
                style={{ background: 'var(--accent)' }}
              >
                {step.stepNumber}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-bold text-body">{step.titleAr}</p>
                <p className="mt-0.5 text-sm leading-relaxed text-muted">{step.detailAr}</p>
              </div>
            </li>
          ))}
        </ol>
      </details>

      {/* Preview of all 14 categories from static metadata (zero question bank loading) */}
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold">
            مواضيع الأسئلة <span className="tabular text-sm text-muted">({categories.length} مجال)</span>
          </h2>
          <Pill>بدون تحميل مسبق</Pill>
        </div>
        <div className="flex flex-wrap gap-1.5" role="list" aria-label="قائمة المجالات">
          {categories.map((cat) => (
            <span
              key={cat.id}
              role="listitem"
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3 py-1 text-xs font-bold text-body"
            >
              <span aria-hidden="true">{cat.emoji}</span>
              <span>{cat.nameAr}</span>
            </span>
          ))}
        </div>
      </Card>

      {/* Default-collapsed browsable catalog of all 18 games from ROUND_TYPES */}
      <details
        open={defaultCatalogOpen}
        className="group rounded-3xl border border-line bg-surface px-4 py-3 text-body"
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 font-bold select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]">
          <div className="min-w-0">
            <span className="block text-base">
              كتالوج الألعاب <span className="tabular text-sm text-muted">({allEntries.length} لعبة)</span>
            </span>
            <span className="block text-xs font-normal text-muted">
              {hasRoomContext
                ? `${eligibleCount} من ${allEntries.length} متاحة بإعدادات الغرفة الحالية — تقدر تتصفح الكل`
                : 'تصفح القوانين، طريقة الحساب، ومثال لكل لعبة'}
            </span>
          </div>
          <span className="shrink-0 rounded-full bg-surface-2 px-3 py-1 text-xs font-bold text-muted transition group-open:bg-[var(--accent)] group-open:text-ink">
            استكشف
          </span>
        </summary>

        <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
          {/* Filter chips */}
          <div
            role="toolbar"
            aria-label="تصفية الألعاب"
            className="flex flex-wrap gap-1.5"
          >
            {filterOptions.map((option) => {
              const active = filter === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setFilter(option.id)}
                  className={`min-h-9 rounded-full border px-3 py-1 text-xs font-bold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${
                    active
                      ? 'border-[var(--accent)] bg-surface-2 text-body'
                      : 'border-line bg-surface text-muted hover:text-body'
                  }`}
                >
                  {option.labelAr}
                </button>
              );
            })}
          </div>

          {/* Games list */}
          <div className="flex flex-col gap-2.5">
            {filteredEntries.map((game) => {
              const accentVar = `var(--color-accent-${game.accent})`;
              const isSelected = selectedRoundTypeId === game.id;

              return (
                <article
                  key={game.id}
                  className={`flex flex-col gap-2 rounded-2xl border p-3.5 transition ${
                    isSelected
                      ? 'border-[var(--accent)] bg-surface-2'
                      : 'border-line bg-surface-2/60'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="size-3 shrink-0 rounded-full"
                        style={{ background: accentVar }}
                      />
                      <h3 className="text-base font-black text-body">{game.nameAr}</h3>
                      {game.long ? (
                        <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] font-bold text-muted">
                          جولة مطوّلة ×٢
                        </span>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="tabular rounded-full bg-surface px-2.5 py-0.5 text-xs font-bold text-muted">
                        {game.eligibility.badgeAr}
                      </span>
                      <span className="rounded-full bg-surface px-2.5 py-0.5 text-xs font-bold text-muted">
                        {game.pacing === 'fast' ? '⚡ سريعة' : '🧠 تفكير'}
                      </span>
                    </div>
                  </div>

                  {/* One-line rule from registry */}
                  <p className="text-sm font-semibold leading-snug text-body">
                    {game.taglineAr}
                  </p>

                  {/* Scoring hint from registry */}
                  <p className="text-xs leading-relaxed text-muted">
                    <span className="font-bold text-body">النقط: </span>
                    {game.scoringHintAr}
                  </p>

                  {/* Eligibility explanation when context is provided or when teams are required */}
                  <p
                    className={`text-xs font-bold ${
                      game.eligibility.eligible ? 'text-accent-emerald' : 'text-accent-amber'
                    }`}
                    style={{
                      color: game.eligibility.eligible
                        ? 'var(--color-accent-emerald)'
                        : 'var(--color-accent-amber)',
                    }}
                  >
                    {game.eligibility.statusAr}
                  </p>

                  {/* Expandable short illustrative example per game */}
                  <details className="mt-1 rounded-xl border border-line bg-surface px-3 py-2">
                    <summary className="cursor-pointer text-xs font-bold text-muted select-none hover:text-body focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]">
                      شوف مثال سريع ازاي بتتلعب
                    </summary>
                    <div className="mt-2 flex flex-col gap-1.5 border-t border-line pt-2 text-xs leading-relaxed">
                      <p className="text-body">
                        <span className="font-bold" style={{ color: accentVar }}>
                          الموقف:{' '}
                        </span>
                        {game.example.promptAr}
                      </p>
                      <p className="text-muted">
                        <span className="font-bold text-body">اللعب: </span>
                        {game.example.playAr}
                      </p>
                      <p className="text-muted">
                        <span className="font-bold text-body">النتيجة: </span>
                        {game.example.outcomeAr}
                      </p>
                    </div>
                  </details>

                  {onSelectRoundType ? (
                    <button
                      type="button"
                      onClick={() => onSelectRoundType(game.id)}
                      className={`mt-1 min-h-10 w-full rounded-xl border px-3 py-1.5 text-xs font-bold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${
                        isSelected
                          ? 'border-[var(--accent)] bg-[var(--accent)] text-ink'
                          : 'border-line bg-surface text-body hover:border-[var(--accent)]'
                      }`}
                    >
                      {isSelected ? 'اللعبة المختارة حاليًا ✓' : `اختار «${game.nameAr}»`}
                    </button>
                  ) : null}
                </article>
              );
            })}
          </div>
        </div>
      </details>
    </section>
  );
}
