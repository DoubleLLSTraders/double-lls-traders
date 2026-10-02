/** Shared by the checkout and the payment server, so the server charges exactly what the page shows. */

export type PlanId = "lite" | "pro" | "lifetime";

export interface PlanPrice {
  id: PlanId;
  name: string;
  price: number;
  /** Price before the cut, shown struck through. */
  was: number;
  /** Kept on orders for the admin view; setup is now included free. */
  setupFee: number;
}

export const PLAN_PRICES: Record<PlanId, PlanPrice> = {
  lite: { id: "lite", name: "Starter", price: 29, was: 59, setupFee: 0 },
  pro: { id: "pro", name: "Pro", price: 79, was: 149, setupFee: 0 },
  lifetime: { id: "lifetime", name: "Lifetime", price: 149, was: 299, setupFee: 0 },
};

export const COUPONS: Record<string, number> = { NYC10: 0.1, LAUNCH20: 0.2 };

/** M-Pesa is charged in shillings at this rate. */
export const KES_PER_USD = 130;

export interface Quote {
  plan: PlanPrice;
  coupon: string | null;
  discount: number;
  licence: number;
  total: number;
  totalKes: number;
}

/** The coupon applies to the licence; setup is included at no charge. */
export function quote(planId: string, couponCode?: string | null): Quote | null {
  const plan = PLAN_PRICES[planId as PlanId];
  if (!plan) return null;
  const code = (couponCode ?? "").trim().toUpperCase();
  const rate = COUPONS[code] ?? 0;
  const discount = Math.round(plan.price * rate * 100) / 100;
  const licence = plan.price - discount;
  const total = Math.round((licence + plan.setupFee) * 100) / 100;
  return { plan, coupon: rate ? code : null, discount, licence, total, totalKes: Math.round(total * KES_PER_USD) };
}
