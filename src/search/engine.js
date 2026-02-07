// Stage 2: Human-friendly replies + numbered choices + basic intent handling (Chatwoot-safe)
import { getKnowledge } from "../knowledge/loader.js";
import { classifyCityZone } from "../geo/classifier.js";
import { PROFILE } from "../client.profile.js";
import { buildReplyFromItem } from "../replies/presenter.js";

function stripHtml(s) {
  return String(s || "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(s) {
  return stripHtml(s);
}

function normLower(v) {
  return String(v || "").toLowerCase();
}
function normalizeArabic(s) {
  const x = String(s || "");
  return x
    // remove tashkeel
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    // unify alef forms
    .replace(/[إأآٱ]/g, "ا")
    // unify yaa / alef maqsura
    .replace(/ى/g, "ي")
    // unify ta marbuta (اختياري لكنه عملي للبحث)
    .replace(/ة/g, "ه")
    // remove tatweel
    .replace(/ـ/g, "")
    // reduce repeated letters (جومااا → جوما)
    .replace(/(.)\1{2,}/g, "$1$1")
    .trim();
}
function tokenizeArabicSafe(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-]+/gu, " ")
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2);
}
function extractMoneyQuery(queryLower) {
  // مثال: "200 شيكل" أو "200₪"
  const m = String(queryLower || "").match(/(\d{2,5})\s*(شيكل|₪)/);
  return m ? Number(m[1]) : null;
}

function extractGenderHint(queryLower) {
  const q = String(queryLower || "");
  if (/رجالي|للرجال|شباب/.test(q)) return "male";
  if (/نسائي|للنساء|بنات|ستاتي|حريمي/.test(q)) return "female";
  if (/ولادي|أولادي|اطفال|أطفال|صبيان/.test(q)) return "kids_male";
  if (/بناتي|أطفال بنات|بنوتي/.test(q)) return "kids_female";
  return null;
}

function extractDiscountHint(queryLower) {
  const q = String(queryLower || "");
  return /خصم|تنزيلات|عروض|sale|off|تخفيض/.test(q);
}

function extractSizeQuery(queryLower) {
  const m = queryLower.match(/(^|\s)(\d{2}(?:\.\d)?)(\s|$)/);
  return m ? String(m[2]) : null;
}

function isOnlySizeQuery(raw) {
  const s = normalizeText(raw);
  return /^\d{2}(\.\d)?$/.test(s);
}

function pickOpening() {
  const arr = ["تمام 😊", "ولا يهمك 😊", "حاضر 👌", "يسعدني 😊", "على راسي 😊"];
  return arr[Math.floor(Math.random() * arr.length)];
}

// ====== Shipping helpers ======
const JERUSALEM_AREAS_30 = [
  "باب العامود",
  "باب العمود",
  "واد الجوز",
  "الشيخ جراح",
  "بيت حنينا",
  "شعفاط",
  "سلوان",
  "العيسوية",
  "الطور",
  "البلدة القديمة",
  "المسجد الأقصى",
  "القدس القديمة",
  "القدس"
];

const JERUSALEM_SUBURBS_20 = [
  "ضواحي القدس",
  "العيزرية",
  "أبو ديس",
  "الرام",
  "عناتا",
  "الزعيم",
  "بير نبالا",
  "بدو",
  "بيت إكسا",
  "جبع"
];

function extractCityFromText(textLower) {
  const clean = String(textLower || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[^\p{L}\p{N}\s\-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  // نلتقط مدينة من "على/الى/إلى"
  const m = clean.match(/(?:على|الى|إلى)\s+(.+)$/);
  if (m?.[1]) return m[1].trim();

  // أو إذا النص نفسه قصير
  if (clean.length <= 22) return clean;

  return null;
}

function classifyShipping(cityRaw) {
  const city = String(cityRaw || "").trim();
  if (!city) return { fee: null, zone: "unknown" };

  // إشارات خارج النطاق (اختياري إبقاؤه)
  const cityLower = city.toLowerCase();
  const foreignHints = ["تركيا", "turkey", "istanbul", "ankara", "london", "uk", "usa", "أمريكا", "المانيا", "germany"];
  if (foreignHints.some(h => cityLower.includes(String(h).toLowerCase()))) {
    return { fee: null, zone: "outside" };
  }

  const zone = classifyCityZone(city); // west_bank | jerusalem_suburbs | jerusalem | inside_1948 | null

  if (!zone) return { fee: null, zone: "unknown" };

  if (zone === "inside_1948") {
    return { fee: PROFILE.shipping.fees_ils.inside_1948, zone };
  }

  if (zone === "jerusalem") {
    return { fee: PROFILE.shipping.fees_ils.jerusalem, zone };
  }

  // west_bank + jerusalem_suburbs = 20
  if (zone === "west_bank" || zone === "jerusalem_suburbs") {
    return { fee: PROFILE.shipping.fees_ils.west_bank, zone };
  }

  return { fee: null, zone: "unknown" };
}

// ====== Knowledge search ======
function searchKnowledge(q) {
  const KNOWLEDGE = getKnowledge();
  if (!KNOWLEDGE?.items?.length) return { type: "none", askedSize: null };

  const raw = normalizeText(q);
const rawNorm = normalizeArabic(raw);
const queryLower = rawNorm.toLowerCase();
const tokens = tokenizeArabicSafe(rawNorm);
  const askedSize = extractSizeQuery(queryLower);

  const m = queryLower.match(/\/product\/([a-z0-9\-]+)/i);
  const slugFromUrl = m?.[1] || null;

  if (slugFromUrl) {
    const hit = KNOWLEDGE.items.find(x => normLower(x.product_slug) === slugFromUrl);
    if (hit) return { type: "hit", item: hit, askedSize };
  }

  // exact slug
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

const brandStd = normLower(x.brand_std);
const brandTags = normLower(x.brand_tags);
const gender = normLower(x.gender);
const gender2 = normLower(x.gender_2);
const ageGroup = normLower(x.age_group);

const sizes = normLower(x.sizes);
const sizesMin = String(x.sizes_min ?? "");
const sizesMax = String(x.sizes_max ?? "");

const availability = normLower(x.availability);
const pageUrl = normLower(x.page_url);
const imageUrl = normLower(x.image_url);

const price = Number(x.price || 0);
const oldPrice = Number(x.old_price || 0);
const hasDiscount = !!x.has_discount;
const discountPercent = Number(x.discount_percent || 0);

    const isPolicyLike =
      slug.startsWith("policy-") ||
      slug.startsWith("info-") ||
      slug.startsWith("branch-") ||
      tags.includes("سياسات") ||
      tags.includes("فروع");

    // فلترة المقاس للمنتجات فقط
    if (askedSize && !isPolicyLike) {
      const list = sizes.split(",").map(s => s.trim());
      if (!list.includes(String(askedSize))) continue;
    }
const moneyQ = extractMoneyQuery(queryLower);
const genderHint = extractGenderHint(queryLower);
const wantsDiscount = extractDiscountHint(queryLower);

    let score = 0;

    // نقاط قوية
    if (name === queryLower) score += 80;
    if (slug && queryLower === slug) score += 90;
    // Boost قوي للأكواد/السلاج — لأنه نية شراء مباشرة
if (slug && /[a-z]+\d+/i.test(queryLower) && slug.includes(queryLower)) score += 70;

// Boost للماركة القياسية
if (brandStd && (brandStd === queryLower || brandStd.includes(queryLower))) score += 35;

// جندر/فئة
if (genderHint) {
  // نرفع اللي يطابق الجمهور المستهدف
  if (gender.includes("رجال") || gender.includes("male")) {
    if (genderHint === "male") score += 25;
  }
  if (gender.includes("نساء") || gender.includes("female")) {
    if (genderHint === "female") score += 25;
  }
  if (gender.includes("ولادي") || gender.includes("kids")) {
    if (genderHint === "kids_male" || genderHint === "kids_female") score += 18;
  }
  if (gender.includes("بناتي")) {
    if (genderHint === "kids_female") score += 22;
  }
}

// الخصومات
if (wantsDiscount) {
  if (hasDiscount) score += 18;
  if (discountPercent >= 20) score += 6;
}

// السعر (تلميح)
if (moneyQ && price > 0) {
  const diff = Math.abs(price - moneyQ);
  if (diff <= 20) score += 14;
  else if (diff <= 50) score += 8;
}
    if (name.includes(queryLower) || queryLower.includes(name)) score += 35;
    if (slug && queryLower.includes(slug)) score += 60;

    const hay = `${name} ${keywords} ${tags} ${brandStd} ${brandTags} ${gender} ${gender2} ${ageGroup} ${sizes} ${sizesMin} ${sizesMax} ${availability} ${pageUrl} ${imageUrl} ${slug}`;
    for (const t of tokens) {
      if (!t) continue;
      if (name.includes(t)) score += 10;
      if (keywords.includes(t)) score += 8;
      if (tags.includes(t)) score += 7;
      if (brandStd.includes(t)) score += 9;
if (gender.includes(t)) score += 6;
if (gender2.includes(t)) score += 6;
if (ageGroup.includes(t)) score += 5;
if (availability.includes(t)) score += 3;
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

// ====== Main handler ======
export function handleQuery(q, ctx = {}) {
  const raw = normalizeText(q);
  const ql = raw.toLowerCase();

  // شكر/إغلاق
  if (/^(شكرا|شكرًا|يسلمو|يسلموا|مشكور|تسلم)\s*$/i.test(raw)) {
    return {
      ok: true,
      found: true,
      reply: "يسعدني 😊 إذا بدك توصيل/تبديل/أو اقتراح حذاء، احكيلي شو بتدور عليه.",
      tags: ["thanks"]
    };
  }

  // طلب موظف
  if (/بدي حدا احكي معاه|بدي احكي مع موظف|موظف|خدمة العملاء|بدي دعم/i.test(raw)) {
    return {
      ok: true,
      found: false,
      reply: "تمام 🙏 رح أحوّل طلبك لموظف خدمة العملاء. اترك رقمك/اسمك لو سمحت وبيرجعولك بأقرب وقت.",
      tags: ["تصعيد"]
    };
  }

  const conversationId = ctx?.conversationId ?? null;
  const choiceMemory = ctx?.choiceMemory;
  const convKey = conversationId !== null ? String(conversationId) : null;

  // 0) اختيار رقم من قائمة (1/2/3/4) — مهم: بعد stripHtml بيصير الرقم رقم فعلاً
  const choiceNum = raw.match(/^\s*([1-4])\s*$/)?.[1] || null;
  if (choiceNum && convKey && choiceMemory?.has(convKey)) {
    const mem = choiceMemory.get(convKey);
    const picked = mem?.options?.[Number(choiceNum) - 1];

    if (picked?.slug) {
      const pickedResult = searchKnowledge(picked.slug);
      if (pickedResult.type === "hit" && pickedResult.item) {
        return {
          ok: true,
          found: true,
          reply: buildReplyFromItem(pickedResult.item),
          tags: ["lead_product", "selection_made", "price_inquiry"]
        };
      }
    }

    return {
      ok: true,
      found: false,
      reply: "تمام 😊 اختار رقم من القائمة السابقة (1 أو 2 أو 3).",
      tags: ["توضيح"]
    };
  }

  // 1) Intent بسيط
  const isShipping = /توصيل|شحن/.test(ql);
  const isReturn = /إرجاع|ارجاع|ترجيع|استرجاع/.test(ql);
  const isExchange = /تبديل|استبدال/.test(ql);
  const isBranches = /فرع|فروع|موقع|وين/.test(ql);

  // 2) إرجاع/تبديل
  if (isReturn || isExchange) {
    return {
      ok: true,
      found: true,
      reply: PROFILE.replies_shami.policy_return_exchange,
      tags: ["policy_exchange"]
    };
  }

  // 3) توصيل
  if (isShipping) {
    const city = extractCityFromText(ql);
    if (!city) {
      return {
        ok: true,
        found: false,
        reply: PROFILE.replies_shami.policy_shipping_intro,
        tags: ["lead_shipping", "needs_city"]
      };
    }

    const { fee, zone } = classifyShipping(city);
    if (fee === null) {
      return {
        ok: true,
        found: false,
        reply:
          "تمام 😊 بس حتى أعطيك رقم صحيح: المدينة هاي **داخل فلسطين** ولا **القدس** ولا **الداخل (48)**؟ اكتبها/وضّحلي وبطلعلك الرسوم فورًا.",
        tags: ["lead_shipping", "needs_clarification", zone]
      };
    }

    const daysMin = PROFILE.shipping.days_min;
    const daysMax = PROFILE.shipping.days_max;

    return {
      ok: true,
      found: true,
      reply: `${pickOpening()} توصيل ${city} رسومه ${fee} شيكل. ومدة التوصيل عادة بين ${daysMin} إلى ${daysMax} أيام عمل.`,
      tags: ["lead_shipping", zone]
    };
  }

  // 4) طلب عام لمنتج
  const genericProductAsk = /بدّي|بدي|عايز|حذاء|كوتشي|جزمة|بوط|صندل|كروكس|شوز/.test(ql);

  if (genericProductAsk && raw.length <= 30) {
    const hasSize = !!extractSizeQuery(ql);
    const hasMoney = /\d+\s*(شيكل|₪)/.test(ql);
    const hasBrandHint = /joma|skechers|nike|adidas|puma|crocs|mizuno|brooks|asics|diadora/i.test(raw);

    if (!hasSize && !hasMoney && !hasBrandHint) {
      return {
        ok: true,
        found: false,
        reply: PROFILE.replies_shami.ask_more_for_products,
        tags: ["lead_product", "needs_clarification"]
      };
    }
  }

  // 5) المقاس فقط → سؤال توضيح (حتى ما نرمي منتج واحد بالغلط)
  const askedSize = extractSizeQuery(ql);
  if (askedSize && isOnlySizeQuery(raw)) {
    return {
      ok: true,
      found: false,
      reply: `${pickOpening()} المقاس ${askedSize} بدك **رجالي ولا نسائي**؟ وكمان بتحب السعر ضمن أي مدى تقريبًا؟`,
      tags: ["lead_product", "needs_clarification", "size_only"]
    };
  }

  // 6) بحث عام
  const result = searchKnowledge(raw);

  if (result.type === "hit" && result.item) {
    const slug = String(result.item.product_slug || "").toLowerCase();
    const isPolicyLike = slug.startsWith("policy-") || slug.startsWith("info-") || slug.startsWith("branch-");

    // حماية: سؤال منتج عام لا يرجع سياسة بالغلط
    if (isPolicyLike && genericProductAsk) {
      return {
        ok: true,
        found: false,
        reply: PROFILE.replies_shami.ask_more_for_products,
        tags: ["lead_product", "needs_clarification"]
      };
    }

    return {
      ok: true,
      found: true,
      reply: buildReplyFromItem(result.item),
      tags: ["lead_product", "price_inquiry"]
    };
  }

  if (result.type === "clarify") {
    const opts = (result.options || []).slice(0, 3);

    if (convKey && choiceMemory) {
      choiceMemory.set(convKey, { ts: Date.now(), options: opts });
    }

    const lines = [];
    lines.push(`${pickOpening()} لقيت أكثر من خيار، اختر رقم:`);
    opts.forEach((o, i) => {
      const r = searchKnowledge(o.slug);
      const it = r?.item;
      const price = it?.price ? `${it.price} شيكل` : "";
      const avail = it?.availability ? it.availability : "";
      const parts = [o.name, price, avail].filter(Boolean);
      lines.push(`${i + 1}) ${parts.join(" — ")}`);
    });
    lines.push("اكتب رقم الخيار فقط (مثال: 1).");

    return {
      ok: true,
      found: false,
      reply: lines.join("\n"),
      tags: ["lead_product", "needs_clarification", "has_choices"]
    };
  }

  // 7) فروع
  if (isBranches) {
    return {
      ok: true,
      found: false,
      reply: "تمام 😊 بتقصد **موقع الفروع** ولا **موقع المقر**؟ احكيلي شو بدك بالزبط.",
      tags: ["lead_branches", "needs_clarification"]
    };
  }

  // fallback
  return {
    ok: true,
    found: false,
    reply: "تمام 😊 احكيلي بدقّة: سؤالك عن **التوصيل** ولا **التبديل** ولا بدك **اقتراح منتجات**؟",
    tags: ["needs_clarification"]
  };
}
