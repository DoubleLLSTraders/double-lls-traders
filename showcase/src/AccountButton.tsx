import { useAccount } from "./account";

/** Compact header button: "Sign in" when signed out, the account initial when signed in. */
export function AccountButton() {
  const account = useAccount();
  return (
    <a className={`acct-btn${account ? " in" : ""}`} href="#/account" title={account ? account.email : "Sign in or create an account"}>
      {account ? <span className="acct-btn-avatar">{(account.name || account.email)[0].toUpperCase()}</span> : "Sign in"}
    </a>
  );
}
