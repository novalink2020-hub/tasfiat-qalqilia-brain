export function buildReplyFromItem(item) {
  const name = item.name || "—";
  const price = item.price ?? "—";
  const oldPrice = item.old_price ?? "";
  const availability = item.availability || "—";
  const url = item.page_url || item.url || "";

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
