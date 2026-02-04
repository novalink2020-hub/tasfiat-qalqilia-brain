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

// ====== ROUTES ======
app.get("/", (req, res) => {
  const K = getKnowledge();
  res.json({
    ok: true,
    service: "tasfiat-qalqilia-brain",
    knowledge_url: CONFIG.KNOWLEDGE_URL || null,
    count: K?.count || K?.items?.length || 0
  });
});

app.post("/search", async (req, res) => {
  try {
    if (!getKnowledge()) await loadKnowledge();
    const q = req.body?.q || req.body?.query || "";
    const out = handleQuery(q, { choiceMemory });
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

    const out = handleQuery(content, { conversationId, choiceMemory });

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

app.listen(CONFIG.PORT, async () => {
  const k = await loadKnowledge();
  console.log("Service started on", CONFIG.PORT, "knowledge:", k);
});
