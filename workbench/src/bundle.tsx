// Entry of the app bundle (ADR-0005 section 6): one ES module, styles
// included, run by the bootstrap from a Blob URL.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/app";
import { setLoader } from "./app/loader-services";
import type { LoaderServices } from "./loader/contract";
import css from "./index.css?inline";

export function start(services: LoaderServices): void {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  setLoader(services);
  createRoot(services.mount).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
