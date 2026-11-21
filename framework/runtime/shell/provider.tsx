// Gives the shell's pieces the engine and the wording, catches errors in the
// app's screens and shows the error screen, and holds the diagnostics view
// (spec S4, Deliver 2).
import { useMemo, useState, type ReactNode } from "react";
import type { Engine } from "../host/engine-types";
import type { LoaderServices } from "../loader/contract";
import { mergeStrings, type ShellStringOverrides } from "./strings";
import { ShellContext, type ShellContextValue } from "./context";
import { Diagnostics } from "./diagnostics";
import { ErrorBoundary } from "./error-boundary";
import { UpdateNotice } from "./update-notice";

interface ShellProviderProps {
  /** Absent until the engine has started. */
  engine?: Engine;
  /** Rewords any of the shell's text; the rest stays as in defaultStrings. */
  strings?: ShellStringOverrides;
  /** The loader's onUpdate, when the app was started by the bootstrap: the shell then shows the update notice. */
  onUpdate?: LoaderServices["onUpdate"];
  children?: ReactNode;
}

export function ShellProvider({ engine, strings, onUpdate, children }: ShellProviderProps) {
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const merged = useMemo(() => mergeStrings(strings), [strings]);
  const value = useMemo<ShellContextValue>(() => ({ engine: engine ?? null, strings: merged, openDiagnostics: () => setDiagnosticsOpen(true) }), [engine, merged]);
  return (
    <ShellContext.Provider value={value}>
      <ErrorBoundary>{children}</ErrorBoundary>
      {onUpdate && <UpdateNotice onUpdate={onUpdate} />}
      {engine && diagnosticsOpen && <Diagnostics engine={engine} onClose={() => setDiagnosticsOpen(false)} />}
    </ShellContext.Provider>
  );
}
