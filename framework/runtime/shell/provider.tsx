// Gives the shell's pieces the engine and the wording, catches errors in the
// app's screens and shows the error screen, and holds the diagnostics view
// (spec S4, Deliver 2).
import { useMemo, useState, type ReactNode } from "react";
import type { Engine } from "../host/engine-types";
import { mergeStrings, type ShellStringOverrides } from "./strings";
import { ShellContext, type ShellContextValue } from "./context";
import { Diagnostics } from "./diagnostics";
import { ErrorBoundary } from "./error-boundary";

interface ShellProviderProps {
  /** Absent until the engine has started. */
  engine?: Engine;
  /** Rewords any of the shell's text; the rest stays as in defaultStrings. */
  strings?: ShellStringOverrides;
  children?: ReactNode;
}

export function ShellProvider({ engine, strings, children }: ShellProviderProps) {
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const merged = useMemo(() => mergeStrings(strings), [strings]);
  const value = useMemo<ShellContextValue>(() => ({ engine: engine ?? null, strings: merged, openDiagnostics: () => setDiagnosticsOpen(true) }), [engine, merged]);
  return (
    <ShellContext.Provider value={value}>
      <ErrorBoundary>{children}</ErrorBoundary>
      {engine && diagnosticsOpen && <Diagnostics engine={engine} onClose={() => setDiagnosticsOpen(false)} />}
    </ShellContext.Provider>
  );
}
