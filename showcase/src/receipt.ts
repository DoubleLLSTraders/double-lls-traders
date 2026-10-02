import { jsPDF } from "jspdf";
import { BOT_NAME } from "./exports";
import type { ReceiptData } from "./siteClient";

const SITE = "llsbot.malimines.com";
const SUPPORT = "support@malimines.com";
const PAGE_W = 210;
const PAGE_H = 297;
const M = 18;

const INK: [number, number, number] = [20, 22, 26];
const MUTED: [number, number, number] = [110, 116, 126];
const LINE: [number, number, number] = [226, 229, 234];
const BAND: [number, number, number] = [11, 13, 16];
const GREEN: [number, number, number] = [46, 160, 105];
const RED: [number, number, number] = [200, 70, 70];

const METHOD: Record<string, string> = { card: "Card (processed by PayPal)", paypal: "PayPal", mpesa: "M-Pesa" };

const money = (n: number, currency = "USD") =>
  currency === "KES" ? `KES ${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`;

const longDate = (t: number) =>
  new Date(t).toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });

async function logoDataUrl(): Promise<string | null> {
  try {
    const blob = await (await fetch("/logo-192.png")).blob();
    return await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** Builds the receipt PDF for a paid order and starts the download. */
export async function downloadReceipt(r: ReceiptData) {
  (await buildReceipt(r)).save(`Double-LLS-receipt-${r.orderId}.pdf`);
}

export async function buildReceipt(r: ReceiptData) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const logo = await logoDataUrl();
  const color = (c: [number, number, number]) => doc.setTextColor(c[0], c[1], c[2]);
  const font = (style: "normal" | "bold", size: number) => {
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
  };
  const rule = (y: number) => {
    doc.setDrawColor(LINE[0], LINE[1], LINE[2]);
    doc.setLineWidth(0.3);
    doc.line(M, y, PAGE_W - M, y);
  };

  // Header band
  doc.setFillColor(BAND[0], BAND[1], BAND[2]);
  doc.rect(0, 0, PAGE_W, 40, "F");
  if (logo) doc.addImage(logo, "PNG", M, 10, 20, 20);
  const brandX = logo ? M + 25 : M;
  font("bold", 15);
  doc.setTextColor(255, 255, 255);
  doc.text("DOUBLE LLS", brandX, 19);
  font("normal", 9);
  doc.setTextColor(170, 176, 186);
  doc.text("TRADING BOT", brandX, 25);
  font("bold", 20);
  doc.setTextColor(255, 255, 255);
  doc.text("RECEIPT", PAGE_W - M, 19, { align: "right" });
  font("normal", 9);
  doc.setTextColor(170, 176, 186);
  doc.text(r.orderId, PAGE_W - M, 25, { align: "right" });

  // Status + date
  let y = 54;
  const refunded = !!r.refunded;
  const stamp = refunded ? `${r.refunded!.reason.toUpperCase()}` : "PAID";
  const stampColor = refunded ? RED : GREEN;
  font("bold", 9);
  const stampW = doc.getTextWidth(stamp) + 8;
  doc.setDrawColor(stampColor[0], stampColor[1], stampColor[2]);
  doc.setLineWidth(0.5);
  doc.roundedRect(M, y - 5, stampW, 7.5, 1.5, 1.5, "S");
  color(stampColor);
  doc.text(stamp, M + 4, y);
  font("normal", 9.5);
  color(MUTED);
  doc.text(longDate(r.at), M + stampW + 4, y);

  // Billed to / Sold by
  y = 70;
  const col2 = PAGE_W / 2 + 4;
  font("bold", 8);
  color(MUTED);
  doc.text("BILLED TO", M, y);
  doc.text("SOLD BY", col2, y);
  font("bold", 11);
  color(INK);
  doc.text(r.name || r.email, M, y + 6);
  doc.text(BOT_NAME, col2, y + 6);
  font("normal", 9.5);
  color(MUTED);
  if (r.name) doc.text(r.email, M, y + 11.5);
  doc.text(SITE, col2, y + 11.5);
  doc.text(SUPPORT, col2, y + 16.5);

  // Line items
  y = 100;
  doc.setFillColor(246, 247, 249);
  doc.rect(M, y - 5.5, PAGE_W - 2 * M, 9, "F");
  font("bold", 8);
  color(MUTED);
  doc.text("DESCRIPTION", M + 4, y);
  doc.text("AMOUNT", PAGE_W - M - 4, y, { align: "right" });

  const item = (label: string, detail: string, amount: string, amountColor = INK) => {
    y += 12;
    font("bold", 10.5);
    color(INK);
    doc.text(label, M + 4, y);
    font("normal", 9);
    color(MUTED);
    doc.text(detail, M + 4, y + 5);
    font("bold", 10.5);
    color(amountColor);
    doc.text(amount, PAGE_W - M - 4, y, { align: "right" });
    y += 5;
    rule(y + 3.5);
  };
  item(`${BOT_NAME}, ${r.plan} licence`, `Version ${r.version} · every bot format${r.coupon ? ` · code ${r.coupon} applied` : ""}`, money(r.licencePrice));
  item("Setup", r.setupFee > 0 ? "One-time setup" : "Included with your licence, no setup fee", r.setupFee > 0 ? money(r.setupFee) : "Free", r.setupFee > 0 ? INK : GREEN);

  // Totals
  y += 14;
  const labelX = PAGE_W - M - 70;
  const total = (label: string, value: string, strong = false) => {
    font(strong ? "bold" : "normal", strong ? 12 : 10);
    color(strong ? INK : MUTED);
    doc.text(label, labelX, y);
    doc.text(value, PAGE_W - M - 4, y, { align: "right" });
    y += strong ? 8 : 6.5;
  };
  total("Subtotal", money(r.total));
  doc.setDrawColor(INK[0], INK[1], INK[2]);
  doc.setLineWidth(0.4);
  doc.line(labelX, y - 3, PAGE_W - M, y - 3);
  y += 3;
  total("Total (USD)", money(r.total), true);
  if (r.currency !== "USD" || r.paid !== r.total) total(`Paid (${r.currency})`, money(r.paid, r.currency), true);

  // Payment + licence key
  y += 8;
  const boxH = 34;
  doc.setDrawColor(LINE[0], LINE[1], LINE[2]);
  doc.setLineWidth(0.3);
  doc.roundedRect(M, y, PAGE_W - 2 * M, boxH, 2.5, 2.5, "S");
  const half = (PAGE_W - 2 * M) / 2;
  const field = (label: string, value: string, x: number, yy: number, mono = false) => {
    font("bold", 7.5);
    color(MUTED);
    doc.text(label, x, yy);
    doc.setFont(mono ? "courier" : "helvetica", "bold");
    doc.setFontSize(mono ? 11 : 10);
    color(INK);
    doc.text(value, x, yy + 5.5);
  };
  field("LICENCE KEY", r.licence, M + 6, y + 9, true);
  field("PAYMENT METHOD", METHOD[r.method] ?? r.method, M + half + 4, y + 9);
  field("ORDER NUMBER", r.orderId, M + 6, y + 24);
  field("PAYMENT REFERENCE", r.paymentRef || "-", M + half + 4, y + 24);

  // Note
  y += boxH + 12;
  font("normal", 9.5);
  color(MUTED);
  const note = refunded
    ? "This payment was returned, so the licence above is no longer active."
    : `Thank you for your purchase. Your licence is saved to your account at ${SITE}, where you can download the bot files and future updates. Purchases come with a 7-day money-back guarantee.`;
  doc.text(doc.splitTextToSize(note, PAGE_W - 2 * M), M, y);

  // Footer
  const fy = PAGE_H - 22;
  rule(fy);
  font("bold", 8.5);
  color(INK);
  doc.text(BOT_NAME, M, fy + 7);
  font("normal", 8);
  color(MUTED);
  doc.text(`${SITE}  ·  ${SUPPORT}`, M, fy + 12);
  doc.text("Trading involves risk. Past results do not guarantee future returns.", M, fy + 17);
  doc.text(`Receipt ${r.orderId}  ·  Page 1 of 1`, PAGE_W - M, fy + 7, { align: "right" });
  doc.text(`Issued ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`, PAGE_W - M, fy + 12, { align: "right" });

  doc.setProperties({ title: `Receipt ${r.orderId}`, subject: `${BOT_NAME} ${r.plan} licence`, author: BOT_NAME });
  return doc;
}
