import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";

import { getPolicy, detectIntentMode, wantsDeals, foldArabic } from "../src/policy/policy.js";
import { handleQuery } from "../src/search/engine.js";
import { getSession, updateSession, resetSession } from "../src/state/sessionStore.js";

/**
 * =========================================================
 * 0) Policy Snapshot Guard (Enterprise-grade)
 * =========================================================
 * أي تغيير في policy.config.json (حتى كلمة) لازم يطلع Fail.
 * هذا يمنع “انزلاقات” غير مقصودة في الإعدادات.
 */
test("policy snapshot: policy.config.json unchanged", () => {
  const raw = fs.readFileSync("src/policy/policy.config.json", "utf8");
  const normalized = JSON.stringify(JSON.parse(raw)); // تجاهل المسافات/الترتيب
  const hash = crypto.createHash("sha256").update(normalized).digest("hex");

  // ✅ هذه القيمة محسوبة من نسختك الحالية في الريبو
  assert.equal(hash, "ed07335a518c1edfc53a2fc72de1156babbcf78bf330f448289027491359e8a2");
});

/**
 * =========================================================
 * 1) Policy Guard: ثبّت أهم الإعدادات المتفق عليها
 * =========================================================
 */
test("policy: core settings stable", () => {
  const P = getPolicy();

  // أساسيات
  assert.equal(P?.version, "policy-v1");
  assert.equal(P?.locale, "ar-ps");

  // intents موجودة
  assert.ok(Array.isArray(P?.intents?.deals?.keywords));
  assert.ok(Array.isArray(P?.intents?.budget?.keywords));
  assert.ok(Array.isArray(P?.intents?.premium?.keywords));

  // session مفاتيح حرجة
  assert.equal(P?.session?.assume_section_for_size, "أحذية");
  assert.equal(P?.session?.reset_on_section_change?.clear_size, true);
  assert.equal(P?.session?.reset_on_section_change?.clear_brand_if_not_in_message, true);
  assert.equal(P?.session?.brand_inheritance?.enabled, true);
  assert.equal(P?.session?.brand_inheritance?.disable_if_message_has_explicit_section, true);

  // ranking أرقام حرجة (قيمك الحالية)
  assert.equal(P?.ranking?.min_score_default, 24);
  assert.equal(P?.ranking?.min_score_brandish, 12);
  assert.equal(P?.ranking?.min_score_brand_filtered, 8);
  assert.equal(P?.ranking?.min_score_when_size_present, 12);
  assert.equal(P?.ranking?.tie_gap, 6);
});

test("policy: arabic folding + intent detection stable", () => {
  // تطبيع عربي
  assert.equal(foldArabic("أحذية"), "احذيه");
  assert.equal(foldArabic("إأآٱ"), "اااا");

  // deals
  assert.equal(wantsDeals("بدّي خصم"), true);
  assert.equal(detectIntentMode("في تنزيلات؟"), "deals");

  // budget
  assert.equal(detectIntentMode("بكم سعره؟"), "budget");
  assert.equal(detectIntentMode("ما بدي اغلى من 100"), "budget");

  // premium
  assert.equal(detectIntentMode("احسن نوع عندك"), "premium");
  assert.equal(detectIntentMode("مش مهم السعر"), "premium");

  // default
  assert.equal(detectIntentMode("مرحبا"), "default");
});

/**
 * =========================================================
 * 2) Engine Guard: منع رجوع الأرقام السحرية/الترقيع
 * =========================================================
 */
test("engine: tie_gap is NOT hardcoded as top.score - 6", () => {
  const src = fs.readFileSync("src/search/engine.js", "utf8");
  assert.equal(src.includes("top.score - 6"), false);
});

test("engine: tie_gap reads from policy (exists in code)", () => {
  const src = fs.readFileSync("src/search/engine.js", "utf8");
  // وجود tie_gap في القراءة يثبت أن engine صار policy-driven
  assert.ok(src.includes("P?.ranking?.tie_gap"));
});

/**
 * =========================================================
 * 3) Runtime Smoke: سلوك تشغيل + Session Memory Rules
 * =========================================================
 */
test("runtime: greeting works", () => {
  const r = handleQuery("مرحبا", { conversationId: "t_hello" });
  assert.equal(r.ok, true);
  assert.equal(r.found, true);
  assert.ok(String(r.reply || "").length > 0);
});

test("runtime: wants_discount + intent_mode stored (deals)", () => {
  resetSession("t_deals");
  const r = handleQuery("بدي عروض", { conversationId: "t_deals" });
  assert.equal(r.ok, true);

  const s = getSession("t_deals");
  assert.ok(s);
  assert.equal(s.wants_discount, true);
  assert.equal(s.intent_mode, "deals");
});

test("runtime: audience-only should NOT overwrite existing section", () => {
  resetSession("t_aud");
  updateSession("t_aud", { section: "عطور" });

  handleQuery("رجالي", { conversationId: "t_aud" });

  const s = getSession("t_aud");
  assert.ok(s);
  assert.equal(s.section, "عطور");     // ما تغير
  assert.equal(s.audience, "رجالي");   // فقط audience
});

test("runtime: size-only should NOT flip section if session already has one", () => {
  resetSession("t_size_keep");
  updateSession("t_size_keep", { section: "عطور" });

  handleQuery("40", { conversationId: "t_size_keep" });

  const s = getSession("t_size_keep");
  assert.ok(s);
  assert.equal(s.section, "عطور"); // لا تنقلب لأحذية
  assert.equal(typeof s.size, "number"); // المقاس اتخزن
});

test("runtime: size-only sets section to policy default ONLY when session has none", () => {
  resetSession("t_size_default");

  handleQuery("40", { conversationId: "t_size_default" });

  const s = getSession("t_size_default");
  assert.ok(s);
  assert.equal(s.section, "أحذية"); // default من policy/session
  assert.equal(typeof s.size, "number");
});

test("runtime: section change clears size + clears brand (when brand not in message)", () => {
  resetSession("t_clear");
  updateSession("t_clear", {
    section: "أحذية",
    size: 40,
    brand_key: "nike",
    brand_std: "Nike"
  });

  // رسالة تغيّر القسم بدون ماركة
  handleQuery("عطور", { conversationId: "t_clear" });

  const s = getSession("t_clear");
  assert.ok(s);
  assert.equal(s.section, "عطور");
  assert.equal(s.size, null);
  assert.equal(s.brand_key, null);
  assert.equal(s.brand_std, null);
});

test("runtime: detects size inside arabic sentence (نمرة 42) and stores it", () => {
  resetSession("t_size_sentence");

  handleQuery("بدي بوت ريبوك رجالي نمرة 42", { conversationId: "t_size_sentence" });

  const s = getSession("t_size_sentence");
  assert.ok(s);
  assert.equal(s.size, 42);
});

test("runtime: adidas query is handled gracefully (no crash, helpful reply)", () => {
  resetSession("t_adidas");

  const r = handleQuery("بدي بوت اديداس ستاتي نمرة 36", { conversationId: "t_adidas" });

  assert.equal(r.ok, true);
  assert.ok(String(r.reply || "").length > 0);

  // لازم يكون واضح للمستخدم شو يعمل (إما خيارات أو طلب توضيح)
  const txt = String(r.reply || "");
  const looksHelpful =
    txt.includes("اختر رقم") ||
    txt.includes("اكتب اسم المنتج") ||
    txt.includes("اكتب الكود") ||
    txt.includes("الرابط");

  assert.equal(looksHelpful, true);
});

test("runtime: accepts Arabic-Indic digits for product choice (١/٢/٣)", () => {
  // زرع choices يدويًا (بدون الاعتماد على المخزون)
  const choiceMemory = new Map();
  const convId = "t_choice_ar";

  choiceMemory.set(convId, {
    ts: Date.now(),
    options: [
      { slug: "__missing__", name: "Dummy 1" },
      { slug: "__missing__", name: "Dummy 2" },
      { slug: "__missing__", name: "Dummy 3" }
    ]
  });

  const ctx = { conversationId: convId, choiceMemory };

  // اختيار ١ بالأرقام العربية (الهندية)
  const r = handleQuery("١", ctx);

  assert.equal(r.ok, true);
  assert.ok(String(r.reply || "").length > 0);

  // المهم: دخل مسار الاختيار (عادة يظهر "اختيار" أو "الخيار")
  const txt = String(r.reply || "");
  const enteredChoiceFlow = txt.includes("اختيار") || txt.includes("الخيار") || txt.includes("رقم");

  assert.equal(enteredChoiceFlow, true);
});

test("runtime: HOKA with size is handled gracefully (choices/clarify/none with guidance)", () => {
  resetSession("t_hoka");

  const r = handleQuery("بدي بوت هوكا رجالي نمرة 39", { conversationId: "t_hoka" });

  assert.equal(r.ok, true);
  assert.ok(String(r.reply || "").length > 0);

  // إما يعرض خيارات/تفاصيل، أو يطلب توضيح بشكل مفهوم
  const txt = String(r.reply || "");
  const looksHelpful =
    txt.includes("اختر رقم") ||
    txt.includes("اضغط هنا") ||
    txt.includes("اكتب اسم المنتج") ||
    txt.includes("اكتب الكود") ||
    txt.includes("الرابط") ||
    txt.includes("ما لقيت نفس النمرة");

  assert.equal(looksHelpful, true);
});

test("runtime: deals/budget clears choiceMemory + pending_pick (does not stick to previous product)", () => {
  const choiceMemory = new Map();
  const convId = "t_ctx_clear";
  choiceMemory.set(convId, { ts: Date.now(), options: [{ slug: "__x__", name: "X" }] });

  resetSession(convId);
  updateSession(convId, { flags: { pending_pick: "x" }, last_user_text: "OLD_CONTEXT" });

  // دخول نية budget
  handleQuery("بدي ارخص اشي", { conversationId: convId, choiceMemory });

  // لازم choiceMemory ينمسح
  assert.equal(choiceMemory.has(convId), false);

  const s = getSession(convId);
  assert.ok(s);

  // pending_pick لازم ينمسح (هذا هو المقصود من تنظيف السياق)
  assert.equal(s.flags?.pending_pick ?? null, null);

  // last_user_text طبيعي يساوي آخر رسالة للمستخدم (مش شرط null)
  assert.equal(s.last_user_text, "بدي ارخص اشي");
});

test("lock: cart-followup lock prevents duplicates", async () => {
  const mod = await import("../src/chatwoot/cartFollowupLock.js");
  const ok1 = mod.tryLockCartFollowup("t_lock");
  const ok2 = mod.tryLockCartFollowup("t_lock");
  assert.equal(ok1, true);
  assert.equal(ok2, false);
  mod.unlockCartFollowup("t_lock");
});

test("runtime: brand-relax fallback is safe + helpful (conditional)", () => {
  resetSession("t_brand_fb");

  // طلب قد ينجح أو يفشل حسب المخزون؛ المهم لا يعلّق
  const r = handleQuery("بدي بوت اديداس ستاتي نمرة 40", { conversationId: "t_brand_fb" });

  assert.equal(r.ok, true);

  const txt = String(r.reply || "");
  assert.ok(txt.length > 0);

  const tags = Array.isArray(r.tags) ? r.tags.join("|") : "";

  // إذا فعلاً دخلنا مسار brand_fallback لازم يكون النص واضح
  if (tags.includes("brand_fallback")) {
    const looksLikeFallback =
      (txt.includes("بحثت") || txt.includes("دورت")) &&
      (txt.includes("ما لقيت") || txt.includes("مش متوفر")) &&
      (txt.includes("بدائل") || txt.includes("ماركة ثانية") || txt.includes("خيار بديل"));

    assert.equal(looksLikeFallback, true);

    // نضمن ما في تغيير audience في النص (ما بنحكي "حوّلتك لرجالي/ستاتي")
    assert.equal(txt.includes("حوّلنا") || txt.includes("غيرنا الجمهور"), false);
  }
});

test("runtime: audience reply after size prompt clears pending_pick", () => {
  resetSession("t_pick");
  handleQuery("44", { conversationId: "t_pick" });       // يضع pending_pick
  handleQuery("ستاتي", { conversationId: "t_pick" });    // لازم يمسحه

  const s = getSession("t_pick");
  assert.ok(s);
  assert.equal(s.flags?.pending_pick ?? null, null);
});

test("runtime: size phrase مثل (نمرة 44) triggers audience question (not product_none)", () => {
  const r = handleQuery("نمرة 44", { conversationId: "t_size_phrase" });
  assert.equal(r.ok, true);
  assert.equal(r.found, false);
  assert.ok(String(r.reply || "").includes("المقاس 44"));
});
