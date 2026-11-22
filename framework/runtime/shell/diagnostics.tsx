// The diagnostics view (ADR-0004 section 6), opened from the health menu or the
// error screen: metrics, every sync attempt newest first, and the
// file-by-file steps of the attempt you open.
import { useEffect, useId, useRef, useState } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import type { Engine, Metrics, Trace } from "../host/engine-types";
import { clockTime, milliseconds } from "./format";
import { useEngineValue } from "./engine-store";
import { useShell } from "./context";
import type { ShellStrings } from "./strings";

const TRACE_LIMIT = 100;
const SYNC_EVENTS = ["trace", "health"] as const;
const readView = (engine: Engine) => ({ metrics: engine.metrics(), traces: engine.traces({ limit: TRACE_LIMIT }) });

function MetricsSummary({ metrics, strings }: { metrics: Metrics; strings: ShellStrings }) {
  const ms = (value: number | null) => milliseconds(value, strings);
  const { save, scan } = metrics.sync;
  const { backlog, conflicts } = metrics;
  const rows: ReadonlyArray<readonly [string, string]> = [
    [strings.saveTime, [save.lastMs, save.avgMs, save.p95Ms].map(ms).join(" / ")],
    [strings.folderReadTime, [scan.lastMs, scan.avgMs, scan.p95Ms].map(ms).join(" / ")],
    [strings.backlog, strings.backlogValue(backlog.pendingCount, backlog.pendingBytes, backlog.unreadableFiles)],
    [strings.conflicts, strings.conflictsValue(conflicts.askOpen, conflicts.overlapNotices, conflicts.copiesSeen, conflicts.digestMismatches)],
    [strings.errors, String(metrics.errors.total)],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function TraceSteps({ trace, strings }: { trace: Trace; strings: ShellStrings }) {
  if (trace.steps.length === 0) return <p className="px-2 pb-2 text-xs text-muted-foreground">{strings.noFileActivity}</p>;
  return (
    <table className="mb-2 w-full text-xs">
      <tbody>
        {trace.steps.map((step, index) => (
          <tr key={index} className="border-t">
            <td className="px-2 py-0.5">{step.action}</td>
            <td className="px-2 py-0.5 break-all">{step.path}</td>
            <td className="px-2 py-0.5 text-right">{step.bytes ?? ""}</td>
            <td className="px-2 py-0.5 text-right">{milliseconds(step.durationMs, strings)}</td>
            <td className="px-2 py-0.5">{step.error ?? step.result}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Diagnostics({ engine, onClose }: { engine: Engine; onClose: () => void }) {
  const { strings } = useShell();
  const view = useEngineValue(engine, SYNC_EVENTS, readView);
  const [openId, setOpenId] = useState<Trace["id"] | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }, []);

  return (
    <dialog
      ref={ref}
      id="diagnostics"
      aria-labelledby={titleId}
      className="m-auto w-[min(48rem,calc(100%-2rem))] rounded-lg border bg-background p-4 text-foreground shadow-lg backdrop:bg-foreground/20"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => event.key === "Escape" && onClose()}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 id={titleId} className="mr-auto font-semibold">
            {strings.diagnostics}
          </h2>
          <Button variant="outline" size="sm" onClick={() => void engine.flush()}>
            {strings.saveNow}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void engine.scan()}>
            {strings.readFolderNow}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {strings.close}
          </Button>
        </div>
        <MetricsSummary metrics={view.metrics} strings={strings} />
        <ul aria-label={strings.attemptsLabel} className="max-h-96 overflow-auto rounded-md border text-sm">
          {view.traces.map((trace) => (
            <li key={trace.id} className="border-b last:border-b-0">
              <button
                type="button"
                aria-expanded={openId === trace.id}
                className="flex w-full items-center gap-3 px-2 py-1 text-left hover:bg-muted"
                onClick={() => setOpenId(openId === trace.id ? null : trace.id)}
              >
                <span className="w-20 tabular-nums">{clockTime(trace.startedAt, strings.never)}</span>
                <span className="w-24">{trace.kind}</span>
                <Badge variant={trace.outcome === "failed" ? "destructive" : "secondary"}>{trace.outcome}</Badge>
                <span className="text-muted-foreground">{trace.reason}</span>
                <span className="ml-auto tabular-nums">{milliseconds(trace.durationMs, strings)}</span>
              </button>
              {openId === trace.id && <TraceSteps trace={trace} strings={strings} />}
            </li>
          ))}
          {view.traces.length === 0 && <li className="px-2 py-1 text-muted-foreground">{strings.noSyncAttempts}</li>}
        </ul>
      </div>
    </dialog>
  );
}
