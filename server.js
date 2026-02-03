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
  return { ok: true };
}

function normalizeText(s) {
  return String(s || "").trim();
}

function findBySlugOrName(q) {
  if (!KNOWLEDGE?.items?.length) return { type: "none" };

  const raw = normalizeText(q);
  const query = raw.toLowerCase();

  // محاولة استخراج slug من رابط المنتج إن وُجد
  const m = query.match(/\/product\/([a-z0-9\-]+)/i);
  const slugFromUrl = m?.[1] || null;

  // 1) Exact match على product_slug
  if (slugFromUrl) {
    const hit = KNOWLEDGE.items.find(x =>
      String(x.product_slug || "").toLowerCase() === slugFromUrl
    );
    if (hit) return { type: "hit", item: hit };
  }

  // 2) إذا المستخدم كتب slug مباشرة
  const directSlug = KNOWLEDGE.items.find(x =>
    String(x.product_slug || "").toLowerCase() &&
    query === String(x.product_slug || "").toLowerCase()
  );
  if (directSlug) return { type: "hit", item: directSlug };

  // Helpers
  const normField = (v) => String(v || "").toLowerCase();
  const hasAny = (hay, needles) => needles.some(n => n && hay.includes(n));
  const tokens = query
    .replace(/[^\p{L}\p{N}\s\-]+/gu, " ")
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2);

  // كشف سؤال مقاس: رقم مثل 41 أو 41.5
  const sizeMatch = query.match(/(^|\s)(\d{2}(?:\.\d)?)(\s|$)/);
  const askedSize = sizeMatch ? String(sizeMatch[2]) : null;

  // 3) Scored search عبر حقول متعددة
  const scored = [];
  for (const x of KNOWLEDGE.items) {
    const slug = normField(x.product_slug);
    const name = normField(x.name);
    const keywords = normField(x.keywords);
    const tags = normField(x.brand_tags);
    const sizes = normField(x.sizes);

    // فلتر المقاس إن وُجد بالسؤال
    if (askedSize) {
      const sizeOk = sizes.split(",").map(s => s.trim()).includes(askedSize);
      // إذا سأل عن مقاس، أعطي أولوية للعناصر اللي فيها هذا المقاس
      if (!sizeOk) {
        // نترك السياسات والفروع خارج فلتر المقاس
        const isPolicy = slug.startsWith("policy-") || slug.startsWith("info-") || slug.startsWith("branch-");
        if (!isPolicy) continue;
      }
    }

    let score = 0;

    // مطابقة الاسم
    if (name === query) score += 80;
    if (name.includes(query) || query.includes(name)) score += 40;

    // مطابقة slug جزئية
    if (slug && query.includes(slug)) score += 60;

    // مطابقة tokens في keywords / tags / name
    const hayAll = `${name} ${keywords} ${tags} ${sizes} ${slug}`;
    for (const t of tokens) {
      if (!t) continue;
      if (name.includes(t)) score += 8;
      if (keywords.includes(t)) score += 6;
      if (tags.includes(t)) score += 5;
      if (sizes.includes(t)) score += 10; // المقاس مهم
      if (slug.includes(t)) score += 7;
    }

    // تعزيز خاص للسياسات عند ذكر كلمات سياسات
    const policyHints = ["توصيل", "شحن", "تبديل", "استبدال", "إرجاع", "خصوصية", "شروط", "سياسة", "فروع", "موقع"];
    const isPolicy = slug.startsWith("policy-") || slug.startsWith("info-") || slug.startsWith("branch-");
    if (isPolicy && hasAny(query, policyHints)) score += 25;

    if (score > 0) scored.push({ item: x, score });
  }

  scored.sort((a, b) => b.score - a.score);

  if (!scored.length) return { type: "none" };

  // 4) الغموض: إذا أكثر من نتيجة قوية
  const top = scored[0];
  const second = scored[1];

  // Threshold بسيط
  if (top.score < 25) return { type: "none" };

  // إذا الثاني قريب من الأول → اسأل توضيح
  if (second && second.score >= top.score - 5) {
    const options = scored.slice(0, 4).map(s => ({
      slug: s.item.product_slug || "",
      name: s.item.name || ""
    }));
    return { type: "clarify", options, askedSize };
  }

  return { type: "hit", item: top.item, askedSize };
}

  // 2) مطابقة تقريبية على الاسم
  const hit2 = KNOWLEDGE.items.find(x =>
    String(x.name || "").toLowerCase().includes(query) ||
    query.includes(String(x.name || "").toLowerCase())
  );
  if (hit2) return hit2;

  // 3) مطابقة على slug ضمن النص مباشرة
  const hit3 = KNOWLEDGE.items.find(x =>
    String(x.product_slug || "").toLowerCase() &&
    query.includes(String(x.product_slug || "").toLowerCase())
  );
  if (hit3) return hit3;

  return null;
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

function handleQuery(q) {
  const result = findBySlugOrName(q);

  if (result?.type === "hit" && result.item) {
    // إذا سأل عن مقاس فقط بدون تحديد نوع (رجالي/نسائي) نعطيه سؤال توضيحي بدل رد منتج واحد
    if (result.askedSize && String(q).trim().length <= 6) {
      return {
        ok: true,
        found: false,
        reply: `تمام 😊 المقاس ${result.askedSize} بدك **رجالي ولا نسائي**؟ وكمان بتحب السعر يكون ضمن أي مدى تقريبًا؟`,
        tags: ["توضيح"]
      };
    }

    return {
      ok: true,
      found: true,
      reply: buildReplyFromItem(result.item),
      tags: ["سعر"]
    };
  }

  if (result?.type === "clarify") {
    // سؤال توضيحي بدل اختيار عشوائي
    const lines = [];
    lines.push("أكيد 😊 بس حتى أعطيك جواب دقيق، قصدك أي واحد من التالي؟");
    for (const o of result.options || []) {
      if (!o.slug) continue;
      lines.push(`- ${o.name} (اكتب: ${o.slug})`);
    }
    // إذا كان السؤال عن توصيل بدون مدينة
    const ql = normalizeText(q).toLowerCase();
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
    reply: "أكيد 😊 بس سؤالك لسه عام شوي. احكيلي قصدك: **التوصيل والشحن** ولا **التبديل** ولا **الخصوصية**؟ وإذا الموضوع توصيل، اكتب اسم المدينة.",
    tags: ["توضيح"]
  };
}

  return {
    ok: true,
    found: false,
    reply: "لا أملك معلومة مؤكدة عن هذا الطلب من ملف المعرفة الحالي. تم تصنيفه كخارج المعرفة ويحتاج تصعيد لموظف.",
    tags: ["خارج_المعرفة", "تصعيد"]
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

  // ملاحظة: هذا API يكتب/يستبدل قائمة الوسوم للمحادثة. :contentReference[oaicite:6]{index=6}
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

    // نُرجع 200 دائمًا حتى Chatwoot لا يعيد المحاولة بشكل مزعج
    if (event !== "message_created") return res.json({ ok: true, ignored: "event" });

    // مهم: لا ترد على outgoing حتى لا تعمل Loop. :contentReference[oaicite:7]{index=7}
    if (messageType !== "incoming") return res.json({ ok: true, ignored: "non_incoming" });

    if (!conversationId || !String(content).trim()) {
      return res.json({ ok: true, ignored: "missing_content_or_conversation" });
    }

    // منع التكرار
    if (messageId && seenMessageIds.has(messageId)) {
      return res.json({ ok: true, ignored: "duplicate" });
    }
    if (messageId) {
      seenMessageIds.add(messageId);
      if (seenMessageIds.size > 5000) seenMessageIds.clear();
    }

    if (!KNOWLEDGE) await loadKnowledge();

    const out = handleQuery(content);

    // أرسل رد داخل نفس المحادثة عبر Chatwoot API. :contentReference[oaicite:8]{index=8}
    await chatwootCreateMessage(conversationId, out.reply);

    // أضف وسوم حسب نتيجة الـ Brain (سعر / خارج_المعرفة / تصعيد). :contentReference[oaicite:9]{index=9}
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
