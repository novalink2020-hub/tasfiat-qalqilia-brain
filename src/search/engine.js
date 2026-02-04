// Stage 2: Human-friendly replies + numbered choices + basic intent handling
import { getKnowledge } from "../knowledge/loader.js";
import { PROFILE } from "../client.profile.js";
import { buildReplyFromItem } from "../replies/presenter.js";

function normalizeText(s) {
  return String(s || "").trim();
}

function normLower(v) {
  return String(v || "").toLowerCase();
}

function tokenizeArabicSafe(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-]+/gu, " ")
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2);
}

function extractSizeQuery(queryLower) {
  const m = queryLower.match(/(^|\s)(\d{2}(?:\.\d)?)(\s|$)/);
  return m ? String(m[2]) : null;
}

function searchKnowledge(q) {
  const KNOWLEDGE = getKnowledge();
  if (!KNOWLEDGE?.items?.length) return { type: "none", askedSize: null };

  const raw = normalizeText(q);
  const queryLower = raw.toLowerCase();
  const tokens = tokenizeArabicSafe(raw);
  const askedSize = extractSizeQuery(queryLower);

  const m = queryLower.match(/\/product\/([a-z0-9\-]+)/i);
  const slugFromUrl = m?.[1] || null;

  if (slugFromUrl) {
    const hit = KNOWLEDGE.items.find(x => normLower(x.product_slug) === slugFromUrl);
    if (hit) return { type: "hit", item: hit, askedSize };
  }

  const directSlug = KNOWLEDGE.items.find(x => {
    const slug = normLower(x.product_slug);
    return slug && slug === queryLower;
  });
  if (directSlug) return { type: "hit", item: directSlug, askedSize };

  const scored = [];
  for (const x of KNOWLEDGE.items) {
    const slug = normLower(x.product_slug);
    const name = normLower(x.name);
    const keywords = normLower(x.keywords);
    const tags = normLower(x.brand_tags);
    const sizes = normLower(x.sizes);

    const isPolicyLike =
      slug.startsWith("policy-") ||
      slug.startsWith("info-") ||
      slug.startsWith("branch-") ||
      tags.includes("سياسات") ||
      tags.includes("فروع");

    if (askedSize && !isPolicyLike) {
      const list = sizes.split(",").map(s => s.trim());
      const ok = list.includes(String(askedSize));
      if (!ok) continue;
    }

    let score = 0;
    if (name === queryLower) score += 80;
    if (name.includes(queryLower) || queryLower.includes(name)) score += 35;
    if (slug && queryLower.includes(slug)) score += 60;

    const hay = `${name} ${keywords} ${tags} ${sizes} ${slug}`;
    for (const t of tokens) {
      if (!t) continue;
      if (name.includes(t)) score += 10;
      if (keywords.includes(t)) score += 8;
      if (tags.includes(t)) score += 7;
      if (sizes.includes(t)) score += 12;
      if (slug.includes(t)) score += 9;
      if (hay.includes(t)) score += 2;
    }

    const policyHints = ["توصيل", "شحن", "تبديل", "استبدال", "إرجاع", "خصوصية", "سياسة", "شروط", "فروع", "موقع"];
    if (isPolicyLike && policyHints.some(h => queryLower.includes(h))) score += 25;

    if (score > 0) scored.push({ item: x, score });
  }

  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return { type: "none", askedSize };

  const top = scored[0];
  const second = scored[1];
  if (top.score < 25) return { type: "none", askedSize };

  if (second && second.score >= top.score - 5) {
    const options = scored.slice(0, 4).map(s => ({
      slug: s.item.product_slug || "",
      name: s.item.name || ""
    }));
    return { type: "clarify", options, askedSize };
  }

  return { type: "hit", item: top.item, askedSize };
}

function isOnlySizeQuery(raw) {
  const s = normalizeText(raw);
  return /^\d{2}(\.\d)?$/.test(s);
}
function pickOpening() {
  const arr = ["تمام 😊", "أكيد 🌟", "ولا يهمك 😊", "حاضر 👌", "يسعدني 😊"];
  return arr[Math.floor(Math.random() * arr.length)];
}

export function handleQuery(q, ctx = {}) {
  const raw = normalizeText(q);
  const ql = raw.toLowerCase();

  const conversationId = ctx?.conversationId || null;
  const choiceMemory = ctx?.choiceMemory;

  // 0) إذا العميل رد برقم (اختيار من آخر قائمة)
  const choiceNum = raw.match(/^\s*([1-4])\s*$/)?.[1] || null;
  if (choiceNum && conversationId && choiceMemory?.has(conversationId)) {
    const mem = choiceMemory.get(conversationId);
    const picked = mem?.options?.[Number(choiceNum) - 1];
    if (picked?.slug) {
      const pickedResult = searchKnowledge(picked.slug);
      if (pickedResult.type === "hit" && pickedResult.item) {
        return {
          ok: true,
          found: true,
          reply: buildReplyFromItem(pickedResult.item),
          tags: ["lead_product", "selection_made"]
        };
      }
    }
    return {
      ok: true,
      found: false,
      reply: "تمام 😊 بس ما قدرت أحدد اختيارك. اختار رقم من القائمة اللي قبل لو سمحت.",
      tags: ["توضيح"]
    };
  }

  // 1) Intent بسيط جدًا (بدون AI)
  const isShipping = /توصيل|شحن/.test(ql);
  const isReturn = /إرجاع|ارجاع|ترجيع|استرجاع/.test(ql);
  const isExchange = /تبديل|استبدال/.test(ql);
  const isBranches = /فرع|فروع|موقع|وين/.test(ql);

  // 2) ردود سياسات مباشرة (بدون ما نظهرها كمنتج)
  if (isReturn) {
    return {
      ok: true,
      found: true,
      reply: PROFILE.replies_shami.policy_return_exchange,
      tags: ["سياسة", "تبديل"]
    };
  }

  // 3) توصيل + مدينة: جواب مباشر (جلجولية => 75)
  if (isShipping) {
    const city = extractCityFromText(ql);
    if (!city) {
      return {
        ok: true,
        found: false,
        reply: PROFILE.replies_shami.policy_shipping_intro,
        tags: ["توضيح", "توصيل"]
      };
    }

    const fee = classifyShippingFee(city);
    const daysMin = PROFILE.shipping.days_min;
    const daysMax = PROFILE.shipping.days_max;

const zone =
  fee === PROFILE.shipping.fees_ils.inside_1948 ? "inside_1948" :
  fee === PROFILE.shipping.fees_ils.jerusalem ? "jerusalem" :
  "west_bank";

return {
  ok: true,
  found: true,
  reply: `${pickOpening()} توصيل **${city}** رسومه **${fee} شيكل**. ومدة التوصيل عادة بين **${daysMin} إلى ${daysMax} أيام عمل**.`,
  tags: ["lead_shipping", zone]
};
  }

  // 4) سؤال عام جدًا عن منتجات: لا نعطي سياسة بالغلط
  // مثال: "بدّي حذاء" => نسأل توضيح بدل ما نخطفها بسياسة
  const genericProductAsk = /بدّي|بدي|عايز|حذاء|كوتشي|جزمة|بوط|صندل|كروكس|شوز/.test(ql);
  if (genericProductAsk && raw.length <= 30) {
    // لو ما ذكر مقاس/ماركة/سعر → سؤال توضيح
    const hasSize = !!extractSizeQuery(ql);
    const hasMoney = /\d+\s*(شيكل|₪)/.test(ql);
    const hasBrandHint = /joma|skechers|nike|adidas|puma|crocs|mizuno|brooks|asics/i.test(raw);

    if (!hasSize && !hasMoney && !hasBrandHint) {
      return {
        ok: true,
        found: false,
        reply: PROFILE.replies_shami.ask_more_for_products,
        tags: ["توضيح", "منتجات"]
      };
    }
  }

  // 5) المقاس فقط → سؤال توضيح (بدون عرض 4 منتجات مباشرة)
  const askedSize = extractSizeQuery(ql);
  if (askedSize && isOnlySizeQuery(raw)) {
    return {
      ok: true,
      found: false,
      reply: `تمام 😊 المقاس **${askedSize}** بدك **رجالي ولا نسائي**؟ وكمان بتحب السعر يكون ضمن أي مدى تقريبًا؟`,
      tags: ["توضيح"]
    };
  }

  // 6) البحث العام (منتجات + سياسات) مع عرض بشري
  const result = searchKnowledge(raw);

  if (result.type === "hit" && result.item) {
    // حماية: إذا السؤال عام عن منتجات وطلع سياسة بالغلط، نسأل توضيح بدل ذلك
    const slug = String(result.item.product_slug || "").toLowerCase();
    const isPolicyLike = slug.startsWith("policy-") || slug.startsWith("info-") || slug.startsWith("branch-");
    if (isPolicyLike && genericProductAsk) {
      return {
        ok: true,
        found: false,
        reply: PROFILE.replies_shami.ask_more_for_products,
        tags: ["توضيح", "منتجات"]
      };
    }

    return {
      ok: true,
      found: true,
      reply: buildReplyFromItem(result.item),
      tags: ["نتيجة"]
    };
  }

if (result.type === "clarify") {
  const opts = (result.options || []).slice(0, 3);

  // نخزن الخيارات عشان المستخدم يرد 1/2/3
  if (conversationId && choiceMemory) {
    choiceMemory.set(conversationId, {
      ts: Date.now(),
      options: opts
    });
  }

  const lines = [];
  lines.push(pickOpening() + " حتى أعطيك جواب دقيق، اختر رقم:");
  opts.forEach((o, i) => {
    const item = searchKnowledge(o.slug);
    const it = item?.item;
    const price = it?.price ? `${it.price} شيكل` : "";
    const avail = it?.availability ? `— ${it.availability}` : "";
    lines.push(`${i + 1}) ${o.name}${price ? " — " + price : ""} ${avail}`.trim());
  });
  lines.push("اكتب رقم الخيار فقط (مثال: 1).");

  return {
    ok: true,
    found: false,
    reply: lines.join("\n"),
    tags: ["needs_clarification", "lead_product"]
  };
}

  // 7) fallback لطيف
  if (isBranches) {
    return {
      ok: true,
      found: false,
      reply: "أكيد 😊 بتقصد **موقع الفروع** ولا **موقع المقر**؟ احكيلي شو بدك بالزبط.",
      tags: ["توضيح", "فروع"]
    };
  }

  if (isExchange) {
    return {
      ok: true,
      found: true,
      reply: PROFILE.replies_shami.policy_return_exchange,
      tags: ["سياسة", "تبديل"]
    };
  }

  return {
    ok: true,
    found: false,
    reply: "أكيد 😊 بس وضّحلي شوي: سؤالك عن **التوصيل** ولا **التبديل** ولا بدك **اقتراح منتجات**؟",
    tags: ["توضيح"]
  };
}

// ===== Helpers for stage 2 =====
function extractCityFromText(textLower) {
  const clean = String(textLower || "")
    .replace(/<[^>]+>/g, " ")          // remove HTML tags
    .replace(/[^\p{L}\p{N}\s\-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const m = clean.match(/(?:على|الى|إلى)\s+(.+)$/);
  if (m?.[1]) return m[1].trim();

  if (clean.length <= 18) return clean;
  return null;
}

function classifyShippingFee(cityLowerRaw) {
  const city = String(cityLowerRaw || "").toLowerCase();

  // القدس
  if (PROFILE.shipping.jerusalem_keywords.some(k => city.includes(String(k).toLowerCase()))) {
    return PROFILE.shipping.fees_ils.jerusalem;
  }

  // الداخل 48
  if (PROFILE.shipping.inside_1948_examples.some(c => city.includes(String(c).toLowerCase()))) {
    return PROFILE.shipping.fees_ils.inside_1948;
  }

  // الافتراضي: الضفة
  return PROFILE.shipping.fees_ils.west_bank;
}

