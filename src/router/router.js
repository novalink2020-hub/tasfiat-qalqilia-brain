function toLatinDigits(s) {
  return String(s || "")
    .replace(/[٠-٩]/g, (d) => "0123456789"["٠١٢٣٤٥٦٧٨٩".indexOf(d)])
    .replace(/[۰-۹]/g, (d) => "0123456789"["۰۱۲۳۴۵۶۷۸۹".indexOf(d)]);
}

function normalizeText(s) {
  return toLatinDigits(String(s || ""))
    .trim()
    .replace(/\s+/g, " ");
}

function isGreeting(text) {
  const t = normalizeText(text);
  return /^(مرحبا|مرحبًا|اهلا|أهلا|السلام عليكم|هاي|هلا|الو)$/.test(t);
}

function isProductsHint(text) {
  const t = normalizeText(text);
  return /(^|\s)(منتج|طلب منتج|بدي منتج|بدّي منتج|حذاء|احذية|أحذية|جزمة|بوت|كوتشي|ملابس|قميص|بنطلون|تيشيرت|عطر|عطور|برفان)(\s|$)/.test(t);
}

function isInquiriesHint(text) {
  const t = normalizeText(text);
  return /(^|\s)(استعلام|استفسار|التوصيل|الشحن|رسوم الشحن|الفروع|وين فروعكم|فرعكم|مواقعها|تبديل|إرجاع|ارجاع|استبدال|كيف اطلب|كيف أطلب|موظف|خدمة العملاء|حالة الطلب|وين طلبي|تتبع|الطرد|سياسة الخصوصية|سياسة|دعم|بدي دعم|مساعدة|بدي مساعدة|عندي مشكلة|في عندي مشكلة|مشكلة|مشكل|احكي معكم|بدي احكي مع موظف)(\s|$)/.test(t);
}

function nextFlow(active, step) {
  return {
    active: active || null,
    step: step || null,
    updated_at: Date.now()
  };
}

function nextProductStep(currentFlow) {
  if (currentFlow?.active === "products" && currentFlow?.step && currentFlow.step !== "welcome") {
    return currentFlow.step;
  }
  return "section";
}

function nextInquiryStep(currentFlow) {
  if (currentFlow?.active === "inquiries" && currentFlow?.step && currentFlow.step !== "welcome") {
    return currentFlow.step;
  }
  return "topic";
}

export function routeMessage({ session, text, hasMedia = false }) {
  const currentFlow = session?.flow || { active: null, step: null };
  const t = normalizeText(text);

  if (hasMedia) {
    return {
      lane: "escalation",
      reason: "media",
      flow: nextFlow(currentFlow.active, currentFlow.step)
    };
  }

  if (t === "0") {
    return {
      lane: "menu",
      reason: "back_to_menu",
      flow: nextFlow("menu", "welcome")
    };
  }

  if (isGreeting(t)) {
    return {
      lane: "menu",
      reason: "greeting_to_menu",
      flow: nextFlow("menu", "welcome")
    };
  }

  // الأرقام 1/2 كقائمة رئيسية فقط إذا كنا فعلاً في القائمة الرئيسية
  if (
    currentFlow.active === null ||
    (currentFlow.active === "menu" && currentFlow.step === "welcome")
  ) {
    if (t === "1") {
      return {
        lane: "products_entry",
        reason: "menu_products",
        flow: nextFlow("products", "section")
      };
    }

    if (t === "2") {
      return {
        lane: "inquiries_entry",
        reason: "menu_inquiries",
        flow: nextFlow("inquiries", "topic")
      };
    }
  }

  if (isProductsHint(t)) {
    return {
      lane: "engine_products_text",
      reason: "free_text_product",
      flow: nextFlow("products", nextProductStep(currentFlow))
    };
  }

  if (isInquiriesHint(t)) {
    const supportLike = /(^|\s)(دعم|بدي دعم|مساعدة|بدي مساعدة|عندي مشكلة|في عندي مشكلة|مشكلة|مشكل|احكي معكم|موظف|بدي احكي مع موظف|خدمة العملاء)(\s|$)/.test(t);

    if (supportLike) {
      return {
        lane: "escalation_support",
        reason: "support_handoff",
        flow: nextFlow(currentFlow.active, currentFlow.step)
      };
    }

    return {
      lane: "engine_inquiries_text",
      reason: "free_text_inquiry",
      flow: nextFlow("inquiries", nextInquiryStep(currentFlow))
    };
  }

  if (currentFlow.active === "products" && currentFlow.step) {
    return {
      lane: "engine_products_text",
      reason: "resume_products_flow",
      flow: nextFlow("products", nextProductStep(currentFlow))
    };
  }

  if (currentFlow.active === "inquiries" && currentFlow.step) {
    return {
      lane: "engine_inquiries_text",
      reason: "resume_inquiries_flow",
      flow: nextFlow("inquiries", nextInquiryStep(currentFlow))
    };
  }

  return {
    lane: "menu",
    reason: "show_welcome",
    flow: nextFlow("menu", "welcome")
  };
}
