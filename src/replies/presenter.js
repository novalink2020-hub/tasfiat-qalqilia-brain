export function buildReplyFromItem(item) {
  const slug = String(item.product_slug || "").toLowerCase();
  const url = item.page_url || item.url || "";

  const isPolicyLike =
    slug.startsWith("policy-") || slug.startsWith("info-") || slug.startsWith("branch-");

  // سياسات/معلومات: صياغة بشرية بدل شكل "المنتج: ..."
  if (isPolicyLike) {
    const title = item.name || "معلومة";
    if (url) {
      return `أكيد 😊 ${title}\n${url}`;
    }
    return `أكيد 😊 ${title}`;
  }

  // منتجات: نفس القالب الحالي
  const name = item.name || "—";
  const price = item.price ?? "—";
  const oldPrice = item.old_price ?? "";
  const availability = item.availability || "—";

  const priceLine = oldPrice
    ? `السعر: ${price} (كان ${oldPrice})`
    : `السعر: ${price}`;

  const lines = [
    `المنتج: ${name}`,
    priceLine,
    `التوفر: ${availability}`
  ];

  if (url) lines.push(`الرابط: ${url}`);
  return lines.join("\n");
}
