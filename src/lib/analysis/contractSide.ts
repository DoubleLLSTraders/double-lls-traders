import type { ContractSide } from "./signal";

export type TradeDesk = "digits" | "overunder";

export function isDigitsSide(side: ContractSide): boolean {
  return side === "DIGITMATCH" || side === "DIGITDIFF";
}

export function isOverUnderSide(side: ContractSide): boolean {
  return side === "DIGITOVER" || side === "DIGITUNDER";
}

export function deskOf(side: ContractSide): TradeDesk {
  return isOverUnderSide(side) ? "overunder" : "digits";
}

export function sideLabel(side: ContractSide): string {
  switch (side) {
    case "DIGITMATCH":
      return "Matches";
    case "DIGITDIFF":
      return "Differs";
    case "DIGITOVER":
      return "Over";
    case "DIGITUNDER":
      return "Under";
  }
}

export function sideShort(side: ContractSide): string {
  switch (side) {
    case "DIGITMATCH":
      return "M";
    case "DIGITDIFF":
      return "D";
    case "DIGITOVER":
      return "O";
    case "DIGITUNDER":
      return "U";
  }
}

/** Deriv win rules: Over = digit > barrier; Under = digit < barrier; equal loses both. */
export function contractWon(
  side: ContractSide,
  barrier: number,
  exitDigit: number,
): boolean {
  switch (side) {
    case "DIGITMATCH":
      return exitDigit === barrier;
    case "DIGITDIFF":
      return exitDigit !== barrier;
    case "DIGITOVER":
      return exitDigit > barrier;
    case "DIGITUNDER":
      return exitDigit < barrier;
  }
}
