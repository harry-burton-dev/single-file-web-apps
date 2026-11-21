// Puts an app on the page (ADR-0005 sections 6 and 7). The bundle's entry
// exports `start = mount(<TrellisApp ...>, css)`: the bootstrap calls start()
// with its services and the element to render into. In development the page
// is served directly, without the bootstrap, so the app renders into #app at once.
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { LoaderServices } from "../loader/contract";
import { setLoader } from "./services";

export function mount(app: ReactNode, css: string): (services: LoaderServices) => void {
  const show = (element: HTMLElement): void => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    createRoot(element).render(<StrictMode>{app}</StrictMode>);
  };
  if (import.meta.env.DEV) {
    const element = document.getElementById("app");
    if (element) show(element);
  }
  return (services) => {
    setLoader(services);
    show(services.mount);
  };
}
