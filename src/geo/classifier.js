import fs from "fs";
import { normalizeForMatch } from "../text/normalize.js";
import path from "path";

let CACHE = null;

function normalizeKey(s) {
  return normalizeForMatch(s);
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
