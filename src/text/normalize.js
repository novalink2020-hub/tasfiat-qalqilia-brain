// src/text/normalize.js
export function stripHtml(s) {
  return String(s || "")
    .replace(/[\s\S]*?<\/script>/gi, " ")
    .replace(/[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeArabic(s) {
  const x = String(s || "");
  return x
    // إزالة التشكيل
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    // توحيد الألف
    .replace(/[إأآٱ]/g, "ا")
    // توحيد الياء/الألف المقصورة
    .replace(/ى/g, "ي")
    // توحيد التاء المربوطة (يفيد البحث)
    .replace(/ة/g, "ه")
    // إزالة التطويل
    .replace(/ـ/g, "")
    // تقليل التكرار الطويل (جومااا → جوما)
    .replace(/(.)\1{2,}/g, "$1$1")
    .trim();
}

export function normalizeForMatch(s) {
  const raw = stripHtml(s);
  const norm = normalizeArabic(raw);
  return norm
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(s) {
  return normalizeForMatch(s)
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2);
}
