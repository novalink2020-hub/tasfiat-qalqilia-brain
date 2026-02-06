import { CONFIG } from "../config.js";

let KNOWLEDGE = null;

export async function loadKnowledge() {
  if (!CONFIG.KNOWLEDGE_URL) return { ok: false, reason: "missing KNOWLEDGE_URL" };

  const r = await fetch(CONFIG.KNOWLEDGE_URL);
  if (!r.ok) return { ok: false, reason: `fetch_failed_${r.status}` };

  KNOWLEDGE = await r.json();

  const count = KNOWLEDGE?.count || KNOWLEDGE?.items?.length || 0;
  console.log("✅ Knowledge loaded from:", CONFIG.KNOWLEDGE_URL, "count:", count);

  return { ok: true, count };
}

export function getKnowledge() {
  return KNOWLEDGE;
}
