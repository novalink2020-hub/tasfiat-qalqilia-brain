// Stage 2: Human-friendly replies + numbered choices + basic intent handling (Chatwoot-safe)
// ✅ Updated for NEW knowledge schema: section + audience + keywords + brand_tags (and NO age_group)

import { getKnowledge } from "../knowledge/loader.js";
import { classifyCityZone } from "../geo/classifier.js";
import { detectOutOfScopePlace } from "../geo/out-of-scope.js";
import { PROFILE } from "../client.profile.js";
import { buildReplyFromItem } from "../replies/presenter.js";
import fs from "fs";
import path from "path";
import { normalizeForMatch, tokenize } from "../text/normalize.js";

/* =========================
   Basic text utils
   ========================= */

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

/** Arabic folding to catch typos + normalize variations */
function normalizeArabic(s) {
  const x = String(s || "");
  return x
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "") // tashkeel
    .replace(/[إأآٱ]/g, "ا") // alef
    .replace(/ى/g, "ي") // yaa/maqsura
    .replace(/ة/g, "ه") // ta marbuta -> ha
    .replace(/ـ/g, "") // tatweel
    .replace(/(.)\1{2,}/g, "$1$1") // repeated letters (3+ -> 2)
    .trim();
}

function extractMoneyQuery(queryLower) {
  const m = String(queryLower || "").match(/(\d{2,5})\s*(شيكل|₪)/);
  return m ? Number(m[1]) : null;
}

/**
 * Legacy gender hint (kept for compatibility with old intents),
 * but NEW schema uses audience (رجالي/ستاتي/ولادي/بناتي) for scoring.
 */
function extractGenderHint(queryLower) {
  const q = String(queryLower || "");
  if (/رجالي|للرجال|شباب|رجال/.test(q)) return "male";
  if (/نسائي|للنساء|بنات|ستاتي|حريمي|نساء/.test(q)) return "female";
  if (/ولادي|أولادي|اطفال|أطفال|صبيان|اولاد|مدارس/.test(q)) return "kids_male";
  if (/بناتي|بنوتي|طفله|طفلة/.test(q)) return "kids_female";
  return null;
}

/** NEW: section hint from user query */
function extractSectionHint(queryLower) {
  const q = String(queryLower || "");
  if (/عطر|عطور|برفان|كولونيا|perfume/.test(q)) return "عطور";
  if (/تي\s?شيرت|قميص|بنطلون|هودي|جاكيت|بلوزه|بلوزة|ملابس|ترينج|تريننج|فستان/.test(q)) return "ملابس";
  if (/حذاء|احذيه|أحذية|جزمه|جزمة|كوتشي|شوز|بوت|صندل|شبشب|كروكس/.test(q)) return "أحذية";
  return null;
}

/** NEW: audience hint from user query */
function extractAudienceHint(queryLower) {
  const q = String(queryLower || "");
  if (/رجالي|للرجال|شباب|رجال/.test(q)) return "رجالي";
  if (/ستاتي|نسائي|للنساء|حريمي|نساء/.test(q)) return "ستاتي";
  if (/ولادي|أولاد|اولاد|صبيان|اطفال|أطفال|طفل|مدارس/.test(q)) return "ولادي";
  if (/بناتي|بنات|بنوتي|طفله|طفلة|مدارس/.test(q)) return "بناتي";
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

/* =========================
   Brand dictionary (brand_std + aliases)
   ========================= */

let BRAND_CACHE = null;

function normKey(s) {
  // key موحّد للمقارنة بين: brand_std في المعرفة + aliases في القاموس + نص المستخدم
  return normalizeForMatch(String(s || ""))
    .replace(/\s+/g, "")
    .toLowerCase()
    .trim();
}

function loadBrandDictionaryOnce() {
  if (BRAND_CACHE) return BRAND_CACHE;

  const p = path.resolve("src/search/brand.dictionary.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));

  const brands = Array.isArray(raw?.brands) ? raw.brands : [];

  BRAND_CACHE = brands
    .map((b) => {
      const brandStd = String(b?.brand_std || "").trim();
      if (!brandStd) return null;

      const baseAliases = []
        .concat([brandStd, b?.en, b?.ar])
        .concat(Array.isArray(b?.aliases) ? b.aliases : [])
        .concat(Array.isArray(b?.normalize_from_knowledge_brand_std) ? b.normalize_from_knowledge_brand_std : [])
        .filter(Boolean)
        .map((x) => String(x).trim())
        .filter(Boolean);

      const brandKey = normKey(brandStd);
      const aliasKeys = Array.from(new Set(baseAliases.map(normKey).filter(Boolean)));

      return { brandStd, brandKey, aliasKeys };
    })
    .filter(Boolean);

  return BRAND_CACHE;
}

function detectBrandInfo(text) {
  const qKey = normKey(text);
  if (!qKey) return null;

  const list = loadBrandDictionaryOnce();

  for (const b of list) {
    // exact match أولاً (ماركة فقط غالباً)
    for (const a of b.aliasKeys) {
      if (!a) continue;
      if (qKey === a) return { brandStd: b.brandStd, brandKey: b.brandKey, exact: true };
    }
    // contains match (مثال: "بدي حذاء سكيتشرز")
    for (const a of b.aliasKeys) {
      if (!a) continue;
      if (qKey.includes(a)) return { brandStd: b.brandStd, brandKey: b.brandKey, exact: false };
    }
  }
  return null;
}

/* =========================
   NEW: Brand fallback from knowledge.brand_tags
   (in case dictionary misses a brand/typo variant)
   ========================= */

let BRAND_TAG_INDEX = null;

function buildBrandTagIndexOnce() {
  if (BRAND_TAG_INDEX) return BRAND_TAG_INDEX;

  const KNOWLEDGE = getKnowledge();
  const index = new Map(); // aliasKey -> { brandStd, brandKey }

  const items = Array.isArray(KNOWLEDGE?.items) ? KNOWLEDGE.items : [];
  for (const x of items) {
    const bStd = String(x?.brand_std || "").trim();
    if (!bStd) continue;

    const bKey = normKey(bStd);
    if (!bKey) continue;

    const tagsRaw = String(x?.brand_tags || "");
    const tags = tagsRaw
      .split("|")
      .map((t) => String(t || "").trim())
      .filter(Boolean);

    // include std itself too
    tags.push(bStd);

    for (const t of tags) {
      const k = normKey(t);
      if (!k) continue;
      if (!index.has(k)) index.set(k, { brandStd: bStd, brandKey: bKey });
    }
  }

  BRAND_TAG_INDEX = index;
  return BRAND_TAG_INDEX;
}

function detectBrandFromKnowledgeTags(text) {
  const qKey = normKey(text);
  if (!qKey) return null;

  const idx = buildBrandTagIndexOnce();

  // exact
  if (idx.has(qKey)) {
    const b = idx.get(qKey);
    return { ...b, exact: true, source: "knowledge_tags" };
  }

  // contains: try tokens first for speed, then fallback to scanning map keys
  const toks = tokenize(text).map(normKey).filter(Boolean);
  for (const t of toks) {
    if (idx.has(t)) {
      const b = idx.get(t);
      return { ...b, exact: false, source: "knowledge_tags" };
    }
  }

  // slow path (still ok for typical sizes): scan keys
  for (const [k, b] of idx.entries()) {
    if (k && (qKey.includes(k) || k.includes(qKey))) {
      return { ...b, exact: false, source: "knowledge_tags" };
    }
  }

  return null;
}

/* =========================
   Intent heuristics
   ========================= */

function looksLikeProductSlug(s) {
  const q = String(s || "").trim();
  return /^[a-z0-9]+(?:-[a-z0-9]+){2,}$/i.test(q);
}

function looksLikeProductCode(s) {
  const q = String(s || "").trim();
  return /[a-z]{2,}\d{2,}[a-z0-9\-]{0,}/i.test(q);
}

function isProductIntent(rawText) {
  const q = String(rawText || "").toLowerCase();

  if (looksLikeProductSlug(q) || looksLikeProductCode(q)) return true;

  // وجود ماركة (حتى غلط إملائي) = نية منتج
  if (detectBrandInfo(rawText) || detectBrandFromKnowledgeTags(rawText)) return true;

  if (
    /(حذاء|جزمه|جزمة|كوتشي|بوط|صندل|شبشب|طقم|تيشيرت|بنطال|جاكيت|بلوزه|بلوزة|شنطه|شنطة|عطر|برفان|كرة قدم|مدارس|جري|مشي|تدريب|مقاس|نمره|نمرة|قياس|ولادي|بناتي|رجالي|نسائي|ستاتي)/.test(
      q
    )
  ) {
    return true;
  }

  const t = q.trim();
  if (/(موقع|موقعكم|لوكيشن|عنوان|فروع|فرع)/.test(q)) return false;
  if (t.split(/\s+/).length === 1 && t.length >= 3 && t.length <= 10) return true;

  return false;
}

function pickOpening() {
  const arr = ["تمام 😊", "ولا يهمك 😊", "حاضر 👌", "يسعدني 😊"];
  return arr[Math.floor(Math.random() * arr.length)];
}

/* =========================
   Shipping helpers
   ========================= */

let FOREIGN_CACHE = null;

function loadForeignPlacesOnce() {
  if (FOREIGN_CACHE) return FOREIGN_CACHE;
  const p = path.resolve("src/text/foreign_places.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const arr = Array.isArray(raw?.places) ? raw.places : [];
  FOREIGN_CACHE = arr.map((x) => normalizeForMatch(x)).filter(Boolean);
  return FOREIGN_CACHE;
}

function isForeignPlace(text) {
  const q = normalizeForMatch(text);
  if (!q) return false;
  const list = loadForeignPlacesOnce();
  return list.some((k) => k && (q.includes(k) || k.includes(q)));
}

function extractCityFromText(textLower) {
  const clean = String(textLower || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[^\p{L}\p{N}\s\-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  // 1) صيغ الناس: على / الى / إلى / ع / عـ / ل / لـ
  const m1 = clean.match(/(?:على|في|داخل|ضمن|جوا:?|الى|إلى|عـ?|لـ?)\s+(.+)$/);
  if (m1?.[1]) return m1[1].trim();

  // 2) “توصيل قلقيلية” / “كم التوصيل ع قلقيلية” / “شحن ل حبلة”
  const m2 = clean.match(/^(?:كم\s+)?(?:التوصيل|توصيل|الشحن|شحن)\s*(?:على|في|داخل|ضمن|جوا:?|الى|إلى|عـ?|لـ?)?\s*(.+)$/);
  if (m2?.[1]) return m2[1].trim();

  // 3) إذا النص كلمة/مدينة قصيرة لوحدها
  if (clean.length <= 22) return clean;

  return null;
}

function classifyShipping(cityRaw) {
  const city = String(cityRaw || "").trim();
  if (!city) return { fee: null, zone: "unknown" };

  const out = detectOutOfScopePlace(city);
  if (out.scope === "outside_palestine") return { fee: null, zone: "outside", policy: out.policy };
  if (out.scope === "gaza") return { fee: null, zone: "gaza", policy: out.policy };

  if (isForeignPlace(city)) {
    return { fee: null, zone: "outside" };
  }

  const zone = classifyCityZone(city);

  if (!zone) return { fee: null, zone: "unknown" };

  if (zone === "inside_1948") {
    return { fee: PROFILE.shipping.fees_ils.inside_1948, zone };
  }

  if (zone === "jerusalem") {
    return { fee: PROFILE.shipping.fees_ils.jerusalem, zone };
  }

  if (zone === "west_bank" || zone === "jerusalem_suburbs") {
    return { fee: PROFILE.shipping.fees_ils.west_bank, zone };
  }

  return { fee: null, zone: "unknown" };
}

/* =========================
   Knowledge search (NEW schema aware)
   ========================= */

function isUsableProductItem(x) {
  const hasName = String(x?.name || "").trim().length >= 2;
  const hasUrl = String(x?.page_url || "").trim().startsWith("http");
  const hasSlug = String(x?.product_slug || "").trim().length >= 2;
  return hasName && hasUrl && hasSlug;
}

let SLUG_INDEX = null;

function buildSlugIndexOnce() {
  if (SLUG_INDEX) return SLUG_INDEX;
  const KNOWLEDGE = getKnowledge();
  const idx = new Map();
  const items = Array.isArray(KNOWLEDGE?.items) ? KNOWLEDGE.items : [];
  for (const x of items) {
    const slug = String(x?.product_slug || "").trim().toLowerCase();
    if (!slug) continue;
    if (!idx.has(slug)) idx.set(slug, x);
  }
  SLUG_INDEX = idx;
  return SLUG_INDEX;
}

function getItemBySlug(slug) {
  const s = String(slug || "").trim().toLowerCase();
  if (!s) return null;
  const idx = buildSlugIndexOnce();
  return idx.get(s) || null;
}

function normalizeKeyForScoring(s) {
  // aggressive matching for section/audience tokens in Arabic
  return normalizeArabic(normalizeForMatch(String(s || ""))).toLowerCase();
}

function pickAlternatives(KNOWLEDGE, item, limit = 2) {
  const sec = String(item?.section || "").trim();
  const aud = String(item?.audience || "").trim();
  const bKey = normKey(item?.brand_std || "");
  const slug = String(item?.product_slug || "").trim().toLowerCase();

  const pool = (KNOWLEDGE?.items || [])
    .filter((x) => isUsableProductItem(x))
    .filter((x) => String(x?.product_slug || "").trim().toLowerCase() !== slug)
    .filter((x) => String(x?.section || "").trim() === sec)
    .filter((x) => String(x?.audience || "").trim() === aud);

  const sameBrand = pool.filter((x) => normKey(x?.brand_std || "") === bKey);

  const picked = (sameBrand.length ? sameBrand : pool).slice(0, limit);

  return picked.map((x) => ({
    name: x.name || "",
    slug: x.product_slug || "",
    price: x.price || "",
    availability: x.availability || ""
  }));
}

function buildSalesAddon() {
  // ✅ تم تعطيل الإضافات/البدائل نهائيًا لتقليل التشتيت
  // التنسيق + الخصم صاروا داخل presenter.js فقط
  return "";
}

function searchKnowledge(q, opts = {}) {
  const KNOWLEDGE = getKnowledge();
  if (!KNOWLEDGE?.items?.length) return { type: "none", askedSize: null };

  const queryLower = normalizeForMatch(q);
  const queryFold = normalizeKeyForScoring(q);
  const tokens = tokenize(q).map((t) => normalizeKeyForScoring(t)).filter(Boolean);

  const rawSlug = String(q || "").trim().toLowerCase();
  const looksLikeSlug = /^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(rawSlug);
  const askedSize = looksLikeSlug ? null : extractSizeQuery(queryLower);

  const brandKey = opts?.brandKey ? String(opts.brandKey) : null;
  const brandExact = !!opts?.brandExact;

  // NEW: section/audience hints
  const sectionHint = extractSectionHint(queryLower);
  const audienceHint = extractAudienceHint(queryLower);

  // URL -> slug
  const m = String(q || "").match(/\/product\/([a-z0-9\-]+)/i);
  const slugFromUrl = m?.[1] || null;

  if (slugFromUrl) {
    const hit = getItemBySlug(slugFromUrl);
    if (hit && isUsableProductItem(hit)) return { type: "hit", item: hit, askedSize };
    if (hit) return { type: "none", askedSize };
  }

  // exact slug
  const directSlug = getItemBySlug(rawSlug) || getItemBySlug(queryLower);
  if (directSlug && isUsableProductItem(directSlug)) return { type: "hit", item: directSlug, askedSize };
  if (directSlug) return { type: "none", askedSize };

  const scored = [];

  for (const x of KNOWLEDGE.items) {
    if (!isUsableProductItem(x)) continue;

    const slug = normLower(x.product_slug);
    const name = String(x.name || "");
    const nameLow = normLower(name);

    const keywords = String(x.keywords || "");
    const keywordsLow = normLower(keywords);

    const tags = String(x.brand_tags || "");
    const tagsLow = normLower(tags);

    const brandStdRaw = String(x?.brand_std || "");
    const itemBrandKey = normKey(brandStdRaw);

    // STRICT brand filter if brandKey is known
    if (brandKey && itemBrandKey && itemBrandKey !== brandKey) continue;

    const gender = String(x.gender || "");
    const gender2 = String(x.gender_2 || "");
    const genderLow = normLower(gender);
    const gender2Low = normLower(gender2);

    // NEW schema fields
    const section = String(x.section || "");
    const audience = String(x.audience || "");
    const sectionLow = normLower(section);
    const audienceLow = normLower(audience);

    const sectionFold = normalizeKeyForScoring(section);
    const audienceFold = normalizeKeyForScoring(audience);

    const sizes = normLower(x.sizes);
    const availability = normLower(x.availability);

    const price = Number(x.price || 0);
    const hasDiscount = !!x.has_discount;
    const discountPercent = Number(x.discount_percent || 0);

    const isPolicyLike =
      slug.startsWith("policy-") ||
      slug.startsWith("info-") ||
      slug.startsWith("branch-") ||
      tagsLow.includes("سياسات") ||
      tagsLow.includes("فروع");

    if (askedSize && !isPolicyLike) {
      const list = sizes.split(",").map((s) => s.trim());
      if (!list.includes(String(askedSize))) continue;
    }

    const moneyQ = extractMoneyQuery(queryLower);
    const genderHint = extractGenderHint(queryLower);
    const wantsDiscount = extractDiscountHint(queryLower);

    let score = 0;

    // Brand base score (after filtering)
    if (brandKey && itemBrandKey === brandKey) score += 14;

    // Strong exact matches
    if (nameLow === queryLower) score += 90;
    if (slug && queryLower === slug) score += 95;
    if (slug && /[a-z]+\d+/i.test(queryLower) && slug.includes(queryLower)) score += 75;

    // Brand boost
    if (brandKey && itemBrandKey === brandKey) score += 55;

    // NEW: section/audience hint boosts (high signal)
    if (sectionHint && section && section.includes(sectionHint)) score += 26;
    if (audienceHint && audience && audience.includes(audienceHint)) score += 26;

    // Legacy gender hint boost (lower than audience)
    if (genderHint) {
      if ((genderLow.includes("رجال") || genderLow.includes("male")) && genderHint === "male") score += 10;
      if ((genderLow.includes("نساء") || genderLow.includes("female")) && genderHint === "female") score += 10;
      if ((genderLow.includes("ولادي") || genderLow.includes("kids")) && (genderHint === "kids_male" || genderHint === "kids_female")) score += 8;
      if (genderLow.includes("بناتي") && genderHint === "kids_female") score += 9;
    }

    if (wantsDiscount) {
      if (hasDiscount) score += 18;
      if (discountPercent >= 20) score += 6;
    }

    if (moneyQ && price > 0) {
      const diff = Math.abs(price - moneyQ);
      if (diff <= 20) score += 14;
      else if (diff <= 50) score += 8;
    }

    // Partial phrase matches
    if (nameLow.includes(queryLower) || queryLower.includes(nameLow)) score += 32;
    if (slug && queryLower.includes(slug)) score += 60;

    // NEW hay: include section/audience explicitly
    const hay =
      `${nameLow} ${keywordsLow} ${tagsLow} ${normLower(brandStdRaw)} ` +
      `${genderLow} ${gender2Low} ${sectionLow} ${audienceLow} ${sizes} ${availability} ${slug}`;

    // Token scoring (balanced; keywords are already rich)
    const isBrandishQuery = tokens.length === 1 && queryFold.length <= 6;

    for (const t of tokens) {
      if (!t) continue;

      // Folded comparisons for Arabic-ish tokens
      const inName = normalizeKeyForScoring(nameLow).includes(t);
      const inSection = sectionFold.includes(t);
      const inAudience = audienceFold.includes(t);

      if (inName) score += 10;

      // keywords + brand_tags are the core
      if (normalizeKeyForScoring(keywordsLow).includes(t)) score += isBrandishQuery ? 22 : 8;
      if (normalizeKeyForScoring(tagsLow).includes(t)) score += 9;

      // section/audience are high intent too
      if (inSection) score += 8;
      if (inAudience) score += 8;

      // legacy fields (lower)
      if (normalizeKeyForScoring(genderLow).includes(t)) score += 5;
      if (normalizeKeyForScoring(gender2Low).includes(t)) score += 5;

      if (sizes.includes(String(t).replace(/[^\d.]/g, ""))) score += 12;
      if (slug.includes(String(t).replace(/\s+/g, ""))) score += 9;

      if (hay.includes(String(t))) score += 2;
    }

    // Policies
    const policyHints = ["توصيل", "شحن", "تبديل", "استبدال", "إرجاع", "خصوصية", "سياسة", "شروط", "فروع", "موقع"];
    if (isPolicyLike && policyHints.some((h) => queryLower.includes(h))) score += 25;

    if (score > 0) scored.push({ item: x, score });
  }

  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return { type: "none", askedSize };

  // Brand only (exact) => show top 3 always
  if (brandKey && brandExact) {
    const options = scored.slice(0, 3).map((s) => ({
      slug: s.item.product_slug || "",
      name: s.item.name || ""
    }));
    return { type: "clarify", options, askedSize };
  }

  const top = scored[0];
  const second = scored[1];

  const isBrandFiltered = !!brandKey;
  const isBrandishQueryFinal = tokens.length === 1 && queryFold.length <= 6;

  // NEW thresholds: a bit more tolerant because keywords are rich and section/audience help
  const minScore = isBrandFiltered ? 8 : isBrandishQueryFinal ? 12 : 24;
  if (top.score < minScore) return { type: "none", askedSize };

  if (second && second.score >= top.score - 6) {
    const options = scored.slice(0, 4).map((s) => ({
      slug: s.item.product_slug || "",
      name: s.item.name || ""
    }));
    return { type: "clarify", options, askedSize };
  }

  return { type: "hit", item: top.item, askedSize };
}

/* =========================
   Main handler
   ========================= */

export function handleQuery(q, ctx = {}) {
  const raw = normalizeText(q);
  const ql = raw.toLowerCase();

  // 1) Brand detection: dictionary first, then knowledge.brand_tags fallback
  const brandInfoPrimary = detectBrandInfo(raw); // {brandStd, brandKey, exact} أو null
  const brandInfoFallback = brandInfoPrimary ? null : detectBrandFromKnowledgeTags(raw);
  const brandInfo = brandInfoPrimary || brandInfoFallback;

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
  if (
    /بدي حدا احكي معاه|بدي احكي مع موظف|موظف|خدمة العملاء|بدي دعم|مساعدة|بدي مساعدة|مساعده|معلق|معلّق|مش راضي يكمل|ما بقدر اكمل|ما قدرت اكمل|وقف معي|مشكلة بالدفع|مشكلة بالطلب|مش شغال|مش زابط/i.test(
      raw
    )
  ) {
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

  // اختيار رقم من قائمة (generic)
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
          tags: ["lead_product", "selection_made", "price_inquiry", "سلة_التسوق"]
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

  // Intent بسيط
  const isShipping = /توصيل|شحن/.test(ql);
  const isReturn = /إرجاع|ارجاع|ترجيع|استرجاع/.test(ql);
  const isExchange = /تبديل|استبدال/.test(ql);
  const isPolicyPrivacy = /سياسة الخصوصية|الخصوصية|privacy/.test(ql);
  const isPolicyUsage = /سياسة الاستخدام|شروط الاستخدام|سياسة الاستعمال|terms|usage/.test(ql);

  const isBranches =
    /(فروع|فرع|معرض|معارض|مكان|مكانكم|موقع|موقعكم|لوكيشن|عنوانكم|وينكم|وين موقعكم)/.test(ql) &&
    !isProductIntent(raw) &&
    !isForeignPlace(raw);

  // إرجاع/تبديل
  if (isExchange) {
    return {
      ok: true,
      found: true,
      reply: PROFILE.replies_shami.policy_exchange_only,
      tags: ["policy_exchange"]
    };
  }

  if (isReturn) {
    return {
      ok: true,
      found: true,
      reply: PROFILE.replies_shami.policy_return_only,
      tags: ["policy_return"]
    };
  }

  // توصيل
  if (isShipping) {
    let city = extractCityFromText(ql);

    if (city) {
      city = String(city)
        .replace(/^(?:كم\s+)?(?:التوصيل|توصيل|الشحن|شحن)\s*/i, "")
        .replace(/^(?:على|في|داخل|ضمن|جوا:?|الى|إلى|عـ?|لـ?)\s*/i, "")
        .trim();
    }

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
      if (zone === "outside") {
        return {
          ok: true,
          found: false,
          reply: "آسفين 🙏 التوصيل متاح **داخل فلسطين فقط**.",
          tags: ["lead_shipping", "out_of_scope", zone]
        };
      }

      if (zone === "gaza") {
        return {
          ok: true,
          found: false,
          reply: "آسفين 🙏 حاليًا **ما في توصيل لقطاع غزة**.",
          tags: ["lead_shipping", "out_of_scope", zone]
        };
      }

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

  // فروع
  if (isBranches) {
    const branches = PROFILE.branches || [];

    if (!branches.length) {
      return {
        ok: true,
        found: false,
        reply: "حاليًا ما عندي بيانات الفروع كاملة. اكتب اسم المدينة وبساعدك فورًا 🙏",
        tags: ["lead_branches"]
      };
    }

    const list = branches.map((b, i) => {
      const mapIcon = `[🗺️](${b.maps})`;
      return `${i + 1}) **${b.name}**\n${b.address}\n${mapIcon} **افتح الخريطة**`;
    });

    return {
      ok: true,
      found: true,
      reply: `**مواقع فروع تصفيات قلقيلية 📍**\n\n${list.join("\n\n")}\n\nاضغط على 🗺️ لفتح Google Maps.`,
      tags: ["lead_branches"]
    };
  }

  if (isPolicyPrivacy) {
    return {
      ok: true,
      found: true,
      reply:
        `أكيد 😊 سياسة الخصوصية موجودة هنا: [اضغط هنا](https://tasfiat-qalqilia.ps/ar/syas-alkhsosy)\n` +
        `إذا بدك أكمل معك بطلبك (منتج/توصيل/تبديل)، احكيلي شو بدك بالضبط.`,
      tags: ["policy_privacy"]
    };
  }

  if (isPolicyUsage) {
    return {
      ok: true,
      found: true,
      reply:
        `أكيد 😊 سياسة الاستخدام موجودة هنا: [اضغط هنا](https://tasfiat-qalqilia.ps/ar/syas-alastkhdam)\n` +
        `إذا بدك أكمل معك بطلبك (منتج/توصيل/تبديل)، احكيلي شو بدك بالضبط.`,
      tags: ["policy_usage"]
    };
  }

  // طلب عام لمنتج
  const genericProductAsk = /بدّي|بدي|عايز|حذاء|كوتشي|جزمة|بوط|صندل|كروكس|شوز/.test(ql);

  if (genericProductAsk && raw.length <= 30) {
    const hasSize = !!extractSizeQuery(ql);
    const hasMoney = /\d+\s*(شيكل|₪)/.test(ql);
    const hasBrandHint = !!brandInfo;
    const hasSectionHint = !!extractSectionHint(ql);
    const hasAudienceHint = !!extractAudienceHint(ql);

    if (!hasSize && !hasMoney && !hasBrandHint && !(hasSectionHint && hasAudienceHint)) {
      return {
        ok: true,
        found: false,
        reply: PROFILE.replies_shami.ask_more_for_products,
        tags: ["lead_product", "needs_clarification"]
      };
    }
  }

  // المقاس فقط
  const askedSize = extractSizeQuery(ql);
  if (askedSize && isOnlySizeQuery(raw)) {
    return {
      ok: true,
      found: false,
      reply: `${pickOpening()} المقاس ${askedSize} بدك **رجالي ولا ستاتي ولا ولادي/بناتي**؟ وكمان بتحب السعر ضمن أي مدى تقريبًا؟`,
      tags: ["lead_product", "needs_clarification", "size_only"]
    };
  }

  // =========================
  // Product Router (قبل fallback)
  // =========================
  if (isProductIntent(raw) || brandInfo) {
    const res = searchKnowledge(raw, {
      brandKey: brandInfo?.brandKey || null,
      brandExact: !!brandInfo?.exact
    });

    if (res.type === "hit" && res.item) {
      return {
        ok: true,
        found: true,
        reply: buildReplyFromItem(res.item),
        tags: ["lead_product", "product_hit", "سلة_التسوق"]
      };
    }

    if (res.type === "clarify") {
      const opts = (res.options || []).slice(0, 3);

      if (convKey && choiceMemory) {
        choiceMemory.set(convKey, { ts: Date.now(), options: opts });
      }

      const lines = [];
      lines.push(`${pickOpening()} لقيت أكثر من خيار، اختر رقم:`);

      opts.forEach((o, i) => {
        const it = getItemBySlug(o.slug) || null;
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

    // none
    return {
      ok: true,
      found: false,
      reply: "تمام 😊 ما قدرت أحدد المنتج بالضبط من الرسالة. اكتب اسم المنتج أو الكود/الرابط وبساعدك فورًا.",
      tags: ["lead_product", "product_none"]
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
