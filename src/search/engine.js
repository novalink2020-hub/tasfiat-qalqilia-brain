// Stage 2: Human-friendly replies + numbered choices + basic intent handling (Chatwoot-safe)
import { getKnowledge } from "../knowledge/loader.js";
import { classifyCityZone } from "../geo/classifier.js";
import { detectOutOfScopePlace } from "../geo/out-of-scope.js";
import { PROFILE } from "../client.profile.js";
import { buildReplyFromItem } from "../replies/presenter.js";
import fs from "fs";
import path from "path";
import { normalizeForMatch, tokenize } from "../text/normalize.js";

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
let FOREIGN_CACHE = null;

function loadForeignPlacesOnce() {
  if (FOREIGN_CACHE) return FOREIGN_CACHE;
  const p = path.resolve("src/text/foreign_places.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const arr = Array.isArray(raw?.places) ? raw.places : [];
  // نخزنها مطبعة وجاهزة للمطابقة
  FOREIGN_CACHE = arr.map(x => normalizeForMatch(x)).filter(Boolean);
  return FOREIGN_CACHE;
}

function isForeignPlace(text) {
  const q = normalizeForMatch(text);
  if (!q) return false;
  const list = loadForeignPlacesOnce();
  // مطابقة احتوائية بعد التطبيع
  return list.some(k => k && (q.includes(k) || k.includes(q)));
}
function looksLikeProductSlug(s) {
  const q = String(s || "").trim();
  // مثل: skechers-405000n-bkrd / nike-dd1095-608
  return /^[a-z0-9]+(?:-[a-z0-9]+){2,}$/i.test(q);
}

function looksLikeProductCode(s) {
  const q = String(s || "").trim();
  // مثل: TOJS2401TF / 9Q1306-X0L / DD1095 608 (بعد التنظيف)
  return /[a-z]{2,}\d{2,}[a-z0-9\-]{0,}/i.test(q);
}

function isProductIntent(rawText) {
  const q = String(rawText || "").toLowerCase();

  // 1) slug أو كود → منتج مباشرة
  if (looksLikeProductSlug(q) || looksLikeProductCode(q)) return true;

  // 2) كلمات شراء/منتج شائعة (لغة المستخدم)
  if (/(حذاء|جزمه|جزمة|كوتشي|بوط|صندل|شبشب|طقم|تيشيرت|بنطال|جاكيت|بلوزه|بلوزة|شنطه|شنطة|عطر|برفان|كرة قدم|مدارس|جري|مشي|تدريب|مقاس|نمره|نمرة|قياس|ولادي|بناتي|رجالي|نسائي|ستاتي)/.test(q)) {
    return true;
  }

  // 3) اسم ماركة (بدون تعداد يدوي لكل الماركات):
  // نعتبر أي كلمة واحدة طولها 3-8 أحرف عربية/لاتينية قد تكون ماركة شائعة، ونترك البحث يقرر.
  const t = q.trim();
  if (t.split(/\s+/).length === 1 && t.length >= 3 && t.length <= 10) return true;

  return false;
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
  const out = detectOutOfScopePlace(city);
if (out.scope === "outside_palestine") return { fee: null, zone: "outside", policy: out.policy };
if (out.scope === "gaza") return { fee: null, zone: "gaza", policy: out.policy };

  // إشارات خارج النطاق (اختياري إبقاؤه)
  const cityLower = city.toLowerCase();
if (isForeignPlace(city)) {
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
function isUsableProductItem(x) {
  const hasName = String(x?.name || "").trim().length >= 2;
  const hasUrl = String(x?.page_url || "").trim().startsWith("http");
  const hasSlug = String(x?.product_slug || "").trim().length >= 2;
  return hasName && hasUrl && hasSlug;
}

function searchKnowledge(q) {
  const KNOWLEDGE = getKnowledge();
  if (!KNOWLEDGE?.items?.length) return { type: "none", askedSize: null };

const queryLower = normalizeForMatch(q);
  const rawSlug = String(q || "").trim().toLowerCase(); // للـ slug كما هو بدون تطبيع

const tokens = tokenize(q);

const looksLikeSlug = /^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(queryLower);
const askedSize = looksLikeSlug ? null : extractSizeQuery(queryLower);
  
  const m = queryLower.match(/\/product\/([a-z0-9\-]+)/i);
  const slugFromUrl = m?.[1] || null;

if (slugFromUrl) {
  const hit = KNOWLEDGE.items.find(x => normLower(x.product_slug) === slugFromUrl);
  if (hit && isUsableProductItem(hit)) return { type: "hit", item: hit, askedSize };
  // إذا موجود لكنه ناقص بيانات: لا نعرض "—"
  if (hit) return { type: "none", askedSize };
}

  // exact slug
const directSlug = KNOWLEDGE.items.find(x => {
  const slug = normLower(x.product_slug);
  return slug && (slug === rawSlug || slug === queryLower);
});
if (directSlug) return { type: "hit", item: directSlug, askedSize };

// إذا slug موجود لكنه ناقص بيانات: لا نعرضه كمنتج
if (directSlug) return { type: "none", askedSize };

  const scored = [];
  for (const x of KNOWLEDGE.items) {
    // حماية UX: لا نعرض منتجات ناقصة
const hasName = String(x?.name || "").trim().length >= 2;
const hasUrl = String(x?.page_url || "").trim().startsWith("http");
const hasSlug = String(x?.product_slug || "").trim().length >= 2;
if (!hasSlug || !hasUrl) continue;
// (اختياري) شدّد أكثر:
// const hasPrice = Number(x?.price || 0) > 0;
// if (!hasName || !hasPrice) continue;
if (!hasName) continue;

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
      // إذا الاستعلام كلمة واحدة قصيرة (غالبًا ماركة/اسم شائع) نرفع الوزن بشكل واضح
const isBrandishQuery = (tokens.length === 1 && queryLower.length <= 6);
if (keywords.includes(t)) score += (isBrandishQuery ? 22 : 8);

      if (tags.includes(t)) score += 7;
const isBrandishQuery2 = (tokens.length === 1 && queryLower.length <= 6);
if (brandStd.includes(t)) score += (isBrandishQuery2 ? 26 : 9);
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
const isBrandishQueryFinal = (tokens.length === 1 && queryLower.length <= 6);
const minScore = isBrandishQueryFinal ? 12 : 25;
if (top.score < minScore) return { type: "none", askedSize };

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
// Router شامل مبكر: أي رسالة تبدو “منتج/شراء” → نبحث مباشرة قبل أي أسئلة عامة
if (isProductIntent(raw)) {
  const res = searchKnowledge(raw);

  if (res.type === "hit") {
    return { ok: true, found: true, reply: buildReplyFromItem(res.item), tags: ["product_hit"] };
  }

  if (res.type === "clarify") {
    const KNOWLEDGE = getKnowledge();
    const items = res.options
      .map(o => KNOWLEDGE.items.find(x => String(x.product_slug || "") === String(o.slug || "")))
      .filter(Boolean)
      .slice(0, 3);

    if (items.length) {
      const lines = items.map((it) => `${it.name} — ${it.price} شيكل — ${it.availability || "متوفر"}`);
      return {
        ok: true,
        found: false,
        reply: `تمام 😊 لقيت أكثر من خيار، اختر رقم:\n\n${lines.join("\n")}\nاكتب رقم الخيار فقط (مثال: 1).`,
        tags: ["product_clarify"]
      };
    }
  }

  // إذا واضح أنه slug/كود لكن لم نجد نتيجة: أعطه رابط مباشر بدل “ما قدرت أحدد”
  if (looksLikeProductSlug(rawSlug) || looksLikeProductCode(rawSlug)) {
    const slugGuess = rawSlug;
    return {
      ok: true,
      found: false,
      reply: `آسفين 🙏 الكود واضح بس بيانات المنتج عندنا مش مكتملة أو مش موجودة حاليًا. هذا رابط الصفحة للتأكد:\nhttps://tasfiat-qalqilia.ps/ar/product/${slugGuess}`,
      tags: ["product_none"]
    };
  }

  return {
    ok: true,
    found: false,
    reply: "تمام 😊 اكتب اسم المنتج أو الماركة + (رجالي/نسائي/ولادي) وإذا بتقدر المقاس، وبطلعلك أفضل الخيارات فورًا.",
    tags: ["product_none"]
  };
}


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
  // خارج فلسطين
  if (zone === "outside") {
    return {
      ok: true,
      found: false,
      reply: "آسفين 🙏 التوصيل متاح **داخل فلسطين فقط**.",
      tags: ["lead_shipping", "out_of_scope", zone]
    };
  }

  // قطاع غزة
  if (zone === "gaza") {
    return {
      ok: true,
      found: false,
      reply: "آسفين 🙏 حاليًا **ما في توصيل لقطاع غزة**.",
      tags: ["lead_shipping", "out_of_scope", zone]
    };
  }

  // غير معروف داخل فلسطين → استيضاح (تعديل النص المطلوب)
  return {
    ok: true,
    found: false,
    reply: "تمام 😊 بس حتى أعطيك رقم صحيح: المدينة هاي في **الضفة** ولا **القدس** ولا **الداخل (48)**؟ اكتبها/وضّحلي وبطلعلك الرسوم فورًا.",
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
// Router شامل: إذا الرسالة تبدو “منتج” لا نسأل سؤال نية عام — نبحث مباشرة
if (isProductIntent(raw)) {
  const res = searchKnowledge(raw);

  if (res.type === "hit") {
    return { ok: true, found: true, reply: buildReplyFromItem(res.item), tags: ["product_hit"] };
  }

  if (res.type === "clarify") {
    // نعرض خيارات بدل سؤال عام
    const lines = res.candidates.slice(0, 3).map((c, i) =>
      `${c.item.name} — ${c.item.price} شيكل — ${c.item.availability || "متوفر"}`
    );
    return {
      ok: true,
      found: false,
      reply: `تمام 😊 لقيت أكثر من خيار، اختر رقم:\n\n${lines.join("\n")}\nاكتب رقم الخيار فقط (مثال: 1).`,
      tags: ["product_clarify"]
    };
  }

  // res.type === "none"
  return {
    ok: true,
    found: false,
    reply: "تمام 😊 ما قدرت أحدد المنتج بالضبط من الرسالة. اكتب اسم المنتج أو الكود/الرابط وبساعدك فورًا.",
    tags: ["product_none"]
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
