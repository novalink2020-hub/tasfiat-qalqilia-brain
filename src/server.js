import express from "express";
import cors from "cors";

import { CONFIG } from "./config.js";
import { seenMessageIds, choiceMemory } from "./state/memoryStore.js";
import { loadKnowledge, getKnowledge } from "./knowledge/loader.js";
import { handleQuery } from "./search/engine.js";
import { chatwootCreateMessage, chatwootSetLabels } from "./chatwoot/client.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ===== Helpers =====
function mapToChatwootLabels(tags = []) {
  const t = new Set(Array.isArray(tags) ? tags : []);
  const labels = new Set();

  // سلة التسوق (بعد عرض منتج واحد أو اختيار من القائمة)
  if (t.has("سلة_التسوق")) labels.add("سلة_التسوق");

  // منتجات/سعر
  if (
    t.has("نتيجة") ||
    t.has("اختيار") ||
    t.has("lead_product") ||
    t.has("selection_made") ||
    t.has("price_inquiry")
  ) {
    labels.add("سعر");
  }

  // خارج المعرفة
  if (t.has("خارج_المعرفة")) labels.add("خارج_المعرفة");

  // تصعيد
  if (t.has("تصعيد")) labels.add("تصعيد");

  return Array.from(labels);
}

// ===== ROUTES =====
app.get("/", (req, res) => {
  const K = getKnowledge();
  res.json({
    ok: true,
    service: "tasfiat-qalqilia-brain",
    build_id: "refactor-modules-src-server-001",
    knowledge_url: CONFIG.KNOWLEDGE_URL || null,
    count: K?.count || K?.items?.length || 0
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

app.post("/chatwoot/cart-followup", async (req, res) => {
  try {
    // 1) نرجع 200 فورًا لChatwoot
    res.json({ ok: true, queued: true });

    const body = req.body || {};
    const conversationId = body.conversation?.id || body.conversation_id || body.conversationId;
    if (!conversationId) return;

    // مهم: نخليها “بعد عرض منتج” فقط (رسالة صادرة غالبًا)
    // (إذا بدك تشدد أكثر: اشترط وجود label سلة_التسوق بالpayload لو متوفر)
    const convId = String(conversationId);

    // 2) تحقق من labels الحالية: إذا متابعة_السلة_تمت موجودة، لا تعيد
    const conv = await chatwootGetConversation(convId);
    const existingLabels = Array.isArray(conv?.labels) ? conv.labels : [];
    if (existingLabels.includes("متابعة_السلة_تمت")) return;

    // 3) سجل نقطة البداية: آخر رسالة الآن (لنعرف هل صار رد بعدين)
    const before = await chatwootGetMessages(convId, 1);
    const beforeMsgs = Array.isArray(before?.payload) ? before.payload : [];
    const beforeLatestIncoming = beforeMsgs.find(m => m.message_type === "incoming");
    const beforeIncomingId = beforeLatestIncoming?.id || null;

    // 4) انتظر 90 ثانية
    const delayMs = 90 * 1000;
    setTimeout(async () => {
      try {
        // 5) بعد الانتظار: افحص إذا المستخدم رد
        const after = await chatwootGetMessages(convId, 1);
        const afterMsgs = Array.isArray(after?.payload) ? after.payload : [];

        const latestIncoming = afterMsgs.find(m => m.message_type === "incoming");
        const latestIncomingId = latestIncoming?.id || null;

        // إذا تغيّر آخر incoming => المستخدم رد => لا متابعة
        if (latestIncomingId && beforeIncomingId && latestIncomingId !== beforeIncomingId) {
          return;
        }

        // 6) أرسل رسالة متابعة (CTA واضح)
        const followup =
`جاهز أكملك الطلب؟ 🧾✨

1) افتح المنتج واضغط **أضف إلى السلة**
2) كمّل بياناتك: الاسم + الهاتف + المدينة + العنوان
3) اختر الشحن واضغط **التالي** ثم **إتمام الشراء**

إذا بتحب أحسبلك **الإجمالي مع الشحن** بسرعة، اكتب اسم مدينتك 👇`;

        await chatwootCreateMessage(convId, followup);

        // 7) ضع وسم “متابعة_السلة_تمت” لمنع التكرار
        await chatwootSetLabels(convId, ["متابعة_السلة_تمت"]);
      } catch (e) {
        console.error("cart-followup job failed:", e);
      }
    }, delayMs);

  } catch (e) {
    console.error(e);
    // (مهم) حتى لو صار خطأ قبل res، رجّع شيء
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

    // نُرجع 200 دائمًا حتى Chatwoot لا يعيد المحاولة بشكل مزعج
    if (event !== "message_created") return res.json({ ok: true, ignored: "event" });

    // مهم: لا ترد على outgoing حتى لا تعمل Loop
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

    if (!getKnowledge()) await loadKnowledge();

    // مهم: للذاكرة داخل engine لازم conversationId يكون String
    const out = handleQuery(content, {
      conversationId: String(conversationId),
      choiceMemory
    });

    // أرسل الرد داخل نفس المحادثة
    await chatwootCreateMessage(conversationId, out.reply);

    // أضف وسوم حسب نتيجة الدماغ (لكن بصيغة وسوم Chatwoot العربية)
    const labels = mapToChatwootLabels(out.tags || []);
    if (labels.length) {
      await chatwootSetLabels(conversationId, labels);
    }

    return res.json({ ok: true, replied: true, found: out.found, tags: out.tags, labels });
  } catch (e) {
    console.error(e);
    return res.json({ ok: false, error: "webhook_failed" });
  }
});

import { chatwootGetConversation, chatwootGetMessages } from "./chatwoot/client.js";

app.listen(CONFIG.PORT, async () => {
  const k = await loadKnowledge();
  console.log("Service started on", CONFIG.PORT, "knowledge:", k);
});
