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

// ===== Follow-up Session Memory (NO labels dependency) =====
const lastIncomingAt = new Map(); // convId -> timestamp آخر رسالة واردة من المستخدم
const cartLeadAt = new Map();      // convId -> timestamp آخر "Lead سلة" (بعد product hit/selection)
const followupStats = new Map();   // convId -> { sentCount, lastSentAt }

const FOLLOWUP_RULES = {
  delayMs: 90 * 1000,          // 90 seconds (Chatwoot automation delay)
  maxPerSession: 2,            // مرة/مرتين كحد أقصى
  minGapMs: 15 * 60 * 1000,    // أقل فرق بين رسالتين متابعة (مثلاً 15 دقيقة)
  leadTtlMs: 30 * 60 * 1000,   // صلاحية "lead" للسلة (30 دقيقة)
  silentWindowMs: 90 * 1000    // لازم المستخدم يكون ساكت آخر 90 ثانية
};

function getFollowupStat_(convId) {
  const cur = followupStats.get(convId) || { sentCount: 0, lastSentAt: 0 };
  return cur;
}

function bumpFollowupSent_(convId) {
  const cur = getFollowupStat_(convId);
  cur.sentCount += 1;
  cur.lastSentAt = Date.now();
  followupStats.set(convId, cur);
}

function canSendFollowupNow_(convId) {
  const now = Date.now();

  // لازم يكون في lead سلة حديث
  const leadAt = cartLeadAt.get(convId) || 0;
  if (!leadAt || (now - leadAt) > FOLLOWUP_RULES.leadTtlMs) return { ok: false, why: "no_recent_cart_lead" };

  // لازم المستخدم ما يكون تفاعل آخر 90 ثانية
  const lastIn = lastIncomingAt.get(convId) || 0;
  if (lastIn && (now - lastIn) < FOLLOWUP_RULES.silentWindowMs) return { ok: false, why: "user_recently_active" };

  // حد أقصى مرات
  const st = getFollowupStat_(convId);
  if (st.sentCount >= FOLLOWUP_RULES.maxPerSession) return { ok: false, why: "max_per_session_reached" };

  // مسافة أمان بين المتابعات
  if (st.lastSentAt && (now - st.lastSentAt) < FOLLOWUP_RULES.minGapMs) return { ok: false, why: "min_gap_not_met" };

  return { ok: true };
}

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

    // 2) (بدون Labels) نأخذ snapshot للـ incoming كـ fallback فقط إذا ما عندنا lastIncomingAt
    const before = await chatwootGetMessages(convId, 1);
    const beforeMsgs = Array.isArray(before?.payload) ? before.payload : [];
    const beforeLatestIncoming = beforeMsgs.find(m => m.message_type === "incoming");
    const beforeIncomingId = beforeLatestIncoming?.id || null;

    // 3) انتظر 90 ثانية (الأوتوميشن أصلاً عامل delay، بس نخليه كحماية لو endpoint انضرب فورًا)
    const delayMs = FOLLOWUP_RULES.delayMs;

    const timeoutId = setTimeout(async () => {

  try {
    // ✅ Gate 1: Session-based throttle (NO labels)
    const gate = canSendFollowupNow_(convId);
    if (!gate.ok) {
      console.log("🛑 cart-followup skipped for", convId, "| reason:", gate.why);
      return;
    }

    // ✅ Gate 2: Fallback تحقق إذا المستخدم رد (حتى لو lastIncomingAt مش متوفر)
    const after = await chatwootGetMessages(convId, 20);
    const afterMsgs = Array.isArray(after?.payload) ? after.payload : [];
    const latestIncoming = afterMsgs.find(m => m.message_type === "incoming");
    const latestIncomingId = latestIncoming?.id || null;

    // إذا تغير incoming id خلال فترة الانتظار => المستخدم تفاعل => لا نرسل
    if (latestIncomingId && beforeIncomingId && latestIncomingId !== beforeIncomingId) {
      console.log("🛑 cart-followup skipped (user replied - fallback) for", convId);
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

    // ✅ سجل الإرسال للجلسة (بدون Labels)
    bumpFollowupSent_(convId);
    console.log("✅ cart-followup sent (session-throttled) for", convId);

  } catch (e) {
    console.error("cart-followup job failed:", e);
  } finally {
    // فك القفل دائمًا (نجاح/فشل/return)
    pendingCartFollowups.delete(convId);
  }
}, delayMs);

pendingCartFollowups.set(convId, timeoutId);

    
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
    // ✅ سجل آخر تفاعل للمستخدم (لـ inactivity gate)
    lastIncomingAt.set(String(conversationId), Date.now());

    // ✅ سجل آخر تفاعل للمستخدم (لـ inactivity gate)
    lastIncomingAt.set(String(conversationId), Date.now());

    const out = handleQuery(content, {
      conversationId: String(conversationId),
      choiceMemory
    });
    // ✅ سجل Lead سلة عندما يكون في Product Hit / Selection
    // (يعني صار في نية شراء فعلية)
    const tagsArr = Array.isArray(out?.tags) ? out.tags : [];
    if (tagsArr.includes("سلة_التسوق") || tagsArr.includes("product_hit") || tagsArr.includes("selection_made")) {
      cartLeadAt.set(String(conversationId), Date.now());
    }

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
