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
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "") // tashkeel
    .replace(/[إأآٱ]/g, "ا") // alef
    .replace(/ى/g, "ي") // yaa/maqsura
    .replace(/ة/g, "ه") // ta marbuta -> ha
    .replace(/ـ/g, "") // tatweel
    .replace(/(.)\1{2,}/g, "$1$1") // repeated letters
    .trim();
}

function extractMoneyQuery(queryLower) {
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

// =========================
// Brand dictionary (your schema: brand_std + aliases)
// =========================
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
    .map(b => {
      const brandStd = String(b?.brand_std || "").trim();
      if (!brandStd) return null;

      const baseAliases = []
        .concat([brandStd, b?.en, b?.ar])
        .concat(Array.isArray(b?.aliases) ? b.aliases : [])
        .concat(Array.isArray(b?.normalize_from_knowledge_brand_std) ? b.normalize_from_knowledge_brand_std : [])
        .filter(Boolean)
        .map(x => String(x).trim())
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
  if (detectBrandInfo(rawText)) return true;

  if (/(حذاء|جزمه|جزمة|كوتشي|بوط|صندل|شبشب|طقم|تيشيرت|بنطال|جاكيت|بلوزه|بلوزة|شنطه|شنطة|عطر|برفان|كرة قدم|مدارس|جري|مشي|تدريب|مقاس|نمره|نمرة|قياس|ولادي|بناتي|رجالي|نسائي|ستاتي)/.test(q)) {
    return true;
  }

  const t = q.trim();
  if (t.split(/\s+/).length === 1 && t.length >= 3 && t.length <= 10) return true;

  return false;
}

function pickOpening() {
  const arr = ["تمام 😊", "ولا يهمك 😊", "حاضر 👌", "يسعدني 😊", "على راسي 😊"];
  return arr[Math.floor(Math.random() * arr.length)];
}

// ====== Shipping helpers ======
let FOREIGN_CACHE = null;

function loadForeignPlacesOnce() {
  if (FOREIGN_CACHE) return FOREIGN_CACHE;
  const p = path.resolve("src/text/foreign_places.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const arr = Array.isArray(raw?.places) ? raw.places : [];
  FOREIGN_CACHE = arr.map(x => normalizeForMatch(x)).filter(Boolean);
  return FOREIGN_CACHE;
}

function isForeignPlace(text) {
  const q = normalizeForMatch(text);
  if (!q) return false;
  const list = loadForeignPlacesOnce();
  return list.some(k => k && (q.includes(k) || k.includes(q)));
}

function extractCityFromText(textLower) {
  const clean = String(textLower || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[^\p{L}\p{N}\s\-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const m = clean.match(/(?:على|الى|إلى)\s+(.+)$/);
  if (m?.[1]) return m[1].trim();

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

// ====== Knowledge search ======
function isUsableProductItem(x) {
  const hasName = String(x?.name || "").trim().length >= 2;
  const hasUrl = String(x?.page_url || "").trim().startsWith("http");
  const hasSlug = String(x?.product_slug || "").trim().length >= 2;
  return hasName && hasUrl && hasSlug;
}

function searchKnowledge(q, opts = {}) {
  const KNOWLEDGE = getKnowledge();
  if (!KNOWLEDGE?.items?.length) return { type: "none", askedSize: null };

  const queryLower = normalizeForMatch(q);
  const tokens = tokenize(q);

  const rawSlug = String(q || "").trim().toLowerCase();
  const looksLikeSlug = /^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(rawSlug);
  const askedSize = looksLikeSlug ? null : extractSizeQuery(queryLower);

  const brandKey = opts?.brandKey ? String(opts.brandKey) : null;
  const brandExact = !!opts?.brandExact;

  // URL -> slug
  const m = String(q || "").match(/\/product\/([a-z0-9\-]+)/i);
  const slugFromUrl = m?.[1] || null;

  if (slugFromUrl) {
    const hit = KNOWLEDGE.items.find(x => normLower(x.product_slug) === slugFromUrl);
    if (hit && isUsableProductItem(hit)) return { type: "hit", item: hit, askedSize };
    if (hit) return { type: "none", askedSize };
  }

  // exact slug
  const directSlug = KNOWLEDGE.items.find(x => {
    const slug = normLower(x.product_slug);
    return slug && (slug === rawSlug || slug === queryLower);
  });
  if (directSlug && isUsableProductItem(directSlug)) return { type: "hit", item: directSlug, askedSize };
  if (directSlug) return { type: "none", askedSize };

  const scored = [];

  for (const x of KNOWLEDGE.items) {
    const hasName = String(x?.name || "").trim().length >= 2;
    const hasUrl = String(x?.page_url || "").trim().startsWith("http");
    const hasSlug = String(x?.product_slug || "").trim().length >= 2;
    if (!hasSlug || !hasUrl || !hasName) continue;

    const slug = normLower(x.product_slug);
    const name = normLower(x.name);
    const keywords = normLower(x.keywords);
    const tags = normLower(x.brand_tags);

    const brandStdRaw = String(x?.brand_std || "");
    const itemBrandKey = normKey(brandStdRaw);

    // فلترة صارمة إذا الماركة واضحة من القاموس
    if (brandKey && itemBrandKey && itemBrandKey !== brandKey) continue;

    const gender = normLower(x.gender);
    const gender2 = normLower(x.gender_2);
    const ageGroup = normLower(x.age_group);

    const sizes = normLower(x.sizes);

    const availability = normLower(x.availability);
    const price = Number(x.price || 0);
    const hasDiscount = !!x.has_discount;
    const discountPercent = Number(x.discount_percent || 0);

    const isPolicyLike =
      slug.startsWith("policy-") ||
      slug.startsWith("info-") ||
      slug.startsWith("branch-") ||
      tags.includes("سياسات") ||
      tags.includes("فروع");

    if (askedSize && !isPolicyLike) {
      const list = sizes.split(",").map(s => s.trim());
      if (!list.includes(String(askedSize))) continue;
    }

    const moneyQ = extractMoneyQuery(queryLower);
    const genderHint = extractGenderHint(queryLower);
    const wantsDiscount = extractDiscountHint(queryLower);

    let score = 0;

    // لو تم فلترة بالماركة: أعطي كل عناصر الماركة base score حتى ما يطلع "none"
    if (brandKey && itemBrandKey === brandKey) score += 8;

    if (name === queryLower) score += 80;
    if (slug && queryLower === slug) score += 90;
    if (slug && /[a-z]+\d+/i.test(queryLower) && slug.includes(queryLower)) score += 70;

    // brand boost (normalized)
    if (brandKey && itemBrandKey === brandKey) score += 60;

    // gender / audience
    if (genderHint) {
      if ((gender.includes("رجال") || gender.includes("male")) && genderHint === "male") score += 25;
      if ((gender.includes("نساء") || gender.includes("female")) && genderHint === "female") score += 25;
      if ((gender.includes("ولادي") || gender.includes("kids")) && (genderHint === "kids_male" || genderHint === "kids_female")) score += 18;
      if (gender.includes("بناتي") && genderHint === "kids_female") score += 22;
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

    if (name.includes(queryLower) || queryLower.includes(name)) score += 35;
    if (slug && queryLower.includes(slug)) score += 60;

    const hay = `${name} ${keywords} ${tags} ${brandStdRaw} ${gender} ${gender2} ${ageGroup} ${sizes} ${availability} ${slug}`;
    for (const t of tokens) {
      if (!t) continue;
      if (name.includes(t)) score += 10;

      const isBrandishQuery = (tokens.length === 1 && queryLower.length <= 6);
      if (keywords.includes(t)) score += (isBrandishQuery ? 22 : 8);
      if (tags.includes(t)) score += 7;
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

  // ماركة فقط (exact) => اعرض أفضل 3 دائمًا
  if (brandKey && brandExact) {
    const options = scored.slice(0, 3).map(s => ({
      slug: s.item.product_slug || "",
      name: s.item.name || ""
    }));
    return { type: "clarify", options, askedSize };
  }

  const top = scored[0];
  const second = scored[1];

  // لو فلترنا بالماركة: لا تشدد minScore كثير (لأن الفلترة نفسها قوية)
  const isBrandFiltered = !!brandKey;
  const isBrandishQueryFinal = (tokens.length === 1 && queryLower.length <= 6);

  const minScore = isBrandFiltered ? 6 : (isBrandishQueryFinal ? 12 : 25);
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

export function handleQuery(q, ctx = {}) {
  const raw = normalizeText(q);
  const ql = raw.toLowerCase();

  const brandInfo = detectBrandInfo(raw); // {brandStd, brandKey, exact} أو null

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

  // اختيار رقم من قائمة
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

  // Intent بسيط
  const isShipping = /توصيل|شحن/.test(ql);
  const isReturn = /إرجاع|ارجاع|ترجيع|استرجاع/.test(ql);
  const isExchange = /تبديل|استبدال/.test(ql);
  const isBranches = /فرع|فروع|موقع|وين/.test(ql);

  // إرجاع/تبديل
  if (isReturn || isExchange) {
    return {
      ok: true,
      found: true,
      reply: PROFILE.replies_shami.policy_return_exchange,
      tags: ["policy_exchange"]
    };
  }

  // توصيل
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
    return {
      ok: true,
      found: false,
      reply: "تمام 😊 بتقصد **موقع الفروع** ولا **موقع المقر**؟ احكيلي شو بدك بالزبط.",
      tags: ["lead_branches", "needs_clarification"]
    };
  }

  // طلب عام لمنتج
  const genericProductAsk = /بدّي|بدي|عايز|حذاء|كوتشي|جزمة|بوط|صندل|كروكس|شوز/.test(ql);

  if (genericProductAsk && raw.length <= 30) {
    const hasSize = !!extractSizeQuery(ql);
    const hasMoney = /\d+\s*(شيكل|₪)/.test(ql);

    // وجود ماركة عبر القاموس يغني عن regex قديمة
    const hasBrandHint = !!brandInfo;

    if (!hasSize && !hasMoney && !hasBrandHint) {
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
      reply: `${pickOpening()} المقاس ${askedSize} بدك **رجالي ولا نسائي**؟ وكمان بتحب السعر ضمن أي مدى تقريبًا؟`,
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
      return { ok: true, found: true, reply: buildReplyFromItem(res.item), tags: ['lead_product','product_hit'] };
    }

    if (res.type === "clarify") {
      const opts = (res.options || []).slice(0, 3);

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

      return { ok: true, found: false, reply: lines.join("\n"), tags: ["lead_product", "needs_clarification", "has_choices"] };
    }

    // none
    return {
      ok: true,
      found: false,
      reply: "تمام 😊 ما قدرت أحدد المنتج بالضبط من الرسالة. اكتب اسم المنتج أو الكود/الرابط وبساعدك فورًا.",
      tags: ['lead_product','product_none']
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
