import fs from "fs";
import path from "path";

let CACHE = null;

function normalizeKey(s) {
  let x = String(s || "").trim();
  if (!x) return "";
  x = x.replace(/<[^>]+>/g, " ");
  x = x
    .replace(/[إأآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");
  x = x
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return x;
}

export function loadPlacesOnce() {
  if (CACHE) return CACHE;

  // 1) load generated places
  const placesPath = path.resolve("src/geo/places.json");
  const rawPlaces = JSON.parse(fs.readFileSync(placesPath, "utf8"));
  const places = rawPlaces?.places || {};

  // 2) load aliases (high priority overrides) — optional
  const aliasesPath = path.resolve("src/geo/aliases.json");
  let aliases = {};
  try {
    const rawAliases = JSON.parse(fs.readFileSync(aliasesPath, "utf8"));
    aliases = rawAliases?.aliases || {};
  } catch {
    aliases = {};
  }

  // 3) apply aliases on top (normalize keys)
  for (const [kRaw, zone] of Object.entries(aliases)) {
    const k = normalizeKey(kRaw);
    if (k) places[k] = zone;
  }

  CACHE = places;
  return CACHE;
}


export function classifyCityZone(cityText) {
  const places = loadPlacesOnce();
  const k = normalizeKey(cityText);

  if (!k) return null;

  // match مباشر
  if (places[k]) return places[k];

  // محاولة بسيطة: لو في "الـ" بالبداية نشيلها
  if (k.startsWith("ال")) {
    const k2 = k.slice(2).trim();
    if (places[k2]) return places[k2];
  }

  return null;
}
