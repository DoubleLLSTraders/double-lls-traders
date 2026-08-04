/** Atlas real-market instruments (Deriv symbols). Isolated from digits desks. */

export interface AtlasInstrument {
  symbol: string;
  name: string;
  assetClass: "forex" | "metal" | "crypto" | "index";
  /** Conservative round-trip spread in price units. */
  spread: number;
}

export const ATLAS_INSTRUMENTS: AtlasInstrument[] = [
  { symbol: "frxEURUSD", name: "EUR / USD", assetClass: "forex", spread: 0.00012 },
  { symbol: "frxGBPUSD", name: "GBP / USD", assetClass: "forex", spread: 0.00016 },
  { symbol: "frxUSDJPY", name: "USD / JPY", assetClass: "forex", spread: 0.016 },
  { symbol: "frxXAUUSD", name: "Gold / USD", assetClass: "metal", spread: 0.35 },
  { symbol: "frxAUDUSD", name: "AUD / USD", assetClass: "forex", spread: 0.00014 },
  { symbol: "cryBTCUSD", name: "BTC / USD", assetClass: "crypto", spread: 22 },
  { symbol: "cryETHUSD", name: "ETH / USD", assetClass: "crypto", spread: 1.6 },
];

export const ATLAS_TIMEFRAMES = [
  { id: "m1", label: "1m", seconds: 60 },
  { id: "m5", label: "5m", seconds: 300 },
  { id: "m15", label: "15m", seconds: 900 },
  { id: "m30", label: "30m", seconds: 1800 },
  { id: "h1", label: "1H", seconds: 3600 },
  { id: "h4", label: "4H", seconds: 14400 },
  { id: "d1", label: "D", seconds: 86400 },
] as const;

export type AtlasTimeframeId = (typeof ATLAS_TIMEFRAMES)[number]["id"];

export interface AtlasBar {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
