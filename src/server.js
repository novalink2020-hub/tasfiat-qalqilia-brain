import express from "express";
import cors from "cors";

import { CONFIG } from "./config.js";
import { seenMessageIds, choiceMemory } from "./state/memoryStore.js";
import { loadKnowledge, getKnowledge } from "./knowledge/loader.js";
import { handleQuery } from "./search/engine.js";
import {
  chatwootCreateMessage,
  chatwootSetLabels,
  chatwootGetConversation,
  chatwootGetMessages
} from "./chatwoot/client.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  console.log("➡️", req.method, req.path);
  next();
});

// يمنع جدولة أكثر من متابعة سلة لنفس المحادثة
const pendingCartFollowups = new Map(); // convId -> timeoutId

// ===== Helpers =====
function mapToChatwootLabels(tags = []) {
  const t = new Set(Array.isArray(tags) ? tags : []);
  const labels = new Set();

  if (t.has("سلة_التسوق")) labels.add("سلة_التسوق");

  if (
    t.has("نتيجة") ||
    t.has("اختيار") ||
    t.has("lead_product") ||
    t.has("selection_made") ||
    t.has("price_inquiry")
  ) {
    labels.add("سعر");
  }

  if (t.has("خارج_المعرفة")) labels.add("خارج_المعرفة");
  if (t.has("تصعيد")) labels.add("تصعيد");

  return Array.from(labels);
}

function resolveConversationIdFromPayload(body) {
  return (
    body?.conversation?.id ||
    body?.conversation_id ||
    body?.conversationId ||
    body?.id || // بعض automations تضع conversationId هنا
    body?.messages?.[0]?.conversation_id ||
    null
  );
}

async function hasLabel(convId, label) {
  const conv = await chatwootGetConversation(String(convId));
  const labels = Array.isArray(conv?.labels) ? conv.labels : [];
  return labels.includes(label);
}

// ===== ROUTES =====
app.get("/", (req, res) => {
  const K = getKnowledge();
  res.json({
    ok: true,
    service: "tasfiat-qalqilia-brain",
    build_id: "refactor-modules-src-server-clean-001",
    knowledge_url: CONFIG.KNOWLEDGE_URL || null,
    count: K?.count || K?.items?.length || 0
  });
});
app.get("/debug/knowledge-stats", (req, res) => {
  const K = getKnowledge();
  const items = Array.isArray(K?.items) ? K.items : [];

  const bySection = {};
  const byAudience = {};
  const byBrand = {};

  for (const x of items) {
    const s = String(x.section || "بدون_section").trim();
    const a = String(x.audience || "بدون_audience").trim();
    const b = String(x.brand_std || "بدون_brand").trim();

    bySection[s] = (bySection[s] || 0) + 1;
    byAudience[a] = (byAudience[a] || 0) + 1;
    byBrand[b] = (byBrand[b] || 0) + 1;
  }

  // top 15 brands
  const topBrands = Object.entries(byBrand)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  res.json({
    ok: true,
    count: items.length,
    bySection,
    byAudience,
    topBrands
  });
});
app.post("/search", async (req, res) => {
  try {
    if (!getKnowledge()) await loadKnowledge();
    const q = req.body?.q || req.body?.query || "";
    const out = handleQuery(q, { conversationId: "api-test", choiceMemory });
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "search_failed" });
  }
});

// متابعة سلة (90 ثانية بعد عدم التفاعل)
app.post("/chatwoot/cart-followup", async (req, res) => {
  try {
    console.log("🧾 cart-followup payload:", JSON.stringify(req.body || {}, null, 2));
    res.json({ ok: true, queued: true });

    const convIdRaw = resolveConversationIdFromPayload(req.body || {});
    if (!convIdRaw) return;

    const convId = String(convIdRaw);
    console.log("🧾 cart-followup resolved conversationId:", convId);

    if (pendingCartFollowups.has(convId)) {
      console.log("🛑 cart-followup ignored (already scheduled) for", convId);
      return;
    }

    // إذا تمت متابعة السلة سابقًا في نفس المحادثة: لا تعيد
    const conv = await chatwootGetConversation(convId);
    const existingLabels = Array.isArray(conv?.labels) ? conv.labels : [];
    if (existingLabels.includes("متابعة_السلة_تمت")) return;

    // نقطة مرجعية: آخر incoming الآن
    const before = await chatwootGetMessages(convId, 1);
    const beforeMsgs = Array.isArray(before?.payload) ? before.payload : [];
    const beforeLatestIncoming = beforeMsgs.find(m => m.message_type === "incoming");
    const beforeIncomingId = beforeLatestIncoming?.id || null;

    const delayMs = 90 * 1000;

    const timeoutId = setTimeout(async () => {
      try {
        const convLatest = await chatwootGetConversation(convId);
        const labelsNow = Array.isArray(convLatest?.labels) ? convLatest.labels : [];

        // لو الوسم موجود: لا ترسل
        if (labelsNow.includes("متابعة_السلة_تمت")) {
          console.log("✅ cart-followup canceled (already labeled) for", convId);
          return;
        }

        // لازم تكون سلة_التسوق موجودة
        if (!labelsNow.includes("سلة_التسوق")) {
          console.log("🛑 cart-followup canceled (no cart label) for", convId);
          return;
        }

        // إذا المستخدم رد خلال الانتظار: لا ترسل
        const after = await chatwootGetMessages(convId, 20);
        const afterMsgs = Array.isArray(after?.payload) ? after.payload : [];
        const latestIncoming = afterMsgs.find(m => m.message_type === "incoming");
        const latestIncomingId = latestIncoming?.id || null;

        if (latestIncomingId && beforeIncomingId && latestIncomingId !== beforeIncomingId) {
          console.log("🛑 cart-followup skipped (user replied) for", convId);
          return;
        }

        const followup =
`جاهز نكمّل طلبك؟ 🧾✨

1) افتح المنتج واضغط **أضف إلى السلة** 🧺
2) إذا حاب تضيف قطع تانية، خُذ راحتك بالتسوّق… وبعدين اضغط **شراء** 🛒
3) عبّي بياناتك واضغط **التالي** بعدها **إتمام الشراء** ✅

لو عندك **كود خصم**؟ اكتبه واضغط **تطبيق** 🎟️
إذا واجهتك أي مشكلة بالخطوات: اكتب **بدي دعم** وبنساعدك فورًا 🤝
`;

        await chatwootCreateMessage(convId, followup);

        // دمج الوسوم بدل الاستبدال
        const conv2 = await chatwootGetConversation(convId);
        const existing = Array.isArray(conv2?.labels) ? conv2.labels : [];
        const merged = Array.from(new Set([...existing, "متابعة_السلة_تمت"]));
        await chatwootSetLabels(convId, merged);

        console.log("✅ cart-followup sent & labeled for", convId);
      } catch (e) {
        console.error("cart-followup job failed:", e);
      } finally {
        pendingCartFollowups.delete(convId);
      }
    }, delayMs);

    pendingCartFollowups.set(convId, timeoutId);
  } catch (e) {
    console.error(e);
    try { res.json({ ok: false, error: "cart_followup_failed" }); } catch {}
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

    // منع التكرار
    if (messageId && seenMessageIds.has(messageId)) {
      return res.json({ ok: true, ignored: "duplicate" });
    }
    if (messageId) {
      seenMessageIds.add(messageId);
      if (seenMessageIds.size > 5000) seenMessageIds.clear();
    }

    // ✅ Human takeover: إذا عليها تصعيد، لا ترد
    try {
      const isEscalated = await hasLabel(conversationId, "تصعيد");
      if (isEscalated) {
        return res.json({ ok: true, ignored: "human_takeover" });
      }
    } catch (e) {
      console.error("⚠️ takeover label check failed:", e?.message || e);
    }

    if (!getKnowledge()) await loadKnowledge();

    const out = handleQuery(content, {
      conversationId: String(conversationId),
      choiceMemory
    });

    const labels = mapToChatwootLabels(out.tags || []);
    if (labels.length) {
      // ملاحظة: هذا يستبدل labels. إذا بدك merge لاحقًا نعمله بتعديل صغير.
      await chatwootSetLabels(conversationId, labels);
    }

    await chatwootCreateMessage(conversationId, out.reply);

    return res.json({ ok: true, replied: true, found: out.found, tags: out.tags, labels });
  } catch (e) {
    console.error(e);
    return res.json({ ok: false, error: "webhook_failed" });
  }
});

app.listen(CONFIG.PORT, async () => {
  const k = await loadKnowledge();
  console.log("Service started on", CONFIG.PORT, "knowledge:", k);
});
