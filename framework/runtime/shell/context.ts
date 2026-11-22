// What every shell piece reads: the engine (once started), the wording, and
// a way to open the one diagnostics view.
import { createContext, useContext } from "react";
import type { Engine, Health } from "../host/engine-types";
import type { ShellStrings } from "./strings";
import { useEngineValue } from "./engine-store";

export interface ShellContextValue {
  engine: Engine | null;
  strings: ShellStrings;
  openDiagnostics: () => void;
}

export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("Shell pieces must be inside <ShellProvider>");
  return shell;
}

const HEALTH_EVENTS = ["health"] as const;
const readHealth = (engine: Engine): Health => engine.health();

/** The engine's health, kept current; null before the engine has started. */
export function useHealth(): Health | null {
  return useEngineValue(useShell().engine, HEALTH_EVENTS, readHealth);
}
