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

function isProductsHint(text) {
  const t = normalizeText(text);
  return /(^|\s)(منتج|طلب منتج|بدي منتج|بدّي منتج|حذاء|احذية|أحذية|جزمة|كوتشي|ملابس|قميص|بنطلون|عطر|عطور|برفان)(\s|$)/.test(t);
}

function isInquiriesHint(text) {
  const t = normalizeText(text);
  return /(^|\s)(استعلام|استفسار|التوصيل|الشحن|رسوم الشحن|الفروع|مواقعها|تبديل|إرجاع|ارجاع|كيف اطلب|كيف أطلب|موظف|خدمة العملاء|حالة الطلب|وين طلبي|تتبع|الطرد)(\s|$)/.test(t);
}

function detectMainMenuChoice(text) {
  const t = normalizeText(text);

  if (t === "1") return "products";
  if (t === "2") return "inquiries";

  if (isProductsHint(t)) return "products";
  if (isInquiriesHint(t)) return "inquiries";

  return null;
}

function nextFlow(active, step) {
  return {
    active: active || null,
    step: step || null,
    updated_at: Date.now()
  };
}

export function routeMessage({ session, text, hasMedia = false }) {
  const currentFlow = session?.flow || { active: null, step: null };
  const menuChoice = detectMainMenuChoice(text);

  if (hasMedia) {
    return {
      lane: "escalation",
      reason: "media",
      flow: nextFlow(currentFlow.active, currentFlow.step)
    };
  }

  if (currentFlow.active === "products" && currentFlow.step) {
    return {
      lane: "products",
      reason: "resume_products_flow",
      flow: nextFlow("products", currentFlow.step)
    };
  }

  if (currentFlow.active === "inquiries" && currentFlow.step) {
    return {
      lane: "inquiries",
      reason: "resume_inquiries_flow",
      flow: nextFlow("inquiries", currentFlow.step)
    };
  }

  if (menuChoice === "products") {
    return {
      lane: "products",
      reason: "menu_products",
      flow: nextFlow("products", "section")
    };
  }

  if (menuChoice === "inquiries") {
    return {
      lane: "inquiries",
      reason: "menu_inquiries",
      flow: nextFlow("inquiries", "topic")
    };
  }

  return {
    lane: "menu",
    reason: "show_welcome",
    flow: nextFlow("menu", "welcome")
  };
}
