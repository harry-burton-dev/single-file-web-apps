// defineApp (S1): turns the app's config and screen into the bundle's entry.
// The bootstrap calls start(services) on the bundle (ADR-0005 section 6): one
// ES module, styles included, run from a Blob URL. In development there is no
// loader, so start() mounts straight into #app.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { validateConfig, type AppConfig } from "../../config.ts";
import type { LoaderServices } from "../loader/contract";
import { App, type Screen } from "./app";
import { setLoader } from "./loader-services";
import css from "./index.css?inline";

export function defineApp(config: AppConfig, Screen: Screen): (services?: LoaderServices) => void {
  validateConfig(config);
  return function start(services?: LoaderServices): void {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    let mount = services?.mount;
    if (services) setLoader(services);
    else mount = document.getElementById("app") ?? undefined;
    if (!mount) throw new Error("Missing #app element");
    createRoot(mount).render(
      <StrictMode>
        <App config={config} Screen={Screen} />
      </StrictMode>,
    );
  };
}
