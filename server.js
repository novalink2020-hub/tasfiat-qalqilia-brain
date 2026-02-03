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
  if (!KNOWLEDGE?.items?.length) return null;

  const query = normalizeText(q).toLowerCase();

  // محاولة استخراج slug من رابط المنتج إن وُجد
  const m = query.match(/\/product\/([a-z0-9\-]+)/i);
  const slugFromUrl = m?.[1] || null;

  // 1) مطابقة على product_slug إن كانت موجودة
  if (slugFromUrl) {
    const hit = KNOWLEDGE.items.find(x =>
      String(x.product_slug || "").toLowerCase() === slugFromUrl
    );
    if (hit) return hit;
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
  const url = item.url || "";

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
  const item = findBySlugOrName(q);

  if (item) {
    return {
      ok: true,
      found: true,
      reply: buildReplyFromItem(item),
      tags: ["سعر"]
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
