function sectionEmoji(section) {
  const s = String(section || "");
  if (s.includes("أحذية")) return "👟";
  if (s.includes("ملابس")) return "👕";
  if (s.includes("عطور")) return "🧴";
  return "🛍️";
}

function moneyILS(v) {
  // يضيف "شيكل" إذا الرقم موجود ولم تُذكر العملة
  const s = String(v ?? "").trim();
  if (!s || s === "—") return "";
  if (s.includes("شيكل") || s.includes("₪")) return s;
  // لو النص رقم فقط
  if (/^\d+(\.\d+)?$/.test(s)) return `${s} شيكل`;
  return s;
}

export function buildReplyFromItem(item) {
  const slug = String(item?.product_slug || "").toLowerCase();
  const url = item?.page_url || item?.url || "";

  const isPolicyLike =
    slug.startsWith("policy-") || slug.startsWith("info-") || slug.startsWith("branch-");

  // سياسات/معلومات: صياغة بشرية بدل شكل "المنتج: ..."
  if (isPolicyLike) {
    const title = item?.name || "معلومة";
    if (url) {
      return `أكيد 😊 ${title}\n🔗 [اضغط هنا](${url})`;
    }
    return `أكيد 😊 ${title}`;
  }

  // منتجات: قالب بشري + واضح
  const name = item?.name || "—";
  const section = item?.section || "";
  const availability = item?.availability || "—";

  const price = moneyILS(item?.price);
  const oldPrice = moneyILS(item?.old_price);

  const hasDiscount =
    item?.has_discount === true || String(item?.has_discount || "").toLowerCase() === "true";
  const discountPercent = Number(item?.discount_percent || 0);

  const icon = sectionEmoji(section);

  const lines = [];

  // 0) سطر تحفيزي
  lines.push(`اختيار ممتاز 👌`);

  // 1) اسم المنتج
  lines.push(`${icon} **${name}**`);

  // 2) السعر
  if (price) {
    if (oldPrice && oldPrice !== price) {
      lines.push(`💰 السعر: **${price}** (كان ~~${oldPrice}~~)`);
    } else {
      lines.push(`💰 السعر: **${price}**`);
    }
  }

  // 3) الخصم
  if (hasDiscount && discountPercent > 0) {
    lines.push(`✨ خصم **${discountPercent}%** حالياً`);
  }

  // 4) التوفر
  const ok = String(availability).includes("متوفر");
  lines.push(`${ok ? "✅" : "⚠️"} التوفر: **${availability}**`);

  // 5) الرابط
  if (url) lines.push(`🔗 **[اضغط هنا لفتح صفحة المنتج](${url})**`);

  // 6) متابعة الخيارات (من القائمة السابقة 1/2/3)
  lines.push(`بدك تشوف باقي الخيارات؟ اكتب 2 أو 3 من القائمة.`);

  return lines.join("\n");
}
