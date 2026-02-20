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
// يمنع جدولة أكثر من متابعة سلة لنفس المحادثة
const pendingCartFollowups = new Map(); // convId -> timeoutId
// ✅ Escalation auto-clear scheduler (60 minutes)
// يمنع جدولة أكثر من إزالة تصعيد لنفس المحادثة
const pendingEscalationAutoClear = new Map(); // convId -> timeoutId
const ESCALATION_CLEAR_MS = 60 * 1000; // 60 minutes
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  console.log("➡️", req.method, req.path);
  next();
});

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
    console.log("🧾 cart-followup payload:", JSON.stringify(req.body || {}, null, 2));
    // 1) نرجع 200 فورًا لChatwoot
    res.json({ ok: true, queued: true });

    const body = req.body || {};
const conversationId =
  body.conversation?.id ||
  body.conversation_id ||
  body.conversationId ||
  body.id || // ✅ Chatwoot Automation payload غالبًا يحط conversationId هنا
  body.messages?.[0]?.conversation_id; // ✅ fallback إضافي
    if (!conversationId) return;
console.log("🧾 cart-followup resolved conversationId:", conversationId);
    
    // مهم: نخليها “بعد عرض منتج” فقط (رسالة صادرة غالبًا)
    // (إذا بدك تشدد أكثر: اشترط وجود label سلة_التسوق بالpayload لو متوفر)
    const convId = String(conversationId);
    // لو في متابعة مجدولة لنفس المحادثة: تجاهل الطلب
if (pendingCartFollowups.has(convId)) {
  console.log("🛑 cart-followup ignored (already scheduled) for", convId);
  return;
}

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
const timeoutId = setTimeout(async () => {
  try {
    // (إعادة تحقق) لو الوسم موجود خلال الـ 90 ثانية: لا ترسل
    const convLatest = await chatwootGetConversation(convId);
    const labelsNow = Array.isArray(convLatest?.labels) ? convLatest.labels : [];
    if (labelsNow.includes("متابعة_السلة_تمت")) {
      console.log("✅ cart-followup canceled (already labeled) for", convId);
      return;
    }

    // (اختياري قوي) لو ما عاد في سلة_التسوق: لا ترسل
    if (!labelsNow.includes("سلة_التسوق")) {
      console.log("🛑 cart-followup canceled (no cart label) for", convId);
      return;
    }

    // افحص إذا المستخدم رد خلال الانتظار (آخر incoming تغيّر)
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
    // فك القفل دائمًا (نجاح/فشل/return)
    pendingCartFollowups.delete(convId);
  }
}, delayMs);

pendingCartFollowups.set(convId, timeoutId);


pendingCartFollowups.set(convId, timeoutId);
    
  } catch (e) {
    console.error(e);
    // (مهم) حتى لو صار خطأ قبل res، رجّع شيء
    try { res.json({ ok: false, error: "cart_followup_failed" }); } catch {}
  }
});
app.post("/chatwoot/escalation-auto-clear", async (req, res) => {
  try {
    console.log("🧯 escalation-auto-clear payload:", JSON.stringify(req.body || {}, null, 2));

    // 1) رد فوري لChatwoot (ACK)
    res.json({ ok: true, queued: true });

    const body = req.body || {};
    const conversationId =
      body.conversation?.id ||
      body.conversation_id ||
      body.conversationId ||
      body.id || // أحياناً automation يحط conversation id هنا
      body.messages?.[0]?.conversation_id;

    if (!conversationId) return;

    const convId = String(conversationId);

    // لو في مهمة إزالة مجدولة لنفس المحادثة: تجاهل
    if (pendingEscalationAutoClear.has(convId)) {
      console.log("🛑 escalation-auto-clear ignored (already scheduled) for", convId);
      return;
    }

    // 2) جدولة بعد 60 دقيقة
    const timeoutId = setTimeout(async () => {
      try {
        const conv = await chatwootGetConversation(convId);
        const labelsNow = Array.isArray(conv?.labels) ? conv.labels : [];

        if (!labelsNow.includes("تصعيد")) {
          console.log("✅ escalation-auto-clear: no escalation label anymore for", convId);
          return;
        }

        // حذف "تصعيد" مع الحفاظ على باقي الوسوم
        const nextLabels = labelsNow.filter(l => l !== "تصعيد");
        await chatwootSetLabels(convId, nextLabels);

        console.log("✅ escalation-auto-clear: removed 'تصعيد' for", convId);
      } catch (e) {
        console.error("escalation-auto-clear job failed:", e);
      } finally {
        pendingEscalationAutoClear.delete(convId);
      }
    }, ESCALATION_CLEAR_MS);

    pendingEscalationAutoClear.set(convId, timeoutId);
    console.log("⏳ escalation-auto-clear scheduled for", convId, "in 60 minutes");
  } catch (e) {
    console.error(e);
    try { res.json({ ok: false, error: "escalation_auto_clear_failed" }); } catch {}
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
    // ✅ Human takeover: إذا المحادثة عليها تصعيد، لا ترد مؤتمتًا
try {
  const conv = await chatwootGetConversation(String(conversationId));
  const labelsNow = Array.isArray(conv?.labels) ? conv.labels : [];
  if (labelsNow.includes("تصعيد")) {
    return res.json({ ok: true, ignored: "human_takeover" });
  }
} catch (e) {
  console.error("⚠️ chatwootGetConversation failed (takeover check):", e?.message || e);
}

    // مهم: للذاكرة داخل engine لازم conversationId يكون String
    const out = handleQuery(content, {
      conversationId: String(conversationId),
      choiceMemory
    });

    // أرسل الرد داخل نفس المحادثة
    const labels = mapToChatwootLabels(out.tags || []);
if (labels.length) {
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
