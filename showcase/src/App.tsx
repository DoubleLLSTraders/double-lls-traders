import { lazy, Suspense, useEffect, useState } from "react";
import { type BotSettings } from "./bot";
import { startAccountSync, useAccount } from "./account";
import { loadSettings, saveSettings, SETTINGS_REPLACED_EVENT } from "./sessionStore";
import { Checkout } from "./Checkout";
import { Landing } from "./Landing";
import { LicencePage } from "./LicencePage";
import { TestDrive } from "./TestDrive";
import { compareVersions, sendPresence, track, trackVisit, useLicence, useRelease, type SitePage } from "./siteClient";

const Admin = lazy(() => import("./Admin"));
const Docs = lazy(() => import("./Docs"));
const Legal = lazy(() => import("./Legal"));
const AccountPage = lazy(() => import("./AccountPage"));

type View = "landing" | "test" | "checkout" | "licence";

const PRESENCE_MS = 10_000;
/** Pages that also have a real path (/docs, /terms…), so search engines can index them; netlify.toml serves them. */
const PATH_PAGES = new Set(["docs", "developers", "terms", "privacy"]);
const route = () => {
  if (window.location.hash) return window.location.hash.replace(/^#\/?/, "");
  const path = window.location.pathname.replace(/^\/+|\/+$/g, "");
  return PATH_PAGES.has(path) ? path : "";
};

const SITE_URL = "https://llsbot.malimines.com";
const PAGE_META: Record<string, { title: string; description: string; path: string }> = {
  "": {
    title: "Double LLS Trading Bot — Deriv Digit Bot for Matches, Differs, Over/Under & Even/Odd",
    description:
      "Double LLS Trading Bot scans every tick and trades Deriv digit contracts (Matches, Differs, Over/Under, Even/Odd) only when a setup proves its edge. Test it free live, then get it as Deriv Bot XML, JavaScript or Python.",
    path: "/",
  },
  docs: {
    title: "Docs & API — Double LLS Trading Bot",
    description: "How to run the Double LLS Trading Bot on Deriv Bot, JavaScript or Python, plus the public API for live market scans and bot signals.",
    path: "/docs",
  },
  developers: {
    title: "Developer API — Double LLS Trading Bot",
    description: "Public API for Deriv digit market scans, bot signals and backtests from the Double LLS Trading Bot.",
    path: "/developers",
  },
  terms: {
    title: "Terms of Service — Double LLS Trading Bot",
    description: "The terms that apply when you use the Double LLS Trading Bot website, licences and downloads.",
    path: "/terms",
  },
  privacy: {
    title: "Privacy Policy — Double LLS Trading Bot",
    description: "What the Double LLS Trading Bot website collects, why, and how to have your data deleted.",
    path: "/privacy",
  },
};

function applyPageMeta(page: string) {
  const meta = PAGE_META[page] ?? PAGE_META[""];
  document.title = meta.title;
  document.querySelector('meta[name="description"]')?.setAttribute("content", meta.description);
  document.querySelector('link[rel="canonical"]')?.setAttribute("href", `${SITE_URL}${meta.path}`);
}

export default function App() {
  const [hash, setHash] = useState(route);
  const [view, setView] = useState<View>(() => (route() === "licence" ? "licence" : "landing"));
  const [returnTo, setReturnTo] = useState<Exclude<View, "checkout">>("landing");
  const [settings, setSettings] = useState<BotSettings>(loadSettings);
  const [buyAfterSignIn, setBuyAfterSignIn] = useState<Exclude<View, "checkout"> | null>(null);
  const account = useAccount();
  const licence = useLicence();
  const release = useRelease();
  const isAdmin = hash === "admin";

  useEffect(() => {
    const onHash = () => {
      setHash(route());
      window.scrollTo({ top: 0 });
      if (route() === "licence") setView("licence");
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!isAdmin) trackVisit();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => applyPageMeta(hash), [hash]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
    if (view !== "licence" && route() === "licence") history.replaceState(null, "", window.location.pathname);
  }, [view]);

  useEffect(() => {
    if (isAdmin || view === "test") return;
    const beat = () => sendPresence(view as SitePage, null);
    beat();
    const id = setInterval(beat, PRESENCE_MS);
    return () => clearInterval(id);
  }, [view, isAdmin]);

  useEffect(() => saveSettings(settings), [settings]);

  useEffect(() => {
    if (isAdmin) return;
    const replaced = () => setSettings(loadSettings());
    window.addEventListener(SETTINGS_REPLACED_EVENT, replaced);
    const stop = startAccountSync();
    return () => {
      window.removeEventListener(SETTINGS_REPLACED_EVENT, replaced);
      stop();
    };
  }, [isAdmin]);

  useEffect(() => {
    if (hash !== "account") setBuyAfterSignIn(null);
  }, [hash]);

  useEffect(() => {
    if (!account || !buyAfterSignIn) return;
    setReturnTo(buyAfterSignIn);
    setBuyAfterSignIn(null);
    setView("checkout");
    window.location.hash = "/";
  }, [account, buyAfterSignIn]);

  if (isAdmin) {
    return (
      <Suspense fallback={null}>
        <Admin />
      </Suspense>
    );
  }
  if (hash === "docs" || hash === "developers" || hash === "terms" || hash === "privacy") {
    return (
      <Suspense fallback={null}>
        {hash === "terms" || hash === "privacy" ? <Legal doc={hash} /> : <Docs />}
      </Suspense>
    );
  }

  const buy = (from: Exclude<View, "checkout">) => () => {
    track("checkout_open", from);
    if (!account) {
      setBuyAfterSignIn(from);
      window.location.hash = "/account";
      return;
    }
    setReturnTo(from);
    setView("checkout");
  };
  const test = (from: string) => () => {
    track("test_click", from);
    setView("test");
  };

  if (hash === "account") {
    const leave = (go: () => void) => () => {
      window.location.hash = "/";
      go();
    };
    return (
      <Suspense fallback={null}>
        <AccountPage
          forPurchase={!!buyAfterSignIn}
          onTest={leave(() => { setBuyAfterSignIn(null); test("account")(); })}
          onBuy={leave(buy("landing"))}
        />
      </Suspense>
    );
  }

  const update = licence && release && view !== "licence" && compareVersions(release.version, licence.version) > 0 ? release : null;
  const banner = update && (
    <div className="update-banner" role="status">
      <span>
        <strong>Double LLS v{update.version} is out.</strong> {update.notes || "A newer version of your bot is ready."}
      </span>
      <button className="btn solid sm" onClick={() => setView("licence")}>Get the update</button>
    </div>
  );

  let page;
  if (view === "checkout") {
    page = <Checkout settings={settings} onSettings={setSettings} onBack={() => setView(returnTo)} />;
  } else if (view === "licence") {
    page = <LicencePage settings={settings} onSettings={setSettings} onBack={() => setView("landing")} />;
  } else if (view === "landing") {
    page = <Landing onTest={test("landing")} onBuy={buy("landing")} />;
  } else {
    page = <TestDrive settings={settings} onSettings={setSettings} onBack={() => setView("landing")} onBuy={buy("test")} />;
  }

  return (
    <>
      {banner}
      {page}
    </>
  );
}
