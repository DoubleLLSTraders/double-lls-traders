import { useCallback, useState } from "react";
import App from "./App";
import { AtlasApp } from "./hubs/atlas/AtlasApp";
import { getActiveHub, type HubId } from "./lib/hub";

/**
 * Thin router between the legacy Digits desk and the Atlas real-markets hub.
 * Digits App is never imported by Atlas modules — only this shell chooses.
 */
export function HubRoot() {
  const [hub, setHub] = useState<HubId>(() => getActiveHub());

  const onHubChange = useCallback((next: HubId) => {
    setHub(next);
  }, []);

  if (hub === "atlas") {
    return <AtlasApp onHubChange={onHubChange} />;
  }
  return <App onHubChange={onHubChange} />;
}
