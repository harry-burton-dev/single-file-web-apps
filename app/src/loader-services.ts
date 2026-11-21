// The bootstrap's services, when the app was started by it. Absent in
// development, where the app is served directly (ADR-0005 section 7).
import type { LoaderServices } from "@trellis/framework";

let services: LoaderServices | undefined;

export function setLoader(next: LoaderServices): void {
  services = next;
}

export const loader = (): LoaderServices | undefined => services;
