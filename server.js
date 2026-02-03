import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ====== CONFIG ======
const PORT = process.env.PORT || 10000;

const KNOWLEDGE_URL = process.env.KNOWLEDGE_URL || process.env.KNOWLEDGE_V5_URL || "";
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL || "https://app.chatwoot.com";
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || "";
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN || "";

// ====== In-memory guard ضد التكرار ======
const seenMessageIds = new Set();

// ====== Knowledge loading ======
let KNOWLEDGE = null;

async function loadKnowledge() {
  if (!KNOWLEDGE_URL) return { ok: false, reason: "missing KNOWLEDGE_URL" };

  const r = await fetch(KNOWLEDGE_URL);
  if (!r.ok) return { ok: false, reason: `fetch_failed_${r.status}` };

  KNOWLEDGE = await r.json();

  const count = KNOWLEDGE?.count || KNOWLEDGE?.items?.length || 0;
  console.log("✅ Knowledge loaded from:", KNOWLEDGE_URL, "count:", count);

  return { ok: true, count };
}

function normalizeText(s) {
  return String(s || "").trim();
}

function normLower(v) {
  return String(v || "").toLowerCase();
}

function tokenizeArabicSafe(s) {
  // نحذف الرموز، ونحتفظ بالحروف/الأرقام/المسافات/الشرطة
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-]+/gu, " ")
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2);
}

function extractSizeQuery(queryLower) {
  // يلتقط 41 أو 41.5
  const m = queryLower.match(/(^|\s)(\d{2}(?:\.\d)?)(\s|$)/);
  return m ? String(m[2]) : null;
}

function buildReplyFromItem(item) {
  const name = item.name || "—";
  const price = item.price ?? "—";
  const oldPrice = item.old_price ?? "";
  const availability = item.availability || "—";
  const url = item.page_url || item.url || "";

  const priceLine = oldPrice
    ? `السعر: ${price} (كان ${oldPrice})`
    : `السعر: ${price}`;

  const lines = [
    `المنتج: ${name}`,
    priceLine,
    `التوفر: ${availability}`
  ];

  if (url) lines.push(`الرابط: ${url}`);
  return lines.join("\n");
}

/**
 * بحث متعدد الحقول + إدارة غموض
 * returns:
 *  - { type:"hit", item, askedSize }
 *  - { type:"clarify", options:[{slug,name}], askedSize }
 *  - { type:"none", askedSize }
 */
function searchKnowledge(q) {
  if (!KNOWLEDGE?.items?.length) return { type: "none", askedSize: null };

  const raw = normalizeText(q);
  const queryLower = raw.toLowerCase();
  const tokens = tokenizeArabicSafe(raw);
  const askedSize = extractSizeQuery(queryLower);

  // 1) استخراج slug من رابط /product/
  const m = queryLower.match(/\/product\/([a-z0-9\-]+)/i);
  const slugFromUrl = m?.[1] || null;

  if (slugFromUrl) {
    const hit = KNOWLEDGE.items.find(x =>
      normLower(x.product_slug) === slugFromUrl
    );
    if (hit) return { type: "hit", item: hit, askedSize };
  }

  // 2) إذا كتب slug حرفيًا
  const directSlug = KNOWLEDGE.items.find(x => {
    const slug = normLower(x.product_slug);
    return slug && slug === queryLower;
  });
  if (directSlug) return { type: "hit", item: directSlug, askedSize };

  // 3) Scoring Search
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

    // فلترة المقاس: إذا السؤال فيه مقاس، نعطي أولوية للمنتجات التي تحتويه
    if (askedSize && !isPolicyLike) {
      const list = sizes.split(",").map(s => s.trim());
      const ok = list.includes(String(askedSize));
      if (!ok) continue;
    }

    let score = 0;

    // اسم
    if (name === queryLower) score += 80;
    if (name.includes(queryLower) || queryLower.includes(name)) score += 35;

    // slug ضمن النص
    if (slug && queryLower.includes(slug)) score += 60;

    // مطابقة tokens في عدة حقول
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

    // تعزيز للسياسات عند وجود تلميحات
    const policyHints = ["توصيل", "شحن", "تبديل", "استبدال", "إرجاع", "خصوصية", "سياسة", "شروط", "فروع", "موقع"];
    if (isPolicyLike && policyHints.some(h => queryLower.includes(h))) {
      score += 25;
    }

    if (score > 0) scored.push({ item: x, score });
  }

  scored.sort((a, b) => b.score - a.score);

  if (!scored.length) return { type: "none", askedSize };

  const top = scored[0];
  const second = scored[1];

  // عتبة دنيا
  if (top.score < 25) return { type: "none", askedSize };

  // غموض: الثاني قريب جدًا من الأول
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
  // مثل: "41" أو "41.5" فقط
  return /^\d{2}(\.\d)?$/.test(s);
}

function handleQuery(q) {
  const raw = normalizeText(q);
  const ql = raw.toLowerCase();

  const result = searchKnowledge(raw);

  // إذا السؤال فقط مقاس → اسأل توضيح بدل ما نرمي نتيجة عشوائية
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

  // لا تصعيد مباشر — نسأل توضيح أولًا
  return {
    ok: true,
    found: false,
    reply: "أكيد 😊 بس سؤالك لسه عام شوي. احكيلي قصدك: **التوصيل والشحن** ولا **التبديل** ولا **الخصوصية** ولا **الفروع**؟ وإذا الموضوع توصيل، اكتب اسم المدينة.",
    tags: ["توضيح"]
  };
}

async function chatwootCreateMessage(conversationId, content) {
  if (!CHATWOOT_ACCOUNT_ID || !CHATWOOT_API_TOKEN) {
    throw new Error("Missing CHATWOOT_ACCOUNT_ID or CHATWOOT_API_TOKEN");
  }

  const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api_access_token": CHATWOOT_API_TOKEN
    },
    body: JSON.stringify({
      content,
      message_type: "outgoing",
      private: false,
      content_type: "text",
      content_attributes: {}
    })
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Chatwoot message failed ${r.status}: ${t}`);
  }
}

async function chatwootSetLabels(conversationId, labels) {
  if (!CHATWOOT_ACCOUNT_ID || !CHATWOOT_API_TOKEN) return;

  const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/labels`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api_access_token": CHATWOOT_API_TOKEN
    },
    body: JSON.stringify({ labels })
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Chatwoot labels failed ${r.status}: ${t}`);
  }
}

// ====== ROUTES ======
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "tasfiat-qalqilia-brain",
    knowledge_url: KNOWLEDGE_URL || null,
    count: KNOWLEDGE?.count || KNOWLEDGE?.items?.length || 0
  });
});

app.post("/search", async (req, res) => {
  try {
    if (!KNOWLEDGE) await loadKnowledge();
    const q = req.body?.q || req.body?.query || "";
    const out = handleQuery(q);
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "search_failed" });
  }
});

// Webhook من Chatwoot: message_created
app.post("/chatwoot/webhook", async (req, res) => {
  try {
    const body = req.body || {};
    const event = body.event;
    const messageType = body.message_type; // incoming / outgoing
    const messageId = body.id;
    const content = body.content || "";
    const conversationId = body.conversation?.id;

    if (event !== "message_created") return res.json({ ok: true, ignored: "event" });
    if (messageType !== "incoming") return res.json({ ok: true, ignored: "non_incoming" });

    if (!conversationId || !String(content).trim()) {
      return res.json({ ok: true, ignored: "missing_content_or_conversation" });
    }

    if (messageId && seenMessageIds.has(messageId)) {
      return res.json({ ok: true, ignored: "duplicate" });
    }
    if (messageId) {
      seenMessageIds.add(messageId);
      if (seenMessageIds.size > 5000) seenMessageIds.clear();
    }

    if (!KNOWLEDGE) await loadKnowledge();

    const out = handleQuery(content);

    await chatwootCreateMessage(conversationId, out.reply);

    if (Array.isArray(out.tags) && out.tags.length) {
      await chatwootSetLabels(conversationId, out.tags);
    }

    return res.json({ ok: true, replied: true, found: out.found, tags: out.tags });
  } catch (e) {
    console.error(e);
    return res.json({ ok: false, error: "webhook_failed" });
  }
});

app.listen(PORT, async () => {
  const k = await loadKnowledge();
  console.log("Service started on", PORT, "knowledge:", k);
});
