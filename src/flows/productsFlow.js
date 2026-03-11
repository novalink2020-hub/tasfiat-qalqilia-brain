import { updateSession } from "../state/sessionStore.js";

function toLatinDigits(s) {
  return String(s || "")
    .replace(/[٠-٩]/g, (d) => "0123456789"["٠١٢٣٤٥٦٧٨٩".indexOf(d)])
    .replace(/[۰-۹]/g, (d) => "0123456789"["۰۱۲۳۴۵۶۷۸۹".indexOf(d)]);
}

function normalizeText(s) {
  return toLatinDigits(String(s || ""))
    .replace(/\s+/g, " ")
    .trim();
}

function isNo(text) {
  return /^(لا|لأ|كلا|مش ضروري|مو ضروري|بدون|لا شكرا|لا شكرًا)$/i.test(normalizeText(text));
}

function isYes(text) {
  return /^(نعم|ايوه|أيوه|ايوا|اه|أه|اكيد|أكيد|yes)$/i.test(normalizeText(text));
}

function extractSection(text) {
  const t = normalizeText(text);

  if (t === "1") return "عطور";
  if (t === "2") return "أحذية";
  if (t === "3") return "ملابس";

  if (/عطر|عطور|برفان|كولونيا/.test(t)) return "عطور";
  if (/حذاء|احذية|أحذية|بوت|جزمة|كوتشي|شوز|صندل|شبشب/.test(t)) return "أحذية";
  if (/ملابس|قميص|بنطلون|تيشيرت|هودي|جاكيت|بلوزة|بلوزه|فستان/.test(t)) return "ملابس";

  return null;
}

function extractAudience(text, section = null) {
  const t = normalizeText(text);

  if (section === "عطور") {
    if (t === "1") return "رجالي";
    if (t === "2") return "ستاتي";
  } else {
    if (t === "1") return "رجالي";
    if (t === "2") return "ستاتي";
    if (t === "3") return "ولادي";
    if (t === "4") return "بناتي";
  }

  if (/رجالي|رجال|للرجال|شباب/.test(t)) return "رجالي";
  if (/ستاتي|نسائي|نساء|حريمي|للبنات الكبيرات/.test(t)) return "ستاتي";
  if (/ولادي|اولادي|أولادي|اولاد|أولاد|اطفال|أطفال|صبيان/.test(t)) return "ولادي";
  if (/بناتي|بنات|طفله|طفلة/.test(t)) return "بناتي";

  return null;
}

function extractSize(text, section = null) {
  const t = normalizeText(text);

  if (section === "عطور") return null;

  const alpha = t.match(/\b(XXL|XL|L|M|S)\b/i);
  if (alpha) return String(alpha[1]).toUpperCase();

  const numeric = t.match(/(?:نمرة|نمره|مقاس|قياس|رقم)?\s*[:\-]?\s*(\d{2,3}(?:\.\d)?)/i);
  if (numeric?.[1]) return String(numeric[1]);

  return null;
}

function extractBudget(text) {
  const t = normalizeText(text);
  const m = t.match(/(\d{2,5})\s*(شيكل|₪)?/i);
  return m?.[1] ? Number(m[1]) : null;
}

function looksLikeSingleMenuDigit(text) {
  return /^[0-9]$/.test(normalizeText(text));
}

function hasProductWords(text) {
  const t = normalizeText(text);
  return /حذاء|احذية|أحذية|بوت|جزمة|كوتشي|ملابس|عطر|عطور|برفان|رجالي|ستاتي|ولادي|بناتي|نمرة|مقاس/.test(t);
}

function askSection() {
  return `تمام 😊 خلّينا نبدأ طلب المنتج.

اكتب رقم:
1) 🧴 عطور
2) 👟 أحذية
3) 👕 ملابس

إذا بدك ترجع للقائمة اكتب: 0`;
}

function askAudience(section) {
  if (section === "عطور") {
    return `تمام 😊 اختر الجمهور:

اكتب رقم:
1) رجالي
2) ستاتي

إذا بدك ترجع للقائمة اكتب: 0`;
  }

  return `تمام 😊 اختر الجمهور:

اكتب رقم:
1) رجالي
2) ستاتي
3) ولادي
4) بناتي

إذا بدك ترجع للقائمة اكتب: 0`;
}

function askSize(section) {
  if (section === "ملابس") {
    return `تمام 😊 شو المقاس؟

اكتب المقاس مثل:
S أو M أو L أو رقم

إذا بدك ترجع للقائمة اكتب: 0`;
  }

  return `تمام 😊 شو المقاس؟

اكتب رقم المقاس فقط
مثال: 44

إذا بدك ترجع للقائمة اكتب: 0`;
}

function askBrandOptIn() {
  return `إذا بتحب أحدد لك ماركة معيّنة اكتب: نعم
وإذا ما بهمك اكتب: لا`;
}

function askBrandValue() {
  return `اكتب اسم الماركة المطلوبة.`;
}

function askBudgetOptIn() {
  return `إذا عندك ميزانية محددة اكتب: نعم
وإذا ما بهمك اكتب: لا`;
}

function askBudgetValue() {
  return `اكتب الميزانية بالشيكل
مثال: 150`;
}

function buildSearchQuery(state) {
  const parts = [];

  if (state.section) parts.push(state.section);
  if (state.audience) parts.push(state.audience);
  if (state.size && state.section !== "عطور") parts.push(`مقاس ${state.size}`);
  if (state.brand_std) parts.push(state.brand_std);
  if (state.budget?.value) parts.push(`${state.budget.value} شيكل`);

  return parts.join(" ").trim();
}

function getMinimumReady(state) {
  if (!state.section) return false;
  if (!state.audience) return false;
  if (state.section === "عطور") return true;
  return !!state.size;
}

export function handleProductsFlow({ text, session, routeReason, conversationId }) {
  const current = session || {};
  const currentFlow = current.flow || {};
  const step = currentFlow.step || "section";
  const raw = String(text || "").trim();

  const detectedSection = extractSection(raw) || current.section || null;
  const detectedAudience = extractAudience(raw, detectedSection) || current.audience || null;
  const detectedSize = extractSize(raw, detectedSection) || current.size || null;

  const patch = {
    section: detectedSection,
    audience: detectedAudience,
    size: detectedSection === "عطور" ? null : detectedSize,
    last_user_text: raw
  };

  // التقط brand/budget من النص الحر إذا المستخدم كتبهم في رسالة طبيعية
  if (!looksLikeSingleMenuDigit(raw) && hasProductWords(raw)) {
    const budget = extractBudget(raw);
    if (budget) patch.budget = { value: budget, min: null, max: null };

    const possibleBrand = raw
      .replace(/(?:بدي|بدي|أريد|ابغى|أبغى|لو سمحت|رجالي|ستاتي|ولادي|بناتي|حذاء|احذية|أحذية|بوت|جزمة|كوتشي|عطر|عطور|برفان|ملابس|نمرة|نمره|مقاس|قياس|\d+|شيكل)/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (possibleBrand && possibleBrand.length >= 2 && possibleBrand.length <= 30) {
      patch.brand_std = current.brand_std || possibleBrand;
    }
  }

  // 1) لو النص الحر نفسه مكتمل → ابحث مباشرة
  if (!looksLikeSingleMenuDigit(raw) && getMinimumReady({ ...current, ...patch })) {
    updateSession(conversationId, {
      ...patch,
      flow: { active: "products", step: "results", updated_at: Date.now() }
    });

    return {
      type: "engine",
      query: raw,
      patch: {
        ...patch,
        flow: { active: "products", step: "results", updated_at: Date.now() }
      }
    };
  }

  // 2) الخطوة الحالية = section
  if (step === "section") {
    if (!patch.section) {
      updateSession(conversationId, {
        flow: { active: "products", step: "section", updated_at: Date.now() }
      });

      return {
        type: "reply",
        reply: askSection(),
        patch: {
          flow: { active: "products", step: "section", updated_at: Date.now() }
        }
      };
    }

    updateSession(conversationId, {
      ...patch,
      flow: { active: "products", step: "audience", updated_at: Date.now() }
    });

    return {
      type: "reply",
      reply: askAudience(patch.section),
      patch: {
        ...patch,
        flow: { active: "products", step: "audience", updated_at: Date.now() }
      }
    };
  }

  // 3) الخطوة الحالية = audience
  if (step === "audience") {
    if (!patch.audience) {
      updateSession(conversationId, {
        ...patch,
        flow: { active: "products", step: "audience", updated_at: Date.now() }
      });

      return {
        type: "reply",
        reply: askAudience(patch.section || current.section),
        patch: {
          ...patch,
          flow: { active: "products", step: "audience", updated_at: Date.now() }
        }
      };
    }

    if ((patch.section || current.section) === "عطور") {
      updateSession(conversationId, {
        ...patch,
        flow: { active: "products", step: "brand_optin", updated_at: Date.now() }
      });

      return {
        type: "reply",
        reply: askBrandOptIn(),
        patch: {
          ...patch,
          flow: { active: "products", step: "brand_optin", updated_at: Date.now() }
        }
      };
    }

    updateSession(conversationId, {
      ...patch,
      flow: { active: "products", step: "size", updated_at: Date.now() }
    });

    return {
      type: "reply",
      reply: askSize(patch.section || current.section),
      patch: {
        ...patch,
        flow: { active: "products", step: "size", updated_at: Date.now() }
      }
    };
  }

  // 4) الخطوة الحالية = size
  if (step === "size") {
    if (!patch.size) {
      updateSession(conversationId, {
        ...patch,
        flow: { active: "products", step: "size", updated_at: Date.now() }
      });

      return {
        type: "reply",
        reply: askSize(patch.section || current.section),
        patch: {
          ...patch,
          flow: { active: "products", step: "size", updated_at: Date.now() }
        }
      };
    }

    updateSession(conversationId, {
      ...patch,
      flow: { active: "products", step: "brand_optin", updated_at: Date.now() }
    });

    return {
      type: "reply",
      reply: askBrandOptIn(),
      patch: {
        ...patch,
        flow: { active: "products", step: "brand_optin", updated_at: Date.now() }
      }
    };
  }

  // 5) الخطوة الحالية = brand_optin
  if (step === "brand_optin") {
    if (isYes(raw)) {
      updateSession(conversationId, {
        ...patch,
        flow: { active: "products", step: "brand_value", updated_at: Date.now() }
      });

      return {
        type: "reply",
        reply: askBrandValue(),
        patch: {
          ...patch,
          flow: { active: "products", step: "brand_value", updated_at: Date.now() }
        }
      };
    }

    if (isNo(raw)) {
      updateSession(conversationId, {
        ...patch,
        brand_std: null,
        flow: { active: "products", step: "budget_optin", updated_at: Date.now() }
      });

      return {
        type: "reply",
        reply: askBudgetOptIn(),
        patch: {
          ...patch,
          brand_std: null,
          flow: { active: "products", step: "budget_optin", updated_at: Date.now() }
        }
      };
    }

    // إذا المستخدم كتب اسم ماركة مباشرة بدل نعم
    if (!looksLikeSingleMenuDigit(raw) && raw.length >= 2) {
      updateSession(conversationId, {
        ...patch,
        brand_std: raw,
        flow: { active: "products", step: "budget_optin", updated_at: Date.now() }
      });

      return {
        type: "reply",
        reply: askBudgetOptIn(),
        patch: {
          ...patch,
          brand_std: raw,
          flow: { active: "products", step: "budget_optin", updated_at: Date.now() }
        }
      };
    }

    return {
      type: "reply",
      reply: askBrandOptIn(),
      patch: {
        ...patch,
        flow: { active: "products", step: "brand_optin", updated_at: Date.now() }
      }
    };
  }

  // 6) الخطوة الحالية = brand_value
  if (step === "brand_value") {
    if (!raw || isNo(raw)) {
      updateSession(conversationId, {
        ...patch,
        brand_std: null,
        flow: { active: "products", step: "budget_optin", updated_at: Date.now() }
      });

      return {
        type: "reply",
        reply: askBudgetOptIn(),
        patch: {
          ...patch,
          brand_std: null,
          flow: { active: "products", step: "budget_optin", updated_at: Date.now() }
        }
      };
    }

    updateSession(conversationId, {
      ...patch,
      brand_std: raw,
      flow: { active: "products", step: "budget_optin", updated_at: Date.now() }
    });

    return {
      type: "reply",
      reply: askBudgetOptIn(),
      patch: {
        ...patch,
        brand_std: raw,
        flow: { active: "products", step: "budget_optin", updated_at: Date.now() }
      }
    };
  }

  // 7) الخطوة الحالية = budget_optin
  if (step === "budget_optin") {
    if (isYes(raw)) {
      updateSession(conversationId, {
        ...patch,
        flow: { active: "products", step: "budget_value", updated_at: Date.now() }
      });

      return {
        type: "reply",
        reply: askBudgetValue(),
        patch: {
          ...patch,
          flow: { active: "products", step: "budget_value", updated_at: Date.now() }
        }
      };
    }

    if (isNo(raw)) {
      const nextState = { ...current, ...patch };
      const query = buildSearchQuery(nextState);

      updateSession(conversationId, {
        ...patch,
        flow: { active: "products", step: "results", updated_at: Date.now() }
      });

      return {
        type: "engine",
        query,
        patch: {
          ...patch,
          flow: { active: "products", step: "results", updated_at: Date.now() }
        }
      };
    }

    const inlineBudget = extractBudget(raw);
    if (inlineBudget) {
      const nextState = {
        ...current,
        ...patch,
        budget: { value: inlineBudget, min: null, max: null }
      };
      const query = buildSearchQuery(nextState);

      updateSession(conversationId, {
        ...patch,
        budget: { value: inlineBudget, min: null, max: null },
        flow: { active: "products", step: "results", updated_at: Date.now() }
      });

      return {
        type: "engine",
        query,
        patch: {
          ...patch,
          budget: { value: inlineBudget, min: null, max: null },
          flow: { active: "products", step: "results", updated_at: Date.now() }
        }
      };
    }

    return {
      type: "reply",
      reply: askBudgetOptIn(),
      patch: {
        ...patch,
        flow: { active: "products", step: "budget_optin", updated_at: Date.now() }
      }
    };
  }

  // 8) الخطوة الحالية = budget_value
  if (step === "budget_value") {
    const budget = extractBudget(raw);
    if (!budget) {
      updateSession(conversationId, {
        ...patch,
        flow: { active: "products", step: "budget_value", updated_at: Date.now() }
      });

      return {
        type: "reply",
        reply: askBudgetValue(),
        patch: {
          ...patch,
          flow: { active: "products", step: "budget_value", updated_at: Date.now() }
        }
      };
    }

    const nextState = {
      ...current,
      ...patch,
      budget: { value: budget, min: null, max: null }
    };
    const query = buildSearchQuery(nextState);

    updateSession(conversationId, {
      ...patch,
      budget: { value: budget, min: null, max: null },
      flow: { active: "products", step: "results", updated_at: Date.now() }
    });

    return {
      type: "engine",
      query,
      patch: {
        ...patch,
        budget: { value: budget, min: null, max: null },
        flow: { active: "products", step: "results", updated_at: Date.now() }
      }
    };
  }

  // fallback
  updateSession(conversationId, {
    ...patch,
    flow: { active: "products", step: "section", updated_at: Date.now() }
  });

  return {
    type: "reply",
    reply: askSection(),
    patch: {
      ...patch,
      flow: { active: "products", step: "section", updated_at: Date.now() }
    }
  };
}
