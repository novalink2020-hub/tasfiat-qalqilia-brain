export const seenMessageIds = new Set();

// خيارات مرقمة (مرحلة 2)
export const choiceMemory = new Map();

// ===== Session Memory (NO labels dependency) =====
// آخر رسالة واردة من المستخدم (لمنع المتابعة إذا كان تفاعل حديث)
export const lastIncomingAt = new Map(); // convId -> timestamp

// آخر مرة صار فيها "Lead سلة" (بعد product hit / selection)
export const cartLeadAt = new Map(); // convId -> timestamp

// إحصائيات المتابعة لكل جلسة
export const followupStats = new Map(); // convId -> { sentCount, lastSentAt }

// إعدادات Throttle
export const FOLLOWUP_RULES = {
  delayMs: 90 * 1000,          // 90 ثانية
  maxPerSession: 2,            // مرة/مرتين كحد أقصى
  minGapMs: 15 * 60 * 1000,    // أقل فرق بين المتابعات (15 دقيقة)
  leadTtlMs: 30 * 60 * 1000,   // صلاحية lead للسلة (30 دقيقة)
  silentWindowMs: 90 * 1000    // المستخدم لازم يكون ساكت آخر 90 ثانية
};

export function getFollowupStat(convId) {
  const cur = followupStats.get(convId) || { sentCount: 0, lastSentAt: 0 };
  return cur;
}

export function bumpFollowupSent(convId) {
  const cur = getFollowupStat(convId);
  cur.sentCount += 1;
  cur.lastSentAt = Date.now();
  followupStats.set(convId, cur);
}

export function canSendFollowupNow(convId) {
  const now = Date.now();

  const leadAt = cartLeadAt.get(convId) || 0;
  if (!leadAt || (now - leadAt) > FOLLOWUP_RULES.leadTtlMs) return { ok: false, why: "no_recent_cart_lead" };

  const lastIn = lastIncomingAt.get(convId) || 0;
  if (lastIn && (now - lastIn) < FOLLOWUP_RULES.silentWindowMs) return { ok: false, why: "user_recently_active" };

  const st = getFollowupStat(convId);
  if (st.sentCount >= FOLLOWUP_RULES.maxPerSession) return { ok: false, why: "max_per_session_reached" };

  if (st.lastSentAt && (now - st.lastSentAt) < FOLLOWUP_RULES.minGapMs) return { ok: false, why: "min_gap_not_met" };

  return { ok: true };
}
