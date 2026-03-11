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
  return /(^|\s)(استعلام|استفسار|التوصيل|الشحن|رسوم الشحن|الفروع|وين فروعكم|فرعكم|مواقعها|تبديل|إرجاع|ارجاع|استبدال|كيف اطلب|كيف أطلب|موظف|خدمة العملاء|حالة الطلب|وين طلبي|تتبع|الطرد|سياسة الخصوصية|سياسة)(\s|$)/.test(t);
}

function detectMainMenuChoice(text) {
  const t = normalizeText(text);

  if (t === "0") return "menu";
  if (t === "1") return "products";
  if (t === "2") return "inquiries";

  if (isGreeting(t)) return "menu";
  if (isProductsHint(t)) return "products_text";
  if (isInquiriesHint(t)) return "inquiries_text";

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

  if (menuChoice === "menu") {
    return {
      lane: "menu",
      reason: "back_or_greeting",
      flow: nextFlow("menu", "welcome")
    };
  }

  // زر/رقم 1 => دخول موجّه لمسار المنتجات
  if (menuChoice === "products") {
    return {
      lane: "products_entry",
      reason: "menu_products",
      flow: nextFlow("products", "section")
    };
  }

  // زر/رقم 2 => دخول موجّه لمسار الاستعلامات
  if (menuChoice === "inquiries") {
    return {
      lane: "inquiries_entry",
      reason: "menu_inquiries",
      flow: nextFlow("inquiries", "topic")
    };
  }

  // نص حر واضح لمنتج => لا ترجعه للمنيو، مرّره للمحرك مع تثبيت flow
  if (menuChoice === "products_text") {
    return {
      lane: "engine_products_text",
      reason: "free_text_product",
      flow: nextFlow("products", currentFlow.step || "section")
    };
  }

  // نص حر واضح لاستعلام => لا ترجعه للمنيو، مرّره للمحرك مع تثبيت flow
  if (menuChoice === "inquiries_text") {
    return {
      lane: "engine_inquiries_text",
      reason: "free_text_inquiry",
      flow: nextFlow("inquiries", currentFlow.step || "topic")
    };
  }

  // إذا كان داخل flow فعّال، أكمل من نفس المسار
  if (currentFlow.active === "products" && currentFlow.step) {
    return {
      lane: "engine_products_text",
      reason: "resume_products_flow",
      flow: nextFlow("products", currentFlow.step)
    };
  }

  if (currentFlow.active === "inquiries" && currentFlow.step) {
    return {
      lane: "engine_inquiries_text",
      reason: "resume_inquiries_flow",
      flow: nextFlow("inquiries", currentFlow.step)
    };
  }

  // غير واضح => القائمة
  return {
    lane: "menu",
    reason: "show_welcome",
    flow: nextFlow("menu", "welcome")
  };
}
