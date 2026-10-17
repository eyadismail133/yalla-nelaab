/**
 * Classifies whether a session resume or room error represents a permanent room or seat loss
 * (requiring clearing local session credentials and returning to the home screen) or a
 * temporary network, lease, command, or timeout failure (which preserves credentials for retry).
 */
export function isPermanentSessionError(error: string | null | undefined): boolean {
  if (!error) return false;
  const msg = error.trim();
  if (!msg) return false;

  // 1. Explicit permanent recovery window expiration:
  // When the 60s host recovery window is over ('انتهت مهلة استعادة الغرفة (60 ثانية)'),
  // the room is permanently unrecoverable and must clear the saved seat.
  if (
    msg.includes('انتهت مهلة استعادة الغرفة') ||
    (msg.includes('مهلة استعادة') && msg.includes('الغرفة'))
  ) {
    return true;
  }

  // 2. Explicit temporary command/lease/join timeouts and network issues:
  // Command timeouts ('انتهت مهلة الطلب', 'انتهت مهلة الانضمام', 'انتهت صلاحية الأمر')
  // and lease expiration ('انتهت صلاحية الحجز', 'انتهت مدة الحجز') must NEVER clear saved session credentials.
  if (
    msg.includes('مهلة الطلب') ||
    msg.includes('مهلة الانضمام') ||
    msg.includes('صلاحية الأمر') ||
    msg.includes('مدة الأمر') ||
    msg.includes('مهلة الأمر') ||
    msg.includes('صلاحية الحجز') ||
    msg.includes('مدة الحجز') ||
    msg.includes('مهلة الحجز') ||
    msg.includes('حجز الغرفة') ||
    msg.includes('الاتصال') ||
    msg.includes('الخانات مشغولة') ||
    msg.includes('قيد التنفيذ') ||
    msg.includes('شبكة')
  ) {
    return false;
  }

  // 3. Genuine permanent room/session/seat expiration:
  const isRoomOrSeatExpired =
    msg.includes('صلاحية المقعد') ||
    msg.includes('صلاحية مقعدك') ||
    msg.includes('مدة المقعد') ||
    msg.includes('مدة مقعدك') ||
    msg.includes('صلاحية الغرفة') ||
    msg.includes('مدة الغرفة') ||
    msg.includes('صلاحية الجلسة') ||
    msg.includes('مدة الجلسة') ||
    msg.includes('انتهت الجلسة') ||
    msg.includes('أو انتهت');

  // 4. Closed room:
  const isRoomClosed = msg.includes('مقفولة') || msg.includes('مغلقة');

  // 5. Non-existent room:
  const isRoomMissing = msg.includes('مش موجودة') || msg.includes('غير موجودة');

  // 6. Lost seat / unregistered player:
  const isSeatLost =
    msg.includes('مش لاقيين') ||
    msg.includes('غير مسجل') ||
    msg.includes('اللاعب ده مش موجود');

  // 7. Kicked / evicted:
  const isKicked = msg.includes('استبعاد') || msg.includes('طردك');

  return isRoomOrSeatExpired || isRoomClosed || isRoomMissing || isSeatLost || isKicked;
}
