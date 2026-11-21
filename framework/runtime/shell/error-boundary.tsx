// The error screen: an error thrown while rendering the app's screens shows
// here, with the message and the diagnostics view where an engine exists.
import { Component, type ReactNode } from "react";
import { Button } from "./ui/button";
import { ShellContext, type ShellContextValue } from "./context";

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export class ErrorBoundary extends Component<{ children?: ReactNode }, { error: unknown; failed: boolean }> {
  static contextType = ShellContext;
  declare context: ShellContextValue;
  state = { error: null as unknown, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const { engine, strings, openDiagnostics } = this.context;
    return (
      <div id="shell-error" role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
        <h2 className="font-semibold text-destructive">{strings.errorTitle}</h2>
        <p className="text-sm break-all">{describeError(this.state.error)}</p>
        {engine && (
          <Button variant="outline" onClick={openDiagnostics}>
            {strings.openDiagnostics}
          </Button>
        )}
      </div>
    );
  }
}
