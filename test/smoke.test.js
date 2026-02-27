import test from "node:test";
import assert from "node:assert/strict";

import { getPolicy } from "../src/policy/policy.js";
import { handleQuery } from "../src/search/engine.js";
import { getSession, resetSession } from "../src/state/sessionStore.js";

test("policy exposes tie_gap", () => {
  const P = getPolicy();
  assert.equal(P?.ranking?.tie_gap, 6);
});

test("engine loads and greeting path works without knowledge", () => {
  const r = handleQuery("مرحبا", { conversationId: "t1" });
  assert.equal(r.ok, true);
  assert.equal(r.found, true);
  assert.ok(String(r.reply || "").includes("أهلًا"));
});

test("session captures wants_discount + intent_mode via policy", () => {
  resetSession("t2");

  const r = handleQuery("بدي عروض", { conversationId: "t2" });
  assert.equal(r.ok, true);

  const s = getSession("t2");
  assert.ok(s);
  assert.equal(s.wants_discount, true);
  assert.equal(s.intent_mode, "deals");
});

test("size does NOT flip section if session already has one", () => {
  resetSession("t3");

  // ثبت قسم سابق في الجلسة عبر رسالة صريحة (حسب منطق مشروعك)
  handleQuery("عطور", { conversationId: "t3" });

  // الآن أرسل مقاس فقط بدون قسم
  handleQuery("40", { conversationId: "t3" });

  const s = getSession("t3");
  assert.ok(s);
  assert.equal(s.section, "عطور"); // المهم: ما تنقلب لأحذية
});
