function boolFromAny(v) {
  if (v === true) return true;
  if (v === false) return false;
  if (typeof v === "string") {
    const x = v.trim().toLowerCase();
    return x === "true" || x === "1" || x === "yes";
  }
  if (typeof v === "number") return v === 1;
  return false;
}

export function detectUiSelectCapability(body = {}) {
  const candidates = [
    body?.channel?.capabilities?.ui_select,
    body?.conversation?.channel?.capabilities?.ui_select,
    body?.conversation?.meta?.channel?.capabilities?.ui_select,
    body?.conversation?.meta?.sender?.channel?.capabilities?.ui_select,
    body?.content_attributes?.channel?.capabilities?.ui_select,
    body?.additional_attributes?.channel?.capabilities?.ui_select,
    body?.metadata?.channel?.capabilities?.ui_select
  ];

  for (const v of candidates) {
    if (v !== undefined && v !== null) return boolFromAny(v);
  }

  return false;
}

const TEMPLATES = {
  WELCOME_UI_SELECTBOX:
`أهلًا وسهلًا 😊🌟
سعداء لاختياركم تصفيات قلقيلية—خلّيني أساعدك تلاقي أفضل خيار بسرعة.
اختر من القائمة:

1) 🛍️ طلب منتج
2) ℹ️ استعلامات`,

  WELCOME_FALLBACK_NUMBERS:
`أهلًا وسهلًا 😊🌟
سعداء لاختياركم تصفيات قلقيلية—خلّيني أساعدك تلاقي أفضل خيار بسرعة.

اكتب رقم:
1) 🛍️ طلب منتج
2) ℹ️ استعلامات

اكتب رقم فقط (مثال: 1).`,

  BACK_TO_MENU: `إذا بدك ترجع للقائمة اكتب: 0`,

  LIKE_CONFIRM_UI:
`تمام 😊 هل أعجبك الخيار اللي اخترته؟

1) ✅ نعم
2) ❌ لا`,

  LIKE_CONFIRM_NUMBERS:
`تمام 😊 هل أعجبك الخيار اللي اخترته؟

1) ✅ نعم
2) ❌ لا
اكتب رقم فقط.`,

  CROSS_SELL_UI:
`حلو! 😊
بتحب أساعدك تضيف شغلة مناسبة مع طلبك؟
وبدون تكلفة توصيل إضافية 🌟

اختر قسم إضافي 👨‍👩‍👧‍👦 :

1) 🧴 عطور
2) 👟 أحذية
3) 👕 ملابس
0) لا، شكراً`,

  CROSS_SELL_NUMBERS:
`حلو! 😊
بتحب أساعدك تضيف شغلة مناسبة مع طلبك؟
وبدون تكلفة توصيل إضافية 🌟

اختر رقم:

1) 🧴 عطور
2) 👟 أحذية
3) 👕 ملابس
0) لا، شكراً

اكتب رقم فقط.`,

  ESCALATE_MEDIA:
`وصلتني 🙏 رح أحوّلك لموظف خدمة العملاء عشان يفحصها بدقة.
شكرًا لانتظارك 😊 اكتب اسمك ورقمك (إن أمكن) وبنرجعلك بأقرب وقت.`,

  ESCALATE_ORDER_STATUS:
`أكيد 🙏 عشان أتابع حالة الطلب بدقة رح أحوّلك لموظف.
اكتب رقم الطلب (أو رقم الهاتف/الاسم اللي تم الطلب عليه)، وبنتابع فورًا.`
};

export function renderTemplate(name, channel = {}) {
  const uiSelect = !!channel?.capabilities?.ui_select;

  if (name === "WELCOME") {
    return uiSelect ? TEMPLATES.WELCOME_UI_SELECTBOX : TEMPLATES.WELCOME_FALLBACK_NUMBERS;
  }

  if (name === "LIKE_CONFIRM") {
    return uiSelect ? TEMPLATES.LIKE_CONFIRM_UI : TEMPLATES.LIKE_CONFIRM_NUMBERS;
  }

  if (name === "CROSS_SELL") {
    return uiSelect ? TEMPLATES.CROSS_SELL_UI : TEMPLATES.CROSS_SELL_NUMBERS;
  }

  return TEMPLATES[name] || "";
}

export function buildChannelContextFromWebhook(body = {}) {
  return {
    capabilities: {
      ui_select: detectUiSelectCapability(body)
    }
  };
}
