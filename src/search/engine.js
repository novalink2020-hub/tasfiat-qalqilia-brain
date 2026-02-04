import { getKnowledge } from "../knowledge/loader.js";
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

export function handleQuery(q, ctx = {}) {
  const raw = normalizeText(q);
  const ql = raw.toLowerCase();

  const result = searchKnowledge(raw);

  if (result.askedSize && isOnlySizeQuery(raw)) {
    return {
      ok: true,
      found: false,
      reply: `تمام 😊 المقاس ${result.askedSize} بدك **رجالي ولا نسائي**؟ وكمان بتحب السعر يكون ضمن أي مدى تقريبًا؟`,
      tags: ["توضيح"]
    };
  }

  if (result.type === "hit" && result.item) {
    return {
      ok: true,
      found: true,
      reply: buildReplyFromItem(result.item),
      tags: ["سعر"]
    };
  }

  if (result.type === "clarify") {
    const lines = [];
    lines.push("أكيد 😊 بس حتى أعطيك جواب دقيق، قصدك أي واحد من التالي؟");
    for (const o of result.options || []) {
      if (!o.slug) continue;
      lines.push(`- ${o.name} (اكتب: ${o.slug})`);
    }
    if (ql.includes("توصيل") || ql.includes("شحن")) {
      lines.push("ولو سؤالك عن التوصيل: اكتب اسم المدينة (مثال: جلجولية / الخليل / القدس).");
    }
    return {
      ok: true,
      found: false,
      reply: lines.join("\n"),
      tags: ["توضيح"]
    };
  }

  return {
    ok: true,
    found: false,
    reply: "أكيد 😊 بس سؤالك لسه عام شوي. احكيلي قصدك: **التوصيل والشحن** ولا **التبديل** ولا **الخصوصية** ولا **الفروع**؟ وإذا الموضوع توصيل، اكتب اسم المدينة.",
    tags: ["توضيح"]
  };
}
