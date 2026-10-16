/**
 * Arabic text normalization.
 *
 * Needed for two jobs that both fail silently without it: matching a player's free-text answer
 * ("مصر" vs "مِصْر" vs "مصرر ") and detecting duplicate questions in the content pipeline.
 * Egyptian typing is inconsistent about hamza, ta-marbuta and ya — a strict comparison would
 * reject correct answers constantly and feel broken.
 */

/** Tashkeel (diacritics) and the tatweel elongation character. */
const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

const CHAR_MAP: Record<string, string> = {
  'أ': 'ا',
  'إ': 'ا',
  'آ': 'ا',
  'ٱ': 'ا',
  'ة': 'ه',
  'ى': 'ي',
  'ئ': 'ي',
  'ؤ': 'و',
  'ﻻ': 'لا',
};

/** Arabic-Indic and Eastern Arabic-Indic digits → Western, so "١٩٥٢" parses as 1952. */
const DIGIT_MAP: Record<string, string> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

export function normalizeDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, (d) => DIGIT_MAP[d] ?? d);
}

export function normalizeArabic(input: string): string {
  let out = input.normalize('NFKC').replace(DIACRITICS, '');
  out = out.replace(/[أإآٱةىئؤﻻ]/g, (c) => CHAR_MAP[c] ?? c);
  out = normalizeDigits(out);
  out = out.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  out = out.replace(/\s+/g, ' ').trim().toLowerCase();
  return out;
}

/**
 * Answer comparison for free-text rounds. Drops a leading "ال" on both sides so "الأهلي" and
 * "اهلي" match — players type both and either is plainly correct.
 */
export function answersMatch(given: string, expected: string, aliases: string[] = []): boolean {
  const strip = (s: string) => {
    const n = normalizeArabic(s);
    return n.startsWith('ال') && n.length > 3 ? n.slice(2) : n;
  };
  const g = strip(given);
  if (g.length === 0) return false;
  return [expected, ...aliases].some((candidate) => strip(candidate) === g);
}

/** Parses a numeric guess typed in either digit system, tolerating stray spaces and commas. */
export function parseNumericAnswer(input: string): number | null {
  const cleaned = normalizeDigits(input).replace(/[,\s٬]/g, '').replace(/[−–—]/g, '-');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}
