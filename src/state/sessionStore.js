// src/state/sessionStore.js
// Session Store (Intercom-grade): soft memory per conversationId
// - Keeps user intent + constraints across messages (size/section/audience/brand/budget/deals/...)
// - TTL + periodic cleanup
// - No dependency on Chatwoot labels/tags (pure internal memory)

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 60 minutes
const CLEANUP_EVERY_MS = 10 * 60 * 1000; // 10 minutes

// convId -> session
const SESSIONS = new Map();

let _lastCleanupAt = 0;

function nowMs() {
  return Date.now();
}

function safeConvId(convId) {
  const id = String(convId ?? "").trim();
  return id || null;
}

function cleanupExpired_() {
  const now = nowMs();
  if (now - _lastCleanupAt < CLEANUP_EVERY_MS) return;
  _lastCleanupAt = now;

  for (const [k, s] of SESSIONS.entries()) {
    const ttl = Number(s?.ttl_ms || DEFAULT_TTL_MS);
    const last = Number(s?.last_seen_at || 0);
    if (!last) {
      SESSIONS.delete(k);
      continue;
    }
    if (now - last > ttl) {
      SESSIONS.delete(k);
    }
  }
}

function baseSession_(convId, ttlMs) {
  return {
    conv_id: convId,
    ttl_ms: Number(ttlMs || DEFAULT_TTL_MS),

    // soft constraints
    section: null, // "أحذية" | "ملابس" | "عطور"
    audience: null, // "رجالي" | "ستاتي" | "ولادي" | "بناتي"
    size: null, // number (e.g., 40)
    brand_std: null, // e.g., "NIKE"
    brand_key: null, // normalized key from engine's normKey
    intent_mode: "default", // "default" | "budget" | "deals" | "brand" | "premium"
    budget: null, // { value?: number, min?: number, max?: number }
    wants_discount: null, // boolean|null

    // interaction tracking
    last_seen_at: nowMs(),
    last_user_text: null,

    // purchase / cross-sell gating
    purchase_gate: {
      asked_at: null,
      confirmed: null, // true | false | null
      last_choice: null, // "1" | "2" | "3" | null
      cross_sell_shown: false
    },

    // misc flags
    flags: {
      // example toggles you might use later
      // pause_auto: false
    }
  };
}

function normalizePatch_(patch) {
  // We only accept known keys (avoid accidental junk)
  const out = {};

  if (!patch || typeof patch !== "object") return out;

  if (patch.section != null) out.section = patch.section || null;
  if (patch.audience != null) out.audience = patch.audience || null;

  if (patch.size != null) {
    const n = Number(patch.size);
    out.size = Number.isFinite(n) ? n : null;
  }

  if (patch.brand_std != null) out.brand_std = patch.brand_std || null;
  if (patch.brand_key != null) out.brand_key = patch.brand_key || null;

  if (patch.intent_mode != null) out.intent_mode = patch.intent_mode || "default";

  if (patch.budget != null) {
    const b = patch.budget;
    if (b && typeof b === "object") {
      out.budget = {
        value: Number.isFinite(Number(b.value)) ? Number(b.value) : null,
        min: Number.isFinite(Number(b.min)) ? Number(b.min) : null,
        max: Number.isFinite(Number(b.max)) ? Number(b.max) : null
      };
    } else {
      out.budget = null;
    }
  }

  if (patch.wants_discount != null) out.wants_discount = !!patch.wants_discount;

  if (patch.last_user_text != null) out.last_user_text = String(patch.last_user_text || "").trim() || null;

  if (patch.purchase_gate != null && typeof patch.purchase_gate === "object") {
    const pg = patch.purchase_gate;
    out.purchase_gate = {};
    if ("asked_at" in pg) out.purchase_gate.asked_at = pg.asked_at ? Number(pg.asked_at) : null;
    if ("confirmed" in pg) out.purchase_gate.confirmed = (pg.confirmed === true) ? true : (pg.confirmed === false ? false : null);
    if ("last_choice" in pg) out.purchase_gate.last_choice = pg.last_choice ? String(pg.last_choice) : null;
    if ("cross_sell_shown" in pg) out.purchase_gate.cross_sell_shown = !!pg.cross_sell_shown;
  }

  if (patch.flags != null && typeof patch.flags === "object") {
    out.flags = { ...patch.flags };
  }

  return out;
}

function deepMerge_(base, patch) {
  // Minimal deep merge for purchase_gate + flags
  const out = { ...base, ...patch };

  if (patch.purchase_gate) {
    out.purchase_gate = { ...(base.purchase_gate || {}), ...(patch.purchase_gate || {}) };
  }
  if (patch.flags) {
    out.flags = { ...(base.flags || {}), ...(patch.flags || {}) };
  }

  return out;
}

// ============== Public API ==============

/**
 * Get session for conversation.
 * Creates if missing.
 */
export function getSession(convId, opts = {}) {
  cleanupExpired_();
  const id = safeConvId(convId);
  if (!id) return null;

  const ttlMs = Number(opts.ttl_ms || DEFAULT_TTL_MS);

  let s = SESSIONS.get(id);
  if (!s) {
    s = baseSession_(id, ttlMs);
    SESSIONS.set(id, s);
    return s;
  }

  // refresh seen time on read too (soft)
  s.last_seen_at = nowMs();
  return s;
}

/**
 * Update session by merging a safe patch.
 */
export function updateSession(convId, patch = {}) {
  cleanupExpired_();
  const id = safeConvId(convId);
  if (!id) return null;

  const current = getSession(id);
  if (!current) return null;

  const safePatch = normalizePatch_(patch);
  const next = deepMerge_(current, safePatch);

  next.last_seen_at = nowMs();
  SESSIONS.set(id, next);
  return next;
}

/**
 * Clear specific keys (soft reset parts of session).
 * keys: array of strings: ["section","audience","size","brand","budget","intent","purchase_gate","flags"]
 */
export function clearSessionKeys(convId, keys = []) {
  cleanupExpired_();
  const id = safeConvId(convId);
  if (!id) return null;

  const s = getSession(id);
  if (!s) return null;

  const set = new Set(Array.isArray(keys) ? keys : []);

  if (set.has("section")) s.section = null;
  if (set.has("audience")) s.audience = null;
  if (set.has("size")) s.size = null;

  if (set.has("brand")) {
    s.brand_std = null;
    s.brand_key = null;
  }

  if (set.has("budget")) s.budget = null;

  if (set.has("intent")) {
    s.intent_mode = "default";
    s.wants_discount = null;
  }

  if (set.has("purchase_gate")) {
    s.purchase_gate = { asked_at: null, confirmed: null, last_choice: null, cross_sell_shown: false };
  }

  if (set.has("flags")) {
    s.flags = {};
  }

  s.last_seen_at = nowMs();
  SESSIONS.set(id, s);
  return s;
}

/**
 * Hard reset session (delete entirely).
 */
export function resetSession(convId) {
  const id = safeConvId(convId);
  if (!id) return false;
  return SESSIONS.delete(id);
}

/**
 * Diagnostics (optional): counts + active ids.
 */
export function sessionStats() {
  cleanupExpired_();
  return {
    ok: true,
    active: SESSIONS.size,
    ids: Array.from(SESSIONS.keys()).slice(0, 50)
  };
}
