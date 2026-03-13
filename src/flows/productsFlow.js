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

function isDontCareSize(text) {
  return /^(لا يهم|مش مهم|مو مهم|اي مقاس|أي مقاس|اي شي|أي شي)$/i.test(normalizeText(text));
}

function extractSection(text, step = null) {
  const t = normalizeText(text);

  if (step === "section") {
    if (t === "1") return "عطور";
    if (t === "2") return "أحذية";
    if (t === "3") return "ملابس";
  }

  if (/عطر|عطور|برفان|كولونيا/.test(t)) return "عطور";
  if (/حذاء|احذية|أحذية|بوت|جزمة|كوتشي|شوز|صندل|شبشب/.test(t)) return "أحذية";
  if (/ملابس|قميص|بنطلون|تيشيرت|هودي|جاكيت|بلوزة|بلوزه|فستان/.test(t)) return "ملابس";

  return null;
}

function extractAudience(text, section = null, step = null) {
  const t = normalizeText(text);

  if (step === "audience") {
    if (section === "عطور") {
      if (t === "1") return "رجالي";
      if (t === "2") return "ستاتي";
    } else {
      if (t === "1") return "رجالي";
      if (t === "2") return "ستاتي";
      if (t === "3") return "ولادي";
      if (t === "4") return "بناتي";
    }
  }

  if (/رجالي|رجال|للرجال|شباب/.test(t)) return "رجالي";
  if (/ستاتي|نسائي|نساء|حريمي|للبنات الكبيرات/.test(t)) return "ستاتي";
  if (/ولادي|اولادي|أولادي|اولاد|أولاد|اطفال|أطفال|صبيان/.test(t)) return "ولادي";
  if (/بناتي|بنات|طفله|طفلة/.test(t)) return "بناتي";

  return null;
}

function extractSize(text, section = null, step = null) {
  const t = normalizeText(text);

  if (section === "عطور") return null;

  const explicitSizeWords = /(?:نمرة|نمره|مقاس|قياس|رقم)/i.test(t);
  const pureNumeric = /^\d{2,3}(?:\.\d)?$/.test(t);
  const pureAlpha = /^(XXL|XL|L|M|S)$/i.test(t);

  if (step !== "size" && !explicitSizeWords) {
    return null;
  }

  if (section === "أحذية") {
    const numeric = t.match(/(?:نمرة|نمره|مقاس|قياس|رقم)?\s*[:\-]?\s*(\d{2,3}(?:\.\d)?)/i);
    if (numeric?.[1]) return String(numeric[1]);
    return pureNumeric ? t : null;
  }

  if (section === "ملابس") {
    const alpha = t.match(/\b(XXL|XL|L|M|S)\b/i);
    if (alpha) return String(alpha[1]).toUpperCase();
    if (pureAlpha) return t.toUpperCase();

    const numeric = t.match(/(?:نمرة|نمره|مقاس|قياس|رقم)?\s*[:\-]?\s*(\d{2,3}(?:\.\d)?)/i);
    if (numeric?.[1]) return String(numeric[1]);
    return pureNumeric ? t : null;
  }

  return null;
}

function looksLikeSingleMenuDigit(text) {
  return /^[0-9]$/.test(normalizeText(text));
}

function hasProductWords(text) {
  const t = normalizeText(text);
  return /حذاء|احذية|أحذية|بوت|جزمة|كوتشي|ملابس|عطر|عطور|برفان|رجالي|ستاتي|ولادي|بناتي|نمرة|نمره|مقاس|قياس/.test(t);
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
  return `إذا بتحب ماركة معيّنة اكتب اسمها مباشرة
وإذا ما بهمك اكتب: لا`;
}

function askBudgetOptIn() {
  return `اختر الميزانية:

اكتب رقم:
1) أقل من 100 شيكل
2) أقل من 200 شيكل
3) كل الخيارات`;
}

function buildSearchQuery(state) {
  const parts = [];

  if (state.section) parts.push(state.section);
  if (state.audience) parts.push(state.audience);
  if (state.size && state.section !== "عطور") parts.push(`مقاس ${state.size}`);
  if (state.brand_std) parts.push(state.brand_std);

  if (state.budget?.max === 100) parts.push("أقل من 100 شيكل");
  if (state.budget?.max === 200) parts.push("أقل من 200 شيكل");
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

  const detectedSection = extractSection(raw, step) || current.section || null;
  const detectedAudience = extractAudience(raw, detectedSection, step) || current.audience || null;
  const detectedSize = extractSize(raw, detectedSection, step) || current.size || null;

  const patch = {
    section: detectedSection,
    audience: detectedAudience,
    size: detectedSection === "عطور" ? null : detectedSize,
    last_user_text: raw
  };

  // التقاط الماركة/الميزانية من النص الحر الكامل فقط
  if (!looksLikeSingleMenuDigit(raw) && hasProductWords(raw)) {
    const possibleBrand = raw
      .replace(/(?:بدي|بدي|أريد|ابغى|أبغى|لو سمحت|رجالي|ستاتي|ولادي|بناتي|حذاء|احذية|أحذية|بوت|جزمة|كوتشي|عطر|عطور|برفان|ملابس|نمرة|نمره|مقاس|قياس|\d+|شيكل|اقل من|أقل من)/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (possibleBrand && possibleBrand.length >= 2 && possibleBrand.length <= 30) {
      patch.brand_std = current.brand_std || possibleBrand;
    }
  }

  // نص حر مكتمل: فقط إذا كانت الرسالة نفسها تبدو طلب منتج فعلي، لا جواب خطوة قصيرة
  const isShortStepAnswer =
    isNo(raw) ||
    /^[0-9]$/.test(normalizeText(raw)) ||
    /^(XXL|XL|L|M|S)$/i.test(normalizeText(raw)) ||
    /^\d{2,3}(?:\.\d)?$/.test(normalizeText(raw));

  const canDirectSearchFromRaw =
    !looksLikeSingleMenuDigit(raw) &&
    !isShortStepAnswer &&
    hasProductWords(raw) &&
    getMinimumReady({ ...current, ...patch });

  if (canDirectSearchFromRaw) {
    updateSession(conversationId, {
      ...patch,
      flow: { active: "products", step: "results", updated_at: Date.now() }
    });

    return {
      type: "engine",
      query: buildSearchQuery({ ...current, ...patch }),
      patch: {
        ...patch,
        flow: { active: "products", step: "results", updated_at: Date.now() }
      }
    };
  }

  // section
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

    // إذا الرسالة نفسها حسمت الجمهور أيضًا، اقفز للخطوة الناقصة مباشرة
    if (patch.audience) {
      if (patch.section === "عطور") {
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

      if (patch.size) {
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
        reply: askSize(patch.section),
        patch: {
          ...patch,
          flow: { active: "products", step: "size", updated_at: Date.now() }
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

  // audience
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

    if (patch.size) {
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

  // size
  if (step === "size") {
    if (isDontCareSize(raw)) {
      updateSession(conversationId, {
        ...patch,
        flow: { active: "products", step: "size", updated_at: Date.now() }
      });

      return {
        type: "reply",
        reply: `لازم تحدد المقاس حتى أعرض لك نتائج دقيقة.

${askSize(patch.section || current.section)}`,
        patch: {
          ...patch,
          flow: { active: "products", step: "size", updated_at: Date.now() }
        }
      };
    }

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

  // brand_optin
  if (step === "brand_optin") {
    const normalized = normalizeText(raw);

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

    if (!looksLikeSingleMenuDigit(raw) && normalized.length >= 2) {
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

  // budget_optin
  if (step === "budget_optin") {
    let budgetPatch = undefined;
    const normalized = normalizeText(raw);

    if (normalized === "1") {
      budgetPatch = { value: null, min: null, max: 100 };
    } else if (normalized === "2") {
      budgetPatch = { value: null, min: null, max: 200 };
    } else if (normalized === "3" || isNo(raw)) {
      budgetPatch = null;
    }

    if (budgetPatch !== undefined) {
      const nextState = {
        ...current,
        ...patch,
        budget: budgetPatch
      };

      const query = buildSearchQuery(nextState).trim();

      updateSession(conversationId, {
        ...patch,
        budget: budgetPatch,
        flow: { active: "products", step: "results", updated_at: Date.now() }
      });

      return {
        type: "engine",
        query: query || buildSearchQuery({
          section: nextState.section,
          audience: nextState.audience,
          size: nextState.size,
          brand_std: nextState.brand_std,
          budget: nextState.budget
        }),
        patch: {
          ...patch,
          budget: budgetPatch,
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
