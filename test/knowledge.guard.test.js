// test/knowledge.guard.test.js
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";

const KNOWLEDGE_URL =
  "https://raw.githubusercontent.com/novalink2020-hub/tasfiat-qalqilia/refs/heads/main/tasfiat_knowledge.cleaned.json";

const LOCAL_FALLBACK_PATH = "test/fixtures/tasfiat_knowledge.cleaned.json";

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
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchTextWithRetryAndFallback(url) {
  // 1) محاولة أولى
  try {
    return await fetchText(url, 15000);
  } catch (e1) {
    // 2) محاولة ثانية (Retry مرة واحدة)
    try {
      return await fetchText(url, 20000);
    } catch (e2) {
      // 3) Fallback محلي
      if (fs.existsSync(LOCAL_FALLBACK_PATH)) {
        return fs.readFileSync(LOCAL_FALLBACK_PATH, "utf8");
      }
      throw new Error(
        `Knowledge fetch failed twice and no local fallback found.\n` +
          `URL: ${url}\n` +
          `Expected local file: ${LOCAL_FALLBACK_PATH}\n` +
          `Last error: ${String(e2?.message || e2)}`
      );
    }
  }
}

async function fetchJson(url) {
  const txt = await fetchTextWithRetryAndFallback(url);
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

// =========================
// Thresholds (Demo-friendly but strict enough)
// =========================
const MIN_ITEMS = 200;
const MAX_DUP_PAGE_URL_RATIO = 0.15;

const MAX_BLANK_AUDIENCE = 50;

// “Gate ذكي” للديمو: اسم/قسم فارغ مسموح بعدد صغير (ونطبع أمثلة)
// إذا بدك تشددها لاحقًا: خليها 0
const MAX_EMPTY_NAME = 15;
const MAX_EMPTY_SECTION = 15;
const MAX_EMPTY_BRAND_STD = 15;

// availability الفارغ: الديمو يسمح حتى 3%
const MAX_EMPTY_AVAIL_RATIO = 0.03;

// sizes
const MIN_WITH_SIZES = 80;
const MIN_SIZES_PARSE_RATIO = 0.7;

// brands
const MIN_DISTINCT_BRANDS = 10;
const MAX_SINGLE_BRAND_DOMINANCE = 0.6;

// discount
const MIN_DISCOUNT_OK_RATIO = 0.85;

// brand_tags alignment
const MIN_TAGS_ALIGNMENT_RATIO = 0.7;

test("knowledge: download from GitHub raw + parse JSON (retry + fallback)", async () => {
  RAW = await fetchTextWithRetryAndFallback(KNOWLEDGE_URL);
  assert.ok(RAW.length > 1000, "Knowledge file looks too small");

  K = JSON.parse(RAW);
  assert.equal(typeof K, "object");
  assert.ok(Array.isArray(K.items), "Missing items[]");
  assert.equal(typeof K.count, "number");
  assert.equal(K.count, K.items.length, "count != items.length");
});

test("knowledge: top-level keys sanity", async () => {
  if (!K) K = await fetchJson(KNOWLEDGE_URL);

  for (const key of ["count", "items"]) {
    assert.ok(key in K, `Missing top-level key: ${key}`);
  }

  assert.ok(K.items.length >= MIN_ITEMS, `Too few items: ${K.items.length}`);
});

test("knowledge: stable schema presence on each item (gate + examples)", async () => {
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

  const badNames = [];
  const badSections = [];
  const badUrls = [];
  const badPrices = [];
  const badBrandStd = [];
  const badHasDiscount = [];
  const badBrandTagsType = [];
  const badSlug = [];

  for (const it of K.items) {
    const slug = String(it?.product_slug || "").trim();

    for (const f of required) {
      assert.ok(f in it, `Missing field '${f}' in item slug=${slug || "?"}`);
    }

    if (!slug) badSlug.push(slug || "?");

    const nm = String(it.name || "").trim();
    if (nm.length === 0) badNames.push(slug || "?");

    const sec = String(it.section || "").trim();
    if (sec.length === 0) badSections.push(slug || "?");

    if (!isHttpUrl(it.page_url)) badUrls.push(slug || "?");

    const p = toNum(it.price);
    if (p == null) badPrices.push(`${slug || "?"}:${String(it.price)}`);

    const bstd = String(it.brand_std || "").trim();
    if (!bstd) badBrandStd.push(slug || "?");

    if (typeof it.has_discount !== "boolean") badHasDiscount.push(slug || "?");

    const bt = it.brand_tags;
    const okTags = Array.isArray(bt) || typeof bt === "string";
    if (!okTags) badBrandTagsType.push(slug || "?");
  }

  // Gate على المشاكل الحرجة
  if (
    badNames.length > MAX_EMPTY_NAME ||
    badSections.length > MAX_EMPTY_SECTION ||
    badUrls.length > 0 ||
    badPrices.length > 0 ||
    badBrandStd.length > MAX_EMPTY_BRAND_STD ||
    badHasDiscount.length > 0 ||
    badBrandTagsType.length > 0 ||
    badSlug.length > 0
  ) {
    assert.fail(
      `Knowledge schema issues:\n` +
        `- Empty name: ${badNames.length} (allowed <= ${MAX_EMPTY_NAME}) examples: ${badNames.slice(0, 20).join(", ")}\n` +
        `- Empty section: ${badSections.length} (allowed <= ${MAX_EMPTY_SECTION}) examples: ${badSections.slice(0, 20).join(", ")}\n` +
        `- Bad page_url: ${badUrls.length} examples: ${badUrls.slice(0, 20).join(", ")}\n` +
        `- Bad price: ${badPrices.length} examples: ${badPrices.slice(0, 20).join(", ")}\n` +
        `- Empty brand_std: ${badBrandStd.length} (allowed <= ${MAX_EMPTY_BRAND_STD}) examples: ${badBrandStd.slice(0, 20).join(", ")}\n` +
        `- has_discount not boolean: ${badHasDiscount.length} examples: ${badHasDiscount.slice(0, 20).join(", ")}\n` +
        `- brand_tags bad type: ${badBrandTagsType.length} examples: ${badBrandTagsType.slice(0, 20).join(", ")}\n` +
        `- Empty product_slug: ${badSlug.length} examples: ${badSlug.slice(0, 20).join(", ")}\n`
    );
  }
});

test("knowledge: product_slug unique", async () => {
  if (!K) K = await fetchJson(KNOWLEDGE_URL);

  const seen = new Set();
  for (const it of K.items) {
    const slug = String(it.product_slug || "").trim();
    assert.ok(slug.length > 0, "Empty product_slug");
    assert.ok(!seen.has(slug), `Duplicate product_slug: ${slug}`);
    seen.add(slug);
  }
});

test("knowledge: page_url unique-ish (warn-level threshold)", async () => {
  if (!K) K = await fetchJson(KNOWLEDGE_URL);

  const seen = new Map();
  let dups = 0;

  for (const it of K.items) {
    const u = String(it.page_url || "").trim();
    if (!u) continue;
    if (seen.has(u)) dups++;
    else seen.set(u, 1);
  }

  const ratio = dups / Math.max(1, K.items.length);
  assert.ok(
    ratio <= MAX_DUP_PAGE_URL_RATIO,
    `Too many duplicate page_url: ${(ratio * 100).toFixed(1)}%`
  );
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

  assert.ok(counts["رجالي"] > 0, "No رجالي items");
  assert.ok(counts["ستاتي"] > 0, "No ستاتي items");
  assert.ok(counts["ولادي"] > 0, "No ولادي items");
  assert.ok(counts["بناتي"] > 0, "No بناتي items");

  assert.ok(counts[""] <= MAX_BLANK_AUDIENCE, `Too many blank audience items: ${counts[""]}`);
});

test("knowledge: section coverage (basic, ignores empty sections here)", async () => {
  if (!K) K = await fetchJson(KNOWLEDGE_URL);

  const sections = new Map();
  for (const it of K.items) {
    const s = String(it.section || "").trim();
    if (!s) continue; // الفارغ يتم رصده في schema gate
    sections.set(s, (sections.get(s) || 0) + 1);
  }

  assert.ok((sections.get("أحذية") || 0) > 0, "No 'أحذية' section items");
  assert.ok(sections.size >= 2, `Too few distinct sections: ${sections.size}`);
});

test("knowledge: brand coverage + sanity", async () => {
  if (!K) K = await fetchJson(KNOWLEDGE_URL);

  const brandCount = new Map();
  for (const it of K.items) {
    const b = normalizeBrandKey(it.brand_std);
    if (!b) continue;
    brandCount.set(b, (brandCount.get(b) || 0) + 1);
  }

  assert.ok(brandCount.size >= MIN_DISTINCT_BRANDS, `Too few distinct brands: ${brandCount.size}`);

  const top = [...brandCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const topTotal = top.reduce((s, [, c]) => s + c, 0);
  assert.ok(topTotal >= 30, "Top brands total too small (unexpected)");

  const max = top[0]?.[1] || 0;
  const ratio = max / Math.max(1, K.items.length);
  assert.ok(ratio <= MAX_SINGLE_BRAND_DOMINANCE, `One brand dominates too much: ${(ratio * 100).toFixed(1)}%`);
});

test("knowledge: brand_tags aligns with brand_std (signal quality)", async () => {
  if (!K) K = await fetchJson(KNOWLEDGE_URL);

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
    assert.ok(
      ratio >= MIN_TAGS_ALIGNMENT_RATIO,
      `brand_tags-brand_std alignment too low: ${(ratio * 100).toFixed(1)}%`
    );
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

    if (p == null) continue;
    if (oldP != null && oldP < p) continue;

    if (pct != null) {
      if (!(pct > 0 && pct < 100)) continue;
    }

    ok++;
  }

  if (discounted > 0) {
    const ratio = ok / discounted;
    assert.ok(
      ratio >= MIN_DISCOUNT_OK_RATIO,
      `Discount consistency too low: ${(ratio * 100).toFixed(1)}%`
    );
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

  assert.ok(count >= MIN_ITEMS, "Too few numeric prices");
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

  assert.ok(withSizes >= MIN_WITH_SIZES, `Too few items with sizes: ${withSizes}`);

  const ratio = parseable / Math.max(1, withSizes);
  assert.ok(
    ratio >= MIN_SIZES_PARSE_RATIO,
    `Sizes parseability too low: ${(ratio * 100).toFixed(1)}%`
  );
});

test("knowledge: availability non-empty (demo threshold + examples)", async () => {
  if (!K) K = await fetchJson(KNOWLEDGE_URL);

  let empty = 0;
  const emptySlugs = [];

  for (const it of K.items) {
    const a = String(it.availability || "").trim();
    if (!a) {
      empty++;
      emptySlugs.push(String(it.product_slug || "?"));
    }
  }

  const ratio = empty / Math.max(1, K.items.length);
  if (ratio > MAX_EMPTY_AVAIL_RATIO) {
    const top = emptySlugs.slice(0, 30).join(", ");
    assert.fail(`Too many empty availability: ${(ratio * 100).toFixed(1)}% (examples: ${top})`);
  }
});

test("knowledge: suspicious brand_std risk check", async () => {
  if (!K) K = await fetchJson(KNOWLEDGE_URL);

  let bad = 0;
  for (const it of K.items) {
    const b = String(it.brand_std || "").trim();
    if (!b) { bad++; continue; }
    if (/^\d+$/.test(b)) bad++;
    if (b.length > 60) bad++;
  }

  const ratio = bad / Math.max(1, K.items.length);
  assert.ok(ratio <= 0.05, `Too many suspicious brand_std values: ${(ratio * 100).toFixed(1)}%`);
});

test("knowledge: snapshot sha256 (observability only)", async () => {
  if (!RAW) RAW = await fetchTextWithRetryAndFallback(KNOWLEDGE_URL);
  const hash = sha256(RAW);
  assert.ok(hash.length === 64, "Bad sha256 length");
  // console.log("KNOWLEDGE_SHA256=", hash);
});
