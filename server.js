import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
const KNOWLEDGE_URL = process.env.KNOWLEDGE_URL || "";

// Cache بسيط لتقليل الضغط على GitHub raw
let cache = { ts: 0, data: null };
const CACHE_MS = 60 * 1000;

async function loadKnowledge() {
  if (!KNOWLEDGE_URL) return { ok: false, error: "KNOWLEDGE_URL is missing" };

  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_MS) return { ok: true, data: cache.data };

  const res = await fetch(KNOWLEDGE_URL, { headers: { "accept": "application/json" } });
  if (!res.ok) return { ok: false, error: `Failed to fetch knowledge: ${res.status}` };

  const json = await res.json();
  cache = { ts: now, data: json };
  return { ok: true, data: json };
}

function normalize(s) {
  return String(s || "").toLowerCase().trim();
}

function findProduct(items, q) {
  const nq = normalize(q);
  if (!nq) return null;

  // match by slug exact/contains
  let hit =
    items.find(x => normalize(x.product_slug) === nq) ||
    items.find(x => normalize(x.product_slug).includes(nq));

  if (hit) return hit;

  // match by name contains
  hit = items.find(x => normalize(x.name).includes(nq));
  return hit || null;
}

// Health: يتأكد أن المعرفة تُقرأ
app.get("/health", async (_req, res) => {
  const k = await loadKnowledge();
  if (!k.ok) return res.status(500).json({ ok: false, error: k.error });

  const count = k.data?.count ?? (Array.isArray(k.data?.items) ? k.data.items.length : null);
  return res.json({
    ok: true,
    knowledge_url: KNOWLEDGE_URL,
    count
  });
});

// Search: اختبار عملي للديمو (بدون Gemini وبدون هلوسة)
app.post("/search", async (req, res) => {
  const q = req.body?.q || "";
  const k = await loadKnowledge();
  if (!k.ok) return res.status(500).json({ ok: false, error: k.error });

  const items = Array.isArray(k.data?.items) ? k.data.items : [];
  const hit = findProduct(items, q);

  if (!hit) {
    return res.json({
      ok: true,
      found: false,
      reply: "لا أملك معلومة مؤكدة عن هذا الطلب من ملف المعرفة الحالي. تم تصنيفه كخارج المعرفة ويحتاج تصعيد لموظف.",
      tags: ["خارج_المعرفة", "تصعيد"]
    });
  }

  // رد knowledge-only من بيانات المنتج
  const price = hit.price ? `${hit.price}` : "غير متوفر";
  const oldPrice = hit.old_price ? `${hit.old_price}` : null;
  const availability = hit.availability ? `${hit.availability}` : "غير محدد";
  const url = hit.page_url ? `${hit.page_url}` : null;

  const parts = [];
  parts.push(`المنتج: ${hit.name || hit.product_slug || "—"}`);
  parts.push(`السعر: ${price}${oldPrice ? ` (كان ${oldPrice})` : ""}`);
  parts.push(`التوفر: ${availability}`);
  if (url) parts.push(`الرابط: ${url}`);

  return res.json({
    ok: true,
    found: true,
    reply: parts.join("\n"),
    tags: ["سعر"]
  });
});

app.listen(PORT, () => {
  console.log(`✅ Brain minimal running on port ${PORT}`);
  console.log(`🔗 KNOWLEDGE_URL: ${KNOWLEDGE_URL || "(missing)"}`);
});
