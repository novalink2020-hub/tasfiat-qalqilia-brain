// scripts/sync-places.js
import fs from "fs";
import path from "path";

const url = process.env.GEO_PLACES_URL || "";
if (!url) {
  console.log("ℹ️ GEO_PLACES_URL not set → keeping local src/geo/places.json");
  process.exit(0);
}

const outPath = path.resolve("src/geo/places.json");

try {
  const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const text = await res.text();
  const json = JSON.parse(text); // validate JSON

  fs.writeFileSync(outPath, JSON.stringify(json, null, 2), "utf8");
  console.log("✅ places.json synced from GEO_PLACES_URL →", url);
} catch (e) {
  console.log("⚠️ places sync failed, using local file. Reason:", e?.message || e);
  process.exit(0); // لا نكسر التشغيل
}
