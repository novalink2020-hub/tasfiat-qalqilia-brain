// src/policy/policy.js
import fs from "fs";
import path from "path";

let _POLICY = null;

function loadPolicyFile_() {
  const p = path.resolve("src/policy/policy.config.json");
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
}

export function getPolicy() {
  if (_POLICY) return _POLICY;
  _POLICY = loadPolicyFile_();
  return _POLICY;
}

// تطبيع بسيط للنص العربي (بدون تشكيل/همزات) لمطابقة واقعية
export function foldArabic(s) {
  const x = String(s || "");
  return x
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "") // تشكيل
    .replace(/[إأآٱ]/g, "ا") // ألف
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ـ/g, "")
    .toLowerCase()
    .trim();
}

function includesAny_(textFold, keywords = []) {
  for (const k of keywords) {
    const kk = foldArabic(k);
    if (!kk) continue;
    if (textFold.includes(kk)) return true;
  }
  return false;
}

export function detectIntentMode(text) {
  const P = getPolicy();
  const t = foldArabic(text);

  if (includesAny_(t, P?.intents?.deals?.keywords)) return "deals";
  if (includesAny_(t, P?.intents?.budget?.keywords)) return "budget";
  if (includesAny_(t, P?.intents?.premium?.keywords)) return "premium";

  return "default";
}

export function wantsDeals(text) {
  const P = getPolicy();
  return includesAny_(foldArabic(text), P?.intents?.deals?.keywords);
}
