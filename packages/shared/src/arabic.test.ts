import { describe, expect, it } from 'vitest';
import { answersMatch, normalizeArabic, normalizeDigits, parseNumericAnswer } from './arabic.js';

describe('normalizeArabic', () => {
  it('strips tashkeel', () => {
    expect(normalizeArabic('مِصْر')).toBe(normalizeArabic('مصر'));
  });

  it('unifies the hamza forms of alef', () => {
    expect(normalizeArabic('أحمد')).toBe(normalizeArabic('احمد'));
    expect(normalizeArabic('إبراهيم')).toBe(normalizeArabic('ابراهيم'));
    expect(normalizeArabic('آسيا')).toBe(normalizeArabic('اسيا'));
  });

  it('unifies ta-marbuta with ha, which Egyptians type interchangeably', () => {
    expect(normalizeArabic('قاهرة')).toBe(normalizeArabic('قاهره'));
  });

  it('unifies alef-maqsura with ya', () => {
    expect(normalizeArabic('مصطفى')).toBe(normalizeArabic('مصطفي'));
  });

  it('removes tatweel elongation', () => {
    expect(normalizeArabic('محـــمد')).toBe(normalizeArabic('محمد'));
  });

  it('collapses whitespace and punctuation', () => {
    expect(normalizeArabic('  الأهلي!!  ')).toBe(normalizeArabic('الاهلي'));
  });
});

describe('normalizeDigits', () => {
  it('converts Arabic-Indic digits to Western', () => {
    expect(normalizeDigits('١٩٥٢')).toBe('1952');
  });

  it('converts Eastern Arabic-Indic digits to Western', () => {
    expect(normalizeDigits('۱۹۵۲')).toBe('1952');
  });
});

describe('answersMatch', () => {
  it('accepts an exact answer', () => {
    expect(answersMatch('الأهلي', 'الأهلي')).toBe(true);
  });

  it('accepts the answer with the definite article dropped', () => {
    expect(answersMatch('اهلي', 'الأهلي')).toBe(true);
  });

  it('accepts the answer with the definite article added', () => {
    expect(answersMatch('الزمالك', 'زمالك')).toBe(true);
  });

  it('accepts a declared alias', () => {
    expect(answersMatch('القلعة الحمراء', 'الأهلي', ['القلعة الحمراء'])).toBe(true);
  });

  it('rejects a different answer', () => {
    expect(answersMatch('الزمالك', 'الأهلي')).toBe(false);
  });

  it('rejects an empty answer', () => {
    expect(answersMatch('   ', 'الأهلي')).toBe(false);
  });

  it('does not strip "ال" from a short word where it is part of the root', () => {
    expect(answersMatch('الف', 'الف')).toBe(true);
  });
});

describe('parseNumericAnswer', () => {
  it('parses Western digits', () => {
    expect(parseNumericAnswer('1952')).toBe(1952);
  });

  it('parses Arabic-Indic digits', () => {
    expect(parseNumericAnswer('١٩٥٢')).toBe(1952);
  });

  it('ignores thousands separators and spaces', () => {
    expect(parseNumericAnswer('105,000,000')).toBe(105_000_000);
    expect(parseNumericAnswer(' 1 9 5 2 ')).toBe(1952);
  });

  it('parses decimals and negatives', () => {
    expect(parseNumericAnswer('3.5')).toBe(3.5);
    expect(parseNumericAnswer('-40')).toBe(-40);
  });

  it('rejects non-numeric text', () => {
    expect(parseNumericAnswer('حاجة')).toBeNull();
    expect(parseNumericAnswer('')).toBeNull();
    expect(parseNumericAnswer('12abc')).toBeNull();
  });
});
