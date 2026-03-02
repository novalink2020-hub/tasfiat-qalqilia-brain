// test/knowledge.guard.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const KNOWLEDGE_URL =
  "https://raw.githubusercontent.com/novalink2020-hub/tasfiat-qalqilia/refs/heads/main/tasfiat_knowledge.cleaned.json";

// =========================
// Helpers
// =========================
async function fetchText(url, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
    });
    assert.equal(res.ok, true, `Fetch failed: ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url, ms = 15000) {
  const txt = await fetchText(url, ms);
  try {
    return JSON.parse(txt);
  } catch (e) {
    throw new Error("Knowledge JSON parse failed: " + String(e?.message || e));
  }
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function isHttpUrl(u) {
  const s = String(u || "").trim();
  return s.startsWith("http://") || s.startsWith("https://");
}

function hasAnyDigit(s) {
  return /[0-9٠-٩۰-۹]/.test(String(s || ""));
}

function parseAnyNums(s) {
  const t = String(s || "");
  const ms = Array.from(t.matchAll(/(\d{1,3}(?:\.\d)?)/g));
  return ms.map((m) => Number(m[1])).filter((n) => Number.isFinite(n));
}

function normalizeBrandKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// =========================
// Global cache (download once)
// =========================
let RAW = null;
let K = null;

test("knowledge: download from GitHub raw + parse JSON", async () => {
  RAW = await fetchText(KNOWLEDGE_URL);
  assert.ok(RAW.length > 1000, "Knowledge file looks too small");

  K = JSON.parse(RAW);
  assert.equal(typeof K, "object");
  assert.ok(Array.isArray(K.items), "Missing items[]");
  assert.equal(typeof K.count, "number");
  assert.equal(K.count, K.items.length, "count != items.length");
});

test("knowledge: top-level keys sanity", async () => {
  if (!K) K = await fetchJson(KNOWLEDGE_URL);

  // مفاتيح متوقعة (بدون تشدد مفرط)
  for (const key of ["count", "items"]) {
    assert.ok(key in K, `Missing top-level key: ${key}`);
  }

  assert.ok(K.items.length >= 200, `Too few items: ${K.items.length}`);
});

test("knowledge: stable schema presence on each item", async () => {
  if (!K) K = await fetchJson(KNOWLEDGE_URL);

  const required = [
    "name",
    "price",
    "availability",
    "page_url",
    "product_slug",
    "section",
    "audience",
    "brand_std",
    "brand_tags",
    "sizes",
    "has_discount",
  ];

  for (const it of K.items) {
    for (const f of required) {
      assert.ok(f in it, `Missing field '${f}' in item slug=${it?.product_slug || "?"}`);
    }

    // اسم
    assert.ok(String(it.name || "").trim().length >= 2, `Bad name in ${it.product_slug}`);

    // slug
    const slug = String(it.product_slug || "").trim();
    assert.ok(slug.length > 0, "Empty product_slug");

    // url
    assert.ok(isHttpUrl(it.page_url), `Bad page_url in ${slug}`);

    // price number
    const p = toNum(it.price);
    assert.ok(p != null, `Bad price in ${slug}: ${it.price}`);

    // has_discount boolean-ish
    assert.ok(typeof it.has_discount === "boolean", `has_discount not boolean in ${slug}`);

    // brand_std
    assert.ok(String(it.brand_std || "").trim().length > 0, `Empty brand_std in ${slug}`);

    // brand_tags array-ish (بعض الملفات تكون string؛ ندعم الاثنين لكن نرصد الغلط)
    const bt = it.brand_tags;
    const okTags = Array.isArray(bt) || typeof bt === "string";
    assert.ok(okTags, `brand_tags should be array|string in ${slug}`);
  }
});

test("knowledge: product_slug unique", async () => {
  if (!K) K = await fetchJson(KNOWLEDGE_URL);

  const seen = new Set();
  for (const it of K.items) {
    const slug = String(it.product_slug || "").trim();
    assert.ok(!seen.has(slug), `Duplicate product_slug: ${slug}`);
    seen.add(slug);
  }
});

test("knowledge: page_url unique-ish (warn-level as assertion threshold)", async () => {
  if (!K) K = await fetchJson(KNOWLEDGE_URL);

  // بعض المواقع ممكن تعيد نفس الصفحة لنسخ مختلفة، لذا ما نطلب uniqueness 100%.
  const seen = new Map();
  let dups = 0;

  for (const it of K.items) {
    const u = String(it.page_url || "").trim();
    if (!u) continue;
    if (seen.has(u)) dups++;
    else seen.set(u, 1);
  }

  // إذا الدوبلكيت كبيرة جدًا فهذا تراجع
  const ratio = dups / Math.max(1, K.items.length);
  assert.ok(ratio <= 0.15, `Too many duplicate page_url: ${(ratio * 100).toFixed(1)}%`);
});

test("knowledge: audience allowed values + coverage of 4 audiences", async () => {
  if (!K) K = await fetchJson(KNOWLEDGE_URL);

  const allowed = new Set(["", "رجالي", "ستاتي", "ولادي", "بناتي"]);
  const counts = { "": 0, "رجالي": 0, "ستاتي": 0, "ولادي": 0, "بناتي": 0 };

  for (const it of K.items) {
    const a = String(it.audience ?? "").trim();
    assert.ok(allowed.has(a), `Unexpected audience '${a}' in ${it.product_slug}`);
    counts[a] = (counts[a] || 0) + 1;
  }

  // لازم يكون عندنا تغطية للأربع
  assert.ok(counts["رجالي"] > 0, "No رجالي items");
  assert.ok(counts["ستاتي"] > 0, "No ستاتي items");
  assert.ok(counts["ولادي"] > 0, "No ولادي items");
  assert.ok(counts["بناتي"] > 0, "No بناتي items");

  // الجمهور الفارغ ما يزيد كثير (مؤشر تراجع)
  assert.ok(counts[""] <= 50, `Too many blank audience items: ${counts[""]}`);
});

test("knowledge: section coverage (basic)", async () => {
  if (!K) K = await fetchJson(KNOWLEDGE_URL);

  const sections = new Map();
  for (const it of K.items) {
    const s = String(it.section || "").trim();
    assert.ok(s.length > 0, `Empty section in ${it.product_slug}`);
    sections.set(s, (sections.get(s) || 0) + 1);
  }

  // لازم يكون في أحذية على الأقل
  assert.ok((sections.get("أحذية") || 0) > 0, "No 'أحذية' section items");

  // مجموع الأقسام يجب يكون معقول (>1)
  assert.ok(sections.size >= 2, `Too few distinct sections: ${sections.size}`);
});

test("knowledge: brand coverage + sanity", async () => {
  if (!K) K = await fetchJson(KNOWLEDGE_URL);

  const brandCount = new Map();
  for (const it of K.items) {
    const b = normalizeBrandKey(it.brand_std);
    brandCount.set(b, (brandCount.get(b) || 0) + 1);
  }

  // لازم تنوع ماركات
  assert.ok(brandCount.size >= 10, `Too few distinct brands: ${brandCount.size}`);

  // top brands exist
  const top = [...brandCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  // نتأكد أنه فعلاً في ماركات “تشتهر” عندكم حسب الواقع، بدون إلزام أسماء محددة
  const topTotal = top.reduce((s, [, c]) => s + c, 0);
  assert.ok(topTotal >= 30, "Top brands total too small (unexpected)");

  // لا يوجد brand_std فارغ تم فحصه سابقًا، نزيد شرط: لا يكون كله ماركة واحدة
  const max = top[0]?.[1] || 0;
  const ratio = max / Math.max(1, K.items.length);
  assert.ok(ratio <= 0.6, `One brand dominates too much: ${(ratio * 100).toFixed(1)}%`);
});

test("knowledge: brand_tags has brand_std (or brand_key) signal", async () => {
  if (!K) K = await fetchJson(KNOWLEDGE_URL);

  // الفكرة: كثير من مشاكل “الماركة لا تُستدعى” تأتي من أن brand_tags ناقصة.
  // نتحقق أن نسبة كبيرة من العناصر عندها tag قريب من brand_std.
  let checked = 0;
  let ok = 0;

  for (const it of K.items) {
    const b = normalizeBrandKey(it.brand_std);
    const bt = it.brand_tags;
    let tags = [];
    if (Array.isArray(bt)) tags = bt.map(normalizeBrandKey);
    else if (typeof bt === "string") tags = bt.split(/[,\|]/g).map(normalizeBrandKey);

    if (!b) continue;
    checked++;

    const hit = tags.some((t) => t === b || t.includes(b) || b.includes(t));
    if (hit) ok++;
  }

  if (checked > 0) {
    const ratio = ok / checked;
    // ما نطلب 100% لأن بعض المنتجات قد تكون بدون tags مثالية، لكن الأقل 70% مؤشر جودة جيد
    assert.ok(ratio >= 0.7, `brand_tags-brand_std alignment too low: ${(ratio * 100).toFixed(1)}%`);
  }
});

test("knowledge: discount consistency (old_price, discount_percent)", async () => {
  if (!K) K = await fetchJson(KNOWLEDGE_URL);

  let discounted = 0;
  let ok = 0;

  for (const it of K.items) {
    if (!it.has_discount) continue;
    discounted++;

    const p = toNum(it.price);
    const oldP = it.old_price == null || it.old_price === "" ? null : toNum(it.old_price);
    const pct = it.discount_percent == null || it.discount_percent === "" ? null : toNum(it.discount_percent);

    // السعر لازم موجود
    if (p == null) continue;

    // إذا عندنا old_price لازم يكون >= price
    if (oldP != null && oldP < p) {
      continue;
    }

    // إذا عندنا percent، لازم يكون منطقي 1..99 غالبًا
    if (pct != null) {
      if (!(pct > 0 && pct < 100)) continue;
    }

    ok++;
  }

  // إذا في خصومات، لازم تكون معظمها متسقة
  if (discounted > 0) {
    const ratio = ok / discounted;
    assert.ok(ratio >= 0.85, `Discount consistency too low: ${(ratio * 100).toFixed(1)}%`);
  }
});

test("knowledge: price range sanity", async () => {
  if (!K) K = await fetchJson(KNOWLEDGE_URL);

  let min = Infinity;
  let max = -Infinity;
  let count = 0;

  for (const it of K.items) {
    const p = toNum(it.price);
    if (p == null) continue;
    count++;
    if (p < min) min = p;
    if (p > max) max = p;
  }

  assert.ok(count >= 200, "Too few numeric prices");
  // أسعار منطقية لمتجر: عدّل لو بدك
  assert.ok(min >= 0, `Negative min price: ${min}`);
  assert.ok(max <= 5000, `Max price suspiciously high: ${max}`);
});

test("knowledge: sizes parseability + existence", async () => {
  if (!K) K = await fetchJson(KNOWLEDGE_URL);

  let withSizes = 0;
  let parseable = 0;

  for (const it of K.items) {
    const s = String(it.sizes || "").trim();
    if (!s) continue;
    withSizes++;

    const nums = parseAnyNums(s);
    if (nums.length > 0) parseable++;
  }

  // جزء كبير من المنتجات يجب يكون لديه sizes (حسب متجرك، عدل الحد)
  assert.ok(withSizes >= 80, `Too few items with sizes: ${withSizes}`);

  const ratio = parseable / Math.max(1, withSizes);
  assert.ok(ratio >= 0.7, `Sizes parseability too low: ${(ratio * 100).toFixed(1)}%`);
});

test("knowledge: availability non-empty + normalized-ish", async () => {
  if (!K) K = await fetchJson(KNOWLEDGE_URL);

  let empty = 0;
  for (const it of K.items) {
    const a = String(it.availability || "").trim();
    if (!a) empty++;
  }

  // لازم availability تكون موجودة تقريبًا دائمًا
  const ratio = empty / Math.max(1, K.items.length);
  assert.ok(ratio <= 0.02, `Too many empty availability: ${(ratio * 100).toFixed(1)}%`);
});

test("knowledge: detect suspicious brand extraction risk (brand_std should be stable strings)", async () => {
  if (!K) K = await fetchJson(KNOWLEDGE_URL);

  let bad = 0;
  for (const it of K.items) {
    const b = String(it.brand_std || "").trim();
    // brand_std لا يكون رقم/كود فقط
    if (!b) { bad++; continue; }
    if (/^\d+$/.test(b)) bad++;
    // brand_std لا يكون طويل بشكل جنوني
    if (b.length > 60) bad++;
  }

  const ratio = bad / Math.max(1, K.items.length);
  assert.ok(ratio <= 0.05, `Too many suspicious brand_std values: ${(ratio * 100).toFixed(1)}%`);
});

test("knowledge: snapshot hash (observability only)", async () => {
  // هذا الاختبار لا يفشل إلا لو الملف فاضي/غير قابل للقراءة
  // الهدف: يعطيك بصمة SHA256 لتتبع تغيّر المعرفة بوضوح (مثل release fingerprint)
  if (!RAW) RAW = await fetchText(KNOWLEDGE_URL);
  const hash = sha256(RAW);

  assert.ok(hash.length === 64, "Bad sha256 length");
  // اطبعها لو تحب (تقدر تشيلها لاحقًا)
  // console.log("KNOWLEDGE_SHA256=", hash);
});
