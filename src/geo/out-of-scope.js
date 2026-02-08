// src/geo/out-of-scope.js
import fs from "fs";
import path from "path";
import { normalizeForMatch } from "../text/normalize.js";

let CACHE = null;

function loadOnce() {
  if (CACHE) return CACHE;

  const p = path.resolve("src/geo/out_of_scope.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));

  const gaza = Array.isArray(raw?.gaza) ? raw.gaza : [];
  const outside = Array.isArray(raw?.outside_palestine) ? raw.outside_palestine : [];

  CACHE = {
    policy: raw?.policy || {},
    gaza: gaza.map(x => normalizeForMatch(x)).filter(Boolean),
    outside: outside.map(x => normalizeForMatch(x)).filter(Boolean)
  };

  return CACHE;
}

function includesAny(query, list) {
  const q = normalizeForMatch(query);
  if (!q) return false;
  return list.some(k => k && (q.includes(k) || k.includes(q)));
}

export function detectOutOfScopePlace(text) {
  const data = loadOnce();

  if (includesAny(text, data.gaza)) return { scope: "gaza", policy: data.policy };
  if (includesAny(text, data.outside)) return { scope: "outside_palestine", policy: data.policy };

  return { scope: "in_scope", policy: data.policy };
}
