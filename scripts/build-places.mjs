import fs from "fs";
import path from "path";

const OUT = path.resolve("src/geo/places.json");
const ALIASES_PATH = path.resolve("src/geo/aliases.json");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function normalizeKey(s) {
  let x = String(s || "").trim();
  if (!x) return "";

  // remove HTML tags if any
  x = x.replace(/<[^>]+>/g, " ");

  // Arabic normalization (for matching variants)
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

// Generate extra Arabic variants for common typing differences
function addArabicVariants(original) {
  const out = new Set();
  const k = normalizeKey(original);
  if (!k) return out;

  out.add(k);

  // قلقيلية / قلقيليه (ending variants)
  if (k.endsWith("ية")) out.add(k.slice(0, -2) + "يه");
  if (k.endsWith("يه")) out.add(k.slice(0, -2) + "ية");

  // ال التعريف sometimes dropped
  if (k.startsWith("ال")) out.add(k.slice(2));

  return out;
}

function loadGeoNamesTxt(txtPath, defaultZone) {
  const lines = fs.readFileSync(txtPath, "utf8").split("\n");

  const keyToZone = new Map();
  const idToZone = new Map();

  for (const line of lines) {
    if (!line) continue;
    const cols = line.split("\t");
    if (cols.length < 9) continue;

    const geonameid = cols[0];
    const name = cols[1] || "";
    const asciiname = cols[2] || "";
    const alternatenames = cols[3] || "";
    const featureClass = cols[6] || "";

    // P = populated places (cities/villages)
    if (featureClass !== "P") continue;

    idToZone.set(String(geonameid), defaultZone);

    const candidates = [name, asciiname];
    const altList = alternatenames.split(",").slice(0, 25);
    for (const a of altList) candidates.push(a);

    for (const c of candidates) {
      for (const k of addArabicVariants(c)) {
        if (!keyToZone.has(k)) keyToZone.set(k, defaultZone);
      }
    }
  }

  return { keyToZone, idToZone };
}

function mergePreferFirst(base, extra) {
  for (const [k, v] of extra.entries()) {
    if (!base.has(k)) base.set(k, v);
  }
}

function loadAlternateNamesV2(txtPath, idToZoneAll) {
  // Columns (alternateNamesV2):
  // 0 alternateNameId
  // 1 geonameid
  // 2 isolanguage (e.g. ar, he, en) - may be empty
  // 3 alternate name
  // 4 isPreferredName
  // 5 isShortName
  // 6 isColloquial
  // 7 isHistoric
  // 8 from
  // 9 to
  const lines = fs.readFileSync(txtPath, "utf8").split("\n");
  const out = new Map();

  // We mainly care about Arabic + Hebrew + English names
  const allowedLang = new Set(["ar", "he", "en"]);

  for (const line of lines) {
    if (!line) continue;
    const cols = line.split("\t");
    if (cols.length < 4) continue;

    const geonameid = String(cols[1] || "");
    const lang = String(cols[2] || "").trim();
    const altName = cols[3] || "";

    if (!geonameid || !altName) continue;
    if (!idToZoneAll.has(geonameid)) continue; // only our PS/IL populated places
    if (lang && !allowedLang.has(lang)) continue;

    const zone = idToZoneAll.get(geonameid);

    for (const k of addArabicVariants(altName)) {
      if (!out.has(k)) out.set(k, zone);
    }
  }
  return out;
}

function main() {
  const [psTxt, ilTxt, altV2Txt] = process.argv.slice(2);
  if (!psTxt || !ilTxt) {
    console.error("Usage: node scripts/build-places.mjs <PS.txt> <IL.txt> [alternateNamesV2.txt]");
    process.exit(1);
  }

  const aliasesFile = readJson(ALIASES_PATH);
  const aliases = aliasesFile?.aliases || {};

  // Base: PS => west_bank (and suburbs handled via aliases)
  const ps = loadGeoNamesTxt(psTxt, "west_bank");
  // Base: IL => inside_1948
  const il = loadGeoNamesTxt(ilTxt, "inside_1948");

  // merged id->zone (for alternateNamesV2)
  const idToZoneAll = new Map();
  for (const [id, z] of ps.idToZone.entries()) idToZoneAll.set(id, z);
  for (const [id, z] of il.idToZone.entries()) if (!idToZoneAll.has(id)) idToZoneAll.set(id, z);

  // Merge base keys
  const merged = new Map();
  mergePreferFirst(merged, ps.keyToZone);
  mergePreferFirst(merged, il.keyToZone);

  // Add alternateNamesV2 (Arabic/Hebrew/English) if provided
  if (altV2Txt && fs.existsSync(altV2Txt)) {
    const altMap = loadAlternateNamesV2(altV2Txt, idToZoneAll);
    mergePreferFirst(merged, altMap);
  }

  // Inject manual aliases with highest priority
  for (const [kRaw, zone] of Object.entries(aliases)) {
    for (const k of addArabicVariants(kRaw)) {
      merged.set(k, zone);
    }
  }

  const out = {
    meta: {
      version: new Date().toISOString().slice(0, 10),
      generated_by: "scripts/build-places.mjs",
      counts: { keys: merged.size }
    },
    places: Object.fromEntries(merged.entries())
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");
  console.log("✅ places.json generated keys:", merged.size);
}

main();
