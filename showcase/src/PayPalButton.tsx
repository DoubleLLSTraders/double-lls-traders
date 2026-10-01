import { useEffect, useRef, useState } from "react";

interface PayPalButtonsInstance {
  isEligible: () => boolean;
  render: (el: HTMLElement) => Promise<void>;
  close: () => Promise<void>;
}

interface PayPalNamespace {
  FUNDING: { PAYPAL: string; CARD: string };
  Buttons: (opts: Record<string, unknown>) => PayPalButtonsInstance;
}

declare global {
  interface Window {
    paypal?: PayPalNamespace;
  }
}

let sdk: { clientId: string; ready: Promise<PayPalNamespace> } | null = null;

function loadSdk(clientId: string): Promise<PayPalNamespace> {
  if (sdk && sdk.clientId === clientId) return sdk.ready;
  const ready = new Promise<PayPalNamespace>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture&components=buttons&enable-funding=card`;
    script.async = true;
    script.onload = () => (window.paypal ? resolve(window.paypal) : reject(new Error("PayPal did not load.")));
    script.onerror = () => {
      sdk = null;
      reject(new Error("PayPal did not load. Check your connection and try again."));
    };
    document.head.appendChild(script);
  });
  sdk = { clientId, ready };
  return ready;
}

interface PayPalButtonProps {
  clientId: string;
  fundingSource: "paypal" | "card";
  /** Return false to stop the payment before PayPal opens (e.g. email missing). */
  onClick: () => boolean;
  createOrder: () => Promise<string>;
  onApprove: (orderId: string) => Promise<void>;
  onError: (message: string) => void;
}

/** PayPal's own button: the PayPal wallet, or the direct debit/credit card form that PayPal hosts. */
export function PayPalButton({ clientId, fundingSource, onClick, createOrder, onApprove, onError }: PayPalButtonProps) {
  const slot = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onClick, createOrder, onApprove, onError });
  handlers.current = { onClick, createOrder, onApprove, onError };
  const [state, setState] = useState<"loading" | "ready" | "unavailable" | "confirming">("loading");

  useEffect(() => {
    let cancelled = false;
    let buttons: PayPalButtonsInstance | null = null;
    loadSdk(clientId)
      .then((paypal) => {
        if (cancelled || !slot.current) return;
        buttons = paypal.Buttons({
          fundingSource: fundingSource === "card" ? paypal.FUNDING.CARD : paypal.FUNDING.PAYPAL,
          style: { layout: "vertical", shape: "rect", height: 48, color: fundingSource === "card" ? "black" : "gold", label: "pay" },
          onClick: (_data: unknown, actions: { reject: () => Promise<void>; resolve: () => Promise<void> }) =>
            handlers.current.onClick() ? actions.resolve() : actions.reject(),
          createOrder: async () => {
            try {
              return await handlers.current.createOrder();
            } catch (err) {
              handlers.current.onError(err instanceof Error ? err.message : "Could not start the payment.");
              throw err;
            }
          },
          onApprove: async (data: { orderID: string }) => {
            setState("confirming");
            try {
              await handlers.current.onApprove(data.orderID);
            } catch (err) {
              handlers.current.onError(err instanceof Error ? err.message : "The payment could not be confirmed.");
              setState("ready");
            }
          },
          onCancel: () => handlers.current.onError("Payment cancelled. You have not been charged."),
          onError: () => handlers.current.onError("PayPal ran into a problem. Try again or use another method."),
        });
        if (!buttons.isEligible()) {
          setState("unavailable");
          return;
        }
        slot.current.innerHTML = "";
        void buttons.render(slot.current).then(() => !cancelled && setState("ready"));
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setState("unavailable");
        handlers.current.onError(err.message);
      });
    return () => {
      cancelled = true;
      void buttons?.close().catch(() => {});
    };
  }, [clientId, fundingSource]);

  return (
    <div className="pp-wrap">
      {state === "loading" && <div className="pp-skeleton" />}
      {state === "unavailable" && (
        <p className="co-method-off">{fundingSource === "card" ? "Card payments aren't available in your region. Try PayPal or M-Pesa." : "PayPal isn't available right now."}</p>
      )}
      {state === "confirming" && <p className="co-method-note"><span className="co-spin" /> Confirming your payment…</p>}
      <div ref={slot} className="pp-slot" hidden={state === "unavailable" || state === "confirming"} />
    </div>
  );
}
