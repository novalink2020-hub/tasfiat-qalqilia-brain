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

  x = x.replace(/<[^>]+>/g, " ");

  // توحيد العربية
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

function loadGeoNamesTxt(txtPath, defaultZone) {
  const lines = fs.readFileSync(txtPath, "utf8").split("\n");
  const map = new Map();

  for (const line of lines) {
    if (!line) continue;
    const cols = line.split("\t");
    if (cols.length < 9) continue;

    const name = cols[1] || "";
    const asciiname = cols[2] || "";
    const alternatenames = cols[3] || "";
    const featureClass = cols[6] || "";

    // P = populated places (مدن/قرى)
    if (featureClass !== "P") continue;

    const candidates = [name, asciiname];
    const altList = alternatenames.split(",").slice(0, 25);
    for (const a of altList) candidates.push(a);

    for (const c of candidates) {
      const k = normalizeKey(c);
      if (!k) continue;
      if (!map.has(k)) map.set(k, defaultZone);
    }
  }
  return map;
}

function mergePreferFirst(base, extra) {
  for (const [k, v] of extra.entries()) {
    if (!base.has(k)) base.set(k, v);
  }
}

function main() {
  const [psTxt, ilTxt] = process.argv.slice(2);
  if (!psTxt || !ilTxt) {
    console.error("Usage: node scripts/build-places.mjs <PS.txt> <IL.txt>");
    process.exit(1);
  }

  const aliasesFile = readJson(ALIASES_PATH);
  const aliases = aliasesFile?.aliases || {};

  // PS => west_bank (وشحن ضواحي القدس سيُحسم عبر aliases)
  const psMap = loadGeoNamesTxt(psTxt, "west_bank");
  // IL => inside_1948
  const ilMap = loadGeoNamesTxt(ilTxt, "inside_1948");

  // دمج مع أولوية PS ثم IL
  const merged = new Map();
  mergePreferFirst(merged, psMap);
  mergePreferFirst(merged, ilMap);

  // حقن الـ aliases (أولوية أعلى من كل شيء)
  for (const [kRaw, zone] of Object.entries(aliases)) {
    const k = normalizeKey(kRaw);
    if (k) merged.set(k, zone);
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
