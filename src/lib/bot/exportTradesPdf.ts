import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import logoUrl from "../../assets/logo.png";
import { APP_NAME, APP_SHORT, APP_TAGLINE } from "../brand";
import type { StoredTrade } from "./tradeStore";

export interface TradesPdfSummary {
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
  winRate: number;
  expectancy: number;
  sessionPnl: number;
  breakEvenWinRate: number;
  currency: string;
}

function money(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function clock(epoch: number): string {
  return new Date(epoch * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

async function loadLogoDataUrl(): Promise<string | null> {
  try {
    const res = await fetch(logoUrl);
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * Professional ledger PDF — brand header, summary, full trade table, footer.
 */
export async function downloadTradesPdf(
  trades: StoredTrade[],
  summary: TradesPdfSummary,
): Promise<void> {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 14;
  const generatedAt = new Date().toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const logo = await loadLogoDataUrl();

  // ── Header band ──────────────────────────────────────────────────────
  doc.setFillColor(12, 14, 18);
  doc.rect(0, 0, pageW, 28, "F");

  if (logo) {
    doc.addImage(logo, "PNG", margin, 5, 18, 18);
  }

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(APP_NAME, margin + (logo ? 22 : 0), 12);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(160, 168, 180);
  doc.text(APP_TAGLINE, margin + (logo ? 22 : 0), 18);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(summary.pnl >= 0 ? 46 : 220, summary.pnl >= 0 ? 180 : 80, summary.pnl >= 0 ? 110 : 80);
  doc.text(`All time  ${money(summary.pnl)} ${summary.currency}`, pageW - margin, 12, {
    align: "right",
  });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(140, 148, 160);
  doc.text("Trade ledger · confidential", pageW - margin, 18, { align: "right" });

  // ── Summary strip ────────────────────────────────────────────────────
  let y = 36;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(30, 34, 40);
  doc.text("Performance summary", margin, y);
  y += 4;

  const cards: [string, string][] = [
    ["Trades", String(summary.trades)],
    ["Won", String(summary.wins)],
    ["Lost", String(summary.losses)],
    ["Win rate", `${summary.winRate.toFixed(1)}%`],
    ["Break-even needs", `${summary.breakEvenWinRate.toFixed(1)}%`],
    ["Per trade", money(summary.expectancy)],
    ["This session", `${money(summary.sessionPnl)} ${summary.currency}`],
  ];

  const cardW = (pageW - margin * 2 - 6 * 3) / 7;
  cards.forEach(([label, value], i) => {
    const x = margin + i * (cardW + 3);
    doc.setFillColor(245, 247, 250);
    doc.setDrawColor(220, 224, 230);
    doc.roundedRect(x, y, cardW, 14, 1.5, 1.5, "FD");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.5);
    doc.setTextColor(110, 118, 130);
    doc.text(label.toUpperCase(), x + 2.5, y + 4.5);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(20, 24, 30);
    doc.text(value, x + 2.5, y + 10.5);
  });

  y += 20;

  // Running totals (newest first, same as UI)
  let running = summary.pnl;
  const body = trades.map((trade) => {
    const side =
      trade.side === "DIGITMATCH"
        ? "Matches"
        : trade.side === "DIGITOVER"
          ? "Over"
          : trade.side === "DIGITUNDER"
            ? "Under"
            : "Differs";
    const entryBits = [
      `${side} ${trade.digit}`,
      trade.entryGap !== null && trade.entryGap !== undefined
        ? `gap ${trade.entryGap}`
        : null,
      trade.entryPercent !== undefined
        ? `${trade.entryPercent.toFixed(1)}%`
        : null,
      trade.entryPower !== undefined ? `pwr ${trade.entryPower}` : null,
      trade.entrySpot !== undefined
        ? `spot ${trade.entrySpot.toFixed(2)}`
        : null,
      trade.mode === "paper" ? "demo" : "live",
    ].filter(Boolean);
    const row = [
      clock(trade.at),
      trade.symbol ?? "—",
      entryBits.join(" · "),
      `${trade.contracts} × ${trade.stake.toFixed(2)}`,
      trade.settleDigit === null ? "—" : `digit ${trade.settleDigit}`,
      trade.won ? "Profit" : "Loss",
      money(trade.pnl),
      money(running),
    ];
    running -= trade.pnl;
    return row;
  });

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin, bottom: 18 },
    head: [
      [
        "Time",
        "Market",
        "Entry point",
        "Size",
        "Settled",
        "Result",
        "P/L",
        "Running",
      ],
    ],
    body: body.length
      ? body
      : [["—", "—", "No trades", "—", "—", "—", "—", "—"]],
    styles: {
      font: "helvetica",
      fontSize: 7.5,
      cellPadding: { top: 2.2, bottom: 2.2, left: 2, right: 2 },
      textColor: [30, 34, 40],
      lineColor: [230, 234, 240],
      lineWidth: 0.2,
      overflow: "linebreak",
    },
    headStyles: {
      fillColor: [12, 14, 18],
      textColor: [240, 242, 245],
      fontStyle: "bold",
      fontSize: 7.5,
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252],
    },
    columnStyles: {
      0: { cellWidth: 36 },
      1: { cellWidth: 24 },
      2: { cellWidth: 62 },
      3: { cellWidth: 22 },
      4: { cellWidth: 20 },
      5: { cellWidth: 20 },
      6: { cellWidth: 20, halign: "right" },
      7: { cellWidth: 22, halign: "right" },
    },
    didParseCell(data) {
      if (data.section !== "body") return;
      if (data.column.index === 5) {
        const v = String(data.cell.raw);
        if (v === "Profit") {
          data.cell.styles.textColor = [20, 140, 80];
          data.cell.styles.fontStyle = "bold";
        } else if (v === "Loss") {
          data.cell.styles.textColor = [200, 60, 60];
          data.cell.styles.fontStyle = "bold";
        }
      }
      if (data.column.index === 6 || data.column.index === 7) {
        const v = String(data.cell.raw);
        if (v.startsWith("+")) data.cell.styles.textColor = [20, 140, 80];
        else if (v.startsWith("-")) data.cell.styles.textColor = [200, 60, 60];
      }
    },
    didDrawPage(data) {
      const page = data.pageNumber;
      const pages = doc.getNumberOfPages();

      // Footer band
      doc.setFillColor(12, 14, 18);
      doc.rect(0, pageH - 12, pageW, 12, "F");

      doc.setFont("helvetica", "bold");
      doc.setFontSize(7);
      doc.setTextColor(255, 255, 255);
      doc.text(APP_NAME, margin, pageH - 5);

      doc.setFont("helvetica", "normal");
      doc.setTextColor(160, 168, 180);
      doc.text(APP_TAGLINE, margin + 38, pageH - 5);

      doc.text(`Generated ${generatedAt}`, pageW / 2, pageH - 5, {
        align: "center",
      });

      doc.setTextColor(200, 205, 215);
      doc.text(`Page ${page} of ${pages}`, pageW - margin, pageH - 5, {
        align: "right",
      });
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const slug = APP_SHORT.toLowerCase().replace(/\s+/g, "-");
  doc.save(`${slug}-trades-${stamp}.pdf`);
}
