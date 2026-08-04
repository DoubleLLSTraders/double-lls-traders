import { useEffect, useState } from "react";
import App from "./App";
import { ClientAuthPopup } from "./components/ClientAuthPopup";
import {
  consumeOauthRedirect,
  hasOauthSession,
  readOauthSession,
  subscribeOauthSession,
  urlHasOauthReturn,
} from "./lib/deriv/oauth";

/**
 * Public client entry — Over/Under desk with Deriv OAuth gate.
 * Platform stays visible (dimmed) under the login card until connected.
 */
export function ClientShell() {
  const [authed, setAuthed] = useState(() => hasOauthSession());
  const [needsPick, setNeedsPick] = useState(false);

  useEffect(() => {
    if (urlHasOauthReturn()) {
      const session = consumeOauthRedirect();
      if (session) {
        setAuthed(true);
        setNeedsPick(session.accounts.length > 1);
      }
    }
    return subscribeOauthSession(() => {
      setAuthed(hasOauthSession());
    });
  }, []);

  const session = readOauthSession();
  const showPopup = !authed || needsPick;

  return (
    <div className={`client-shell ${showPopup ? "is-gated" : ""}`}>
      <App
        clientMode
        tradingLocked={!authed || needsPick}
        onClientSignOut={() => {
          setAuthed(false);
          setNeedsPick(false);
        }}
      />
      <ClientAuthPopup
        open={showPopup}
        pickAccounts={needsPick ? session?.accounts ?? null : null}
        onPicked={() => setNeedsPick(false)}
        onSignedOut={() => {
          setAuthed(false);
          setNeedsPick(false);
        }}
      />
    </div>
  );
}
