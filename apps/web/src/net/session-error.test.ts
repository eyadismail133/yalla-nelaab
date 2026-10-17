import { describe, expect, it } from 'vitest';
import { isPermanentSessionError } from './session-error.js';

describe('isPermanentSessionError', () => {
  describe('temporary command, lease, and network errors (must retain saved seat)', () => {
    const temporaryCases = [
      ['command timeout', 'انتهت مهلة الطلب — جرب تاني'],
      ['join timeout', 'انتهت مهلة الانضمام — جرب تاني'],
      ['command expiry', 'انتهت صلاحية الأمر'],
      ['command duration', 'انتهت مدة الأمر'],
      ['command deadline', 'انتهت مهلة الأمر'],
      ['lease expiry', 'انتهت صلاحية الحجز'],
      ['lease duration', 'انتهت مدة الحجز'],
      ['lease deadline', 'انتهت مهلة الحجز'],
      ['room lease duration phrasing', 'انتهت مدة حجز الغرفة'],
      ['generic connection issue', 'حصلت مشكلة في الاتصال'],
      ['database disconnection', 'فقدان الاتصال بقاعدة البيانات'],
      ['unready transport', 'الاتصال غير مهيأ'],
      ['failed connection', 'تعذر الاتصال بالخادم'],
      ['weak network', 'شبكة الاتصال ضعيفة'],
      ['busy join slots', 'الخانات مشغولة حالياً — جرب تاني بعد لحظات'],
      ['in-flight command conflict', 'يوجد أمر قيد التنفيذ حالياً'],
      ['generic unknown error', 'خطأ غير متوقع في الخادم'],
      ['unrecognized error', 'حدث خطأ غير معروف'],
    ];

    it.each(temporaryCases)('classifies %s as temporary: "%s"', (_description, errorMsg) => {
      expect(isPermanentSessionError(errorMsg)).toBe(false);
    });

    it('classifies null, undefined, and whitespace as false', () => {
      expect(isPermanentSessionError(null)).toBe(false);
      expect(isPermanentSessionError(undefined)).toBe(false);
      expect(isPermanentSessionError('')).toBe(false);
      expect(isPermanentSessionError('   ')).toBe(false);
    });
  });

  describe('permanent room, recovery window, and seat loss (must clear saved seat)', () => {
    const permanentCases = [
      ['host 60s recovery window expired', 'انتهت مهلة استعادة الغرفة (60 ثانية)'],
      ['host recovery window timeout', 'انتهت مهلة استعادة الغرفة'],
      ['guest seat expired / removed', 'تم استبعادك من الغرفة أو انتهت صلاحية المقعد'],
      ['seat expired', 'انتهت صلاحية المقعد'],
      ['seat expired (your seat)', 'انتهت صلاحية مقعدك'],
      ['seat duration ended', 'انتهت مدة المقعد'],
      ['room expired', 'انتهت صلاحية الغرفة'],
      ['room duration ended', 'انتهت مدة الغرفة'],
      ['room duration expired phrasing', 'انتهت مدة صلاحية الغرفة'],
      ['session expired', 'انتهت الجلسة'],
      ['session validity expired', 'انتهت صلاحية الجلسة'],
      ['room not found or ended', 'الغرفة غير موجودة أو انتهت'],
      ['closed room', 'الغرفة مقفولة'],
      ['closed room variant', 'الغرفة مغلقة'],
      ['room code missing or closed', 'الكود ده مش موجود أو الغرفة مقفولة'],
      ['missing room', 'الغرفة مش موجودة'],
      ['non-existent room', 'الغرفة غير موجودة'],
      ['missing seat', 'مش لاقيين مقعدك في الغرفة'],
      ['missing player', 'مش لاقيين اللاعب ده'],
      ['unregistered player', 'اللاعب غير مسجل في الغرفة'],
      ['player not in room', 'اللاعب ده مش موجود'],
      ['kicked player', 'تم استبعادك من الغرفة'],
      ['host kicked guest', 'تم طردك بواسطة الهوست'],
      ['direct kick word', 'استبعاد'],
      ['direct expulsion word', 'طردك'],
    ];

    it.each(permanentCases)('classifies %s as permanent: "%s"', (_description, errorMsg) => {
      expect(isPermanentSessionError(errorMsg)).toBe(true);
    });
  });
});
