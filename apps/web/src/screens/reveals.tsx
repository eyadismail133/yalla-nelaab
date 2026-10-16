import type { ReactNode } from 'react';
import { TEAMS } from '@game/shared';
import { ar } from '../i18n/ar.js';

/**
 * The post-round reveal, one renderer per round type.
 *
 * A registry rather than a chain of `if (typeId === ...)` in the result screen, for the same
 * reason the round types themselves are a registry: adding a game should be adding an entry,
 * not editing a function that every other game also runs through. The chain it replaces had
 * quietly stopped covering half the games — six types fell through to `null` and showed players
 * an empty card under the heading "الإجابة الصح" for six seconds.
 *
 * Each renderer receives that type's `reveal()` payload verbatim, plus a name lookup, since
 * the payloads carry player ids and the screen has the roster.
 */

export type NameOf = (playerId: string) => string;

interface RevealProps<T> {
  reveal: T;
  nameOf: NameOf;
}

/* ------------------------------------------------------------------ shared pieces */

function Headline({ children }: { children: ReactNode }) {
  return (
    <p className="text-balance mt-2 text-3xl font-black" style={{ color: 'var(--accent)' }}>
      {children}
    </p>
  );
}

function Explanation({ text }: { text: string | null }) {
  if (!text) return null;
  return <p className="mt-3 text-sm text-muted">{text}</p>;
}

/** A short list of players under a reveal — who solved it, who got robbed, who made their bid. */
function PlayerNotes({ notes }: { notes: Array<{ key: string; label: string; tone?: 'good' | 'bad' }> }) {
  if (notes.length === 0) return null;
  return (
    <ul className="mt-3 flex flex-col gap-1.5 text-start text-sm">
      {notes.map((note) => (
        <li
          key={note.key}
          className="rounded-xl bg-surface-2 px-3 py-2"
          style={
            note.tone
              ? {
                  color:
                    note.tone === 'good'
                      ? 'var(--color-accent-emerald)'
                      : 'var(--color-accent-rose)',
                }
              : undefined
          }
        >
          {note.label}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ سباق الإجابات / السرقة */

interface McqReveal {
  options: string[];
  correctIndex: number;
  explanationAr: string | null;
}

function McqRaceReveal({ reveal }: RevealProps<McqReveal>) {
  return (
    <>
      <Headline>{reveal.options[reveal.correctIndex]}</Headline>
      <Explanation text={reveal.explanationAr} />
    </>
  );
}

interface StealReveal extends McqReveal {
  steals: Array<{ thiefId: string; victimId: string; succeeded: boolean }>;
}

/**
 * The heist is the round, so the reveal leads with the answer and then names every attempt.
 * A steal that failed is as satisfying to see as one that landed.
 */
function StealReveal({ reveal, nameOf }: RevealProps<StealReveal>) {
  return (
    <>
      <Headline>{reveal.options[reveal.correctIndex]}</Headline>
      <Explanation text={reveal.explanationAr} />
      <PlayerNotes
        notes={reveal.steals.map((s) => ({
          key: `${s.thiefId}-${s.victimId}`,
          tone: s.succeeded ? 'good' : 'bad',
          label: s.succeeded
            ? `${nameOf(s.thiefId)} سرق من ${nameOf(s.victimId)} ✓`
            : `${nameOf(s.thiefId)} حاول يسرق من ${nameOf(s.victimId)} وفشل ✗`,
        }))}
      />
    </>
  );
}

/* ------------------------------------------------------------------ خمّن التاريخ */

interface NumericReveal {
  correctValue: number;
  unitAr: string | null;
  explanationAr: string | null;
  guesses: Record<string, number>;
}

function NumericGuessReveal({ reveal, nameOf }: RevealProps<NumericReveal>) {
  // Sorted by how close each guess was, which is exactly how the round scored them.
  const byDistance = Object.entries(reveal.guesses).sort(
    (a, b) => Math.abs(a[1] - reveal.correctValue) - Math.abs(b[1] - reveal.correctValue),
  );

  return (
    <>
      <p className="tabular mt-2 text-4xl font-black" style={{ color: 'var(--accent)' }}>
        {reveal.correctValue.toLocaleString('en-US')}
        {reveal.unitAr ? <span className="ms-2 text-lg text-muted">{reveal.unitAr}</span> : null}
      </p>
      <Explanation text={reveal.explanationAr} />
      <PlayerNotes
        notes={byDistance.map(([playerId, value]) => ({
          key: playerId,
          label: `${nameOf(playerId)}: ${value.toLocaleString('en-US')}`,
        }))}
      />
    </>
  );
}

/* ------------------------------------------------------------------ صح ولا غلط */

interface QuickfireReveal {
  items: Array<{ textAr: string; isTrue: boolean }>;
}

function QuickfireReveal({ reveal }: RevealProps<QuickfireReveal>) {
  return (
    <ul className="mt-3 flex flex-col gap-2 text-start">
      {reveal.items.map((item, i) => (
        <li key={i} className="flex items-start gap-2 text-sm">
          <span
            className="mt-0.5 shrink-0 font-black"
            style={{
              color: item.isTrue ? 'var(--color-accent-emerald)' : 'var(--color-accent-rose)',
            }}
          >
            {item.isTrue ? ar.trueLabel : ar.falseLabel}
          </span>
          <span className="text-body/80">{item.textAr}</span>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ الكلمة الناقصة */

interface FillBlankReveal {
  answerAr: string;
  explanationAr: string | null;
  solveOrder: string[];
}

function FillBlankReveal({ reveal, nameOf }: RevealProps<FillBlankReveal>) {
  return (
    <>
      <Headline>{reveal.answerAr}</Headline>
      <Explanation text={reveal.explanationAr} />
      {reveal.solveOrder.length > 0 ? (
        <p className="mt-3 text-sm text-muted">
          {ar.solvedIt}: {reveal.solveOrder.map(nameOf).join('، ')}
        </p>
      ) : (
        <p className="mt-3 text-sm text-muted">{ar.nobodyGotIt}</p>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ مين أنا؟ */

interface WhoAmIReveal {
  hints: string[];
  answerAr: string;
  explanationAr: string | null;
  solvedAtHint: Record<string, number>;
}

/**
 * The whole round is a bet on how early you dared to answer, so the reveal reports the hint
 * number each player committed on — that is the number they were actually playing against.
 */
function WhoAmIReveal({ reveal, nameOf }: RevealProps<WhoAmIReveal>) {
  const solvers = Object.entries(reveal.solvedAtHint).sort((a, b) => a[1] - b[1]);

  return (
    <>
      <Headline>{reveal.answerAr}</Headline>
      <ul className="mt-3 flex flex-col gap-1 text-start text-sm text-muted">
        {reveal.hints.map((hint, i) => (
          <li key={hint}>
            <span className="tabular me-2">{i + 1}.</span>
            {hint}
          </li>
        ))}
      </ul>
      <Explanation text={reveal.explanationAr} />
      <PlayerNotes
        notes={
          solvers.length > 0
            ? solvers.map(([playerId, hint]) => ({
                key: playerId,
                tone: 'good' as const,
                label: `${nameOf(playerId)} — ${ar.atHint} ${hint}`,
              }))
            : [{ key: 'none', label: ar.nobodyGotIt }]
        }
      />
    </>
  );
}

/* ------------------------------------------------------------------ رتّب صح */

interface OrderingReveal {
  correctOrder: string[];
  labels: string[];
  explanationAr: string | null;
}

function OrderingReveal({ reveal }: RevealProps<OrderingReveal>) {
  return (
    <>
      <ol className="mt-3 flex flex-col gap-2 text-start">
        {reveal.correctOrder.map((item, i) => (
          <li
            key={item}
            className="flex items-center gap-3 rounded-2xl border border-line px-4 py-2.5"
          >
            <span
              className="tabular grid size-7 shrink-0 place-items-center rounded-lg text-sm font-black text-ink"
              style={{ background: 'var(--accent)' }}
            >
              {i + 1}
            </span>
            <span className="flex-1 font-bold">{item}</span>
            {reveal.labels[i] ? (
              <span className="shrink-0 text-xs text-muted">{reveal.labels[i]}</span>
            ) : null}
          </li>
        ))}
      </ol>
      <Explanation text={reveal.explanationAr} />
    </>
  );
}

/* ------------------------------------------------------------------ المزايدة */

interface BiddingReveal {
  items: Array<{ textAr: string; options: string[]; correctIndex: number }>;
  results: Array<{ playerId: string; bid: number; got: number; made: boolean }>;
}

function BiddingReveal({ reveal, nameOf }: RevealProps<BiddingReveal>) {
  return (
    <>
      <ul className="mt-3 flex flex-col gap-2 text-start text-sm">
        {reveal.items.map((item) => (
          <li key={item.textAr} className="rounded-xl border border-line px-3 py-2">
            <p className="text-body/80">{item.textAr}</p>
            <p className="mt-1 font-black" style={{ color: 'var(--accent)' }}>
              {item.options[item.correctIndex]}
            </p>
          </li>
        ))}
      </ul>
      <PlayerNotes
        notes={reveal.results.map((r) => ({
          key: r.playerId,
          tone: r.made ? 'good' : 'bad',
          label: `${nameOf(r.playerId)} — ${ar.bidOf} ${r.bid}، ${ar.gotRight} ${r.got}`,
        }))}
      />
    </>
  );
}

/* ------------------------------------------------------------------ قطع الأرض */

interface LandGrabReveal {
  board: Array<{ cell: number; ownerId: string | null; textAr: string; answerAr: string }>;
  lines: Array<{ playerId: string; cells: number; lines: number }>;
}

/**
 * Nine questions is far too much to re-read on a six-second screen, so the reveal shows the
 * final map and the territory count — what players actually want to know is who took what.
 */
function LandGrabReveal({ reveal, nameOf }: RevealProps<LandGrabReveal>) {
  return (
    <>
      <div className="mx-auto mt-3 grid w-48 grid-cols-3 gap-1.5">
        {reveal.board.map((cell) => (
          <span
            key={cell.cell}
            className="tabular grid aspect-square place-items-center rounded-xl border text-sm font-black"
            style={
              cell.ownerId
                ? { background: 'var(--color-surface-2)', borderColor: 'var(--accent)' }
                : { borderColor: 'var(--color-line)', color: 'var(--color-muted)' }
            }
          >
            {cell.ownerId ? nameOf(cell.ownerId).slice(0, 1) : '—'}
          </span>
        ))}
      </div>
      <PlayerNotes
        notes={reveal.lines
          .filter((row) => row.cells > 0)
          .sort((a, b) => b.cells - a.cells)
          .map((row) => ({
            key: row.playerId,
            label: `${nameOf(row.playerId)} — ${row.cells} ${ar.cellsWord}${
              row.lines > 0 ? ` + ${ar.lineBonus}` : ''
            }`,
          }))}
      />
    </>
  );
}

/* ------------------------------------------------------------------ وصّفهالي */

interface DescribeItReveal {
  answerAr: string;
  explanationAr: string | null;
  clues: Record<string, string[]>;
  solvedOrder: string[];
  describerOf: Record<string, string>;
}

function DescribeItReveal({ reveal, nameOf }: RevealProps<DescribeItReveal>) {
  const allClues = Object.values(reveal.clues).flat();

  return (
    <>
      <Headline>{reveal.answerAr}</Headline>
      {/* The clues are the joke, and until now only the team that heard them ever saw them. */}
      {allClues.length > 0 ? (
        <div className="mt-3 flex flex-wrap justify-center gap-1.5">
          {allClues.map((clue, i) => (
            <span key={`${clue}-${i}`} className="rounded-full bg-surface-2 px-3 py-1 text-sm">
              {clue}
            </span>
          ))}
        </div>
      ) : null}
      <Explanation text={reveal.explanationAr} />
      <PlayerNotes
        notes={Object.entries(reveal.describerOf).map(([teamId, playerId]) => ({
          key: teamId,
          tone: reveal.solvedOrder.includes(teamId) ? 'good' : undefined,
          label: `${ar.describerWas} ${nameOf(playerId)}`,
        }))}
      />
    </>
  );
}

/* ------------------------------------------------------------------ الكذّابين */

interface FibbingReveal {
  answerAr: string;
  explanationAr: string | null;
  options: Array<{
    id: string;
    textAr: string;
    isTruth: boolean;
    authorIds: string[];
    voterIds: string[];
  }>;
}

/**
 * The reveal is where الكذّابين actually pays off — seeing that three people fell for your lie
 * is the whole reason to write a good one, so every option is listed with who wrote it and who
 * believed it, rather than just naming the correct answer.
 */
function FibbingReveal({ reveal, nameOf }: RevealProps<FibbingReveal>) {
  return (
    <div className="mt-3 flex flex-col gap-2 text-start">
      {reveal.options.map((option) => (
        <div
          key={option.id}
          className={`rounded-2xl border px-4 py-3 ${
            option.isTruth ? 'border-[var(--accent)] bg-surface-2' : 'border-line'
          }`}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-bold">{option.textAr}</span>
            {option.isTruth ? (
              <span className="shrink-0 text-xs font-black" style={{ color: 'var(--accent)' }}>
                {ar.theTruth}
              </span>
            ) : option.authorIds.length ? (
              <span className="shrink-0 text-xs text-muted">
                {ar.wroteIt}: {option.authorIds.map(nameOf).join('، ')}
              </span>
            ) : null}
          </div>
          {option.voterIds.length ? (
            <p className="mt-1 text-sm text-muted">
              {option.isTruth ? '✓' : ar.fooledBy}: {option.voterIds.map(nameOf).join('، ')}
            </p>
          ) : null}
        </div>
      ))}
      <Explanation text={reveal.explanationAr} />
    </div>
  );
}

/* ------------------------------------------------------------------ مين فينا؟ */

interface PollReveal {
  tally: Array<{ targetId: string; voterIds: string[]; count: number }>;
}

function WhoAmongUsReveal({ reveal, nameOf }: RevealProps<PollReveal>) {
  const top = reveal.tally[0]?.count ?? 0;

  return (
    <div className="mt-3 flex flex-col gap-2 text-start">
      {reveal.tally.map((row) => (
        <div
          key={row.targetId}
          className={`flex items-center gap-3 rounded-2xl border px-4 py-3 ${
            row.count === top ? 'border-[var(--accent)] bg-surface-2' : 'border-line'
          }`}
        >
          <span className="flex-1 font-bold">{nameOf(row.targetId)}</span>
          <span className="tabular text-lg font-black" style={{ color: 'var(--accent)' }}>
            {row.count}
          </span>
          <span className="text-xs text-muted">{ar.votes}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ الدخيل */

interface OddOneOutReveal {
  puzzles: Array<{
    textAr: string;
    items: string[];
    oddIndex: number;
    reasonAr: string;
    explanationAr: string | null;
  }>;
}

function OddOneOutReveal({ reveal }: RevealProps<OddOneOutReveal>) {
  return (
    <div className="mt-3 flex flex-col gap-3 text-start">
      {reveal.puzzles.map((puzzle) => (
        <div key={puzzle.textAr} className="rounded-2xl border border-line px-4 py-3">
          <p className="text-sm text-muted">{puzzle.textAr}</p>
          <p className="mt-1 font-black" style={{ color: 'var(--accent)' }}>
            {puzzle.items[puzzle.oddIndex]}
          </p>
          <p className="mt-1 text-sm text-muted">{puzzle.reasonAr}</p>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ إيموجي */

interface EmojiRushReveal {
  items: Array<{ emojis: string; answerAr: string; explanationAr: string | null }>;
  solved: Record<string, number>;
}

function EmojiRushReveal({ reveal, nameOf }: RevealProps<EmojiRushReveal>) {
  return (
    <div className="mt-3 flex flex-col gap-3">
      <ul className="flex flex-col gap-2 text-start text-sm">
        {reveal.items.map((item) => (
          <li
            key={item.emojis}
            className="flex items-center gap-3 rounded-xl border border-line px-3 py-2"
          >
            <span className="text-2xl">{item.emojis}</span>
            <span className="flex-1 font-bold">{item.answerAr}</span>
          </li>
        ))}
      </ul>
      <PlayerNotes
        notes={Object.entries(reveal.solved).map(([playerId, count]) => ({
          key: playerId,
          label: `${nameOf(playerId)} — ${count} / ${reveal.items.length}`,
        }))}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ السلّم */

interface LadderReveal {
  items: Array<{ textAr: string; options: string[]; correctIndex: number; explanationAr: string | null }>;
  results: Array<{ playerId: string; rung: number; busted: boolean; locked: boolean }>;
}

function LadderReveal({ reveal, nameOf }: RevealProps<LadderReveal>) {
  return (
    <div className="mt-3 flex flex-col gap-3 text-start">
      <ul className="flex flex-col gap-2 text-sm">
        {reveal.items.map((item) => (
          <li key={item.textAr} className="rounded-xl border border-line px-3 py-2">
            <p className="text-body/80">{item.textAr}</p>
            <p className="mt-1 font-black" style={{ color: 'var(--accent)' }}>
              {item.options[item.correctIndex]}
            </p>
          </li>
        ))}
      </ul>
      <PlayerNotes
        notes={reveal.results.map((r) => ({
          key: r.playerId,
          tone: r.busted ? 'bad' : r.locked ? 'good' : undefined,
          label: r.busted
            ? `${nameOf(r.playerId)} وقع عند درجة ${r.rung + 1}`
            : r.locked
              ? `${nameOf(r.playerId)} قفل عند درجة ${r.rung}`
              : `${nameOf(r.playerId)} ما قفلش`,
        }))}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ أعلى ولا أقل؟ */

interface HigherLowerReveal {
  pairs: Array<{
    index: number;
    a: { textAr: string; correctValue: number; unitAr: string | null };
    b: { textAr: string; correctValue: number; unitAr: string | null };
    correctSide: 'a' | 'b' | null;
  }>;
}

function HigherLowerReveal({ reveal }: RevealProps<HigherLowerReveal>) {
  return (
    <div className="mt-3 flex flex-col gap-3 text-start text-sm">
      {reveal.pairs.map((pair) => (
        <div key={pair.index} className="rounded-xl border border-line px-3 py-2">
          {(['a', 'b'] as const).map((side) => {
            const item = pair[side];
            const isCorrect = pair.correctSide === side;
            return (
              <div key={side} className="flex items-center justify-between gap-2">
                <span className={isCorrect ? 'font-black' : 'text-muted'}>{item.textAr}</span>
                <span
                  className="tabular shrink-0 font-black"
                  style={isCorrect ? { color: 'var(--accent)' } : undefined}
                >
                  {item.correctValue}
                  {item.unitAr ? ` ${item.unitAr}` : ''}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ التتابع */

interface RelayReveal {
  teams: Array<{
    teamId: string;
    finalRung: number;
    items: Array<{ textAr: string; options: string[]; correctIndex: number; answeredBy: string | null }>;
  }>;
}

const teamNameOf = (teamId: string): string => TEAMS.find((t) => t.id === teamId)?.nameAr ?? teamId;

function RelayReveal({ reveal, nameOf }: RevealProps<RelayReveal>) {
  return (
    <div className="mt-3 flex flex-col gap-4 text-start">
      {reveal.teams.map((team) => (
        <div key={team.teamId} className="rounded-2xl border border-line px-4 py-3">
          <p className="text-sm font-bold" style={{ color: 'var(--accent)' }}>
            {teamNameOf(team.teamId)} — درجة {team.finalRung} / {team.items.length}
          </p>
          <ul className="mt-2 flex flex-col gap-1.5 text-sm">
            {team.items.map((item) => (
              <li key={item.textAr} className="flex items-center justify-between gap-2">
                <span className="flex-1">{item.options[item.correctIndex]}</span>
                <span className="shrink-0 text-xs text-muted">
                  {item.answeredBy ? nameOf(item.answeredBy) : '—'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ اسم حيوان جماد بلاد */

interface WordRaceReveal {
  letter: string;
  fieldsAr: string[];
  explanationAr: string | null;
  table: Array<{
    authorId: string;
    fields: Array<{ text: string | null; rejected: boolean; rejectedCount: number }>;
  }>;
}

/**
 * The whole table at once — every field, every player — because the round's second half is
 * exactly this argument: whose answer survived and whose got voted out.
 */
function WordRaceReveal({ reveal, nameOf }: RevealProps<WordRaceReveal>) {
  return (
    <div className="mt-3 flex flex-col gap-1 text-start text-sm">
      <p className="mb-2 text-center text-xs text-muted">
        {ar.wordRaceLetterIs}: <span className="font-black">{reveal.letter}</span>
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-max border-collapse text-start">
          <thead>
            <tr>
              <th className="px-2 py-1 text-xs text-muted">؟</th>
              {reveal.fieldsAr.map((field) => (
                <th key={field} className="px-2 py-1 text-xs font-bold text-muted">
                  {field}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {reveal.table.map((row) => (
              <tr key={row.authorId}>
                <td className="whitespace-nowrap px-2 py-1.5 font-bold">{nameOf(row.authorId)}</td>
                {row.fields.map((field, i) => (
                  <td
                    key={i}
                    className={`whitespace-nowrap px-2 py-1.5 ${
                      field.rejected ? 'text-muted line-through' : ''
                    }`}
                  >
                    {field.text ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Explanation text={reveal.explanationAr} />
    </div>
  );
}

/* ------------------------------------------------------------------ the registry */

type RevealRenderer = (props: RevealProps<never>) => ReactNode;

/**
 * Keyed by round type id. `invariants.test.ts` on the server guarantees every registered type
 * appears here, so a new game cannot ship with a blank result screen.
 */
export const REVEALS: Record<string, RevealRenderer> = {
  mcq_race: McqRaceReveal as RevealRenderer,
  numeric_guess: NumericGuessReveal as RevealRenderer,
  quickfire_tf: QuickfireReveal as RevealRenderer,
  fill_blank: FillBlankReveal as RevealRenderer,
  fibbing: FibbingReveal as RevealRenderer,
  who_among_us: WhoAmongUsReveal as RevealRenderer,
  who_am_i: WhoAmIReveal as RevealRenderer,
  ordering: OrderingReveal as RevealRenderer,
  steal: StealReveal as RevealRenderer,
  bidding: BiddingReveal as RevealRenderer,
  land_grab: LandGrabReveal as RevealRenderer,
  describe_it: DescribeItReveal as RevealRenderer,
  odd_one_out: OddOneOutReveal as RevealRenderer,
  emoji_rush: EmojiRushReveal as RevealRenderer,
  ladder: LadderReveal as RevealRenderer,
  higher_lower: HigherLowerReveal as RevealRenderer,
  relay: RelayReveal as RevealRenderer,
  word_race: WordRaceReveal as RevealRenderer,
};
