// Sync inspector (ADR-0004 section 6): metrics, every sync attempt newest
// first, and the file-by-file steps of the attempt you open.
import { useState } from "react";
import { Badge } from "@/shell/components/ui/badge";
import { Button } from "@/shell/components/ui/button";
import type { Engine, Metrics, Trace } from "@/host/engine-types";
import { clockTime, milliseconds } from "./format";
import type { SyncView } from "./use-engine";

interface SyncInspectorProps {
  engine: Engine;
  view: SyncView;
}

function MetricsSummary({ metrics }: { metrics: Metrics }) {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["Save time (last / average / 95th)", [metrics.sync.save.lastMs, metrics.sync.save.avgMs, metrics.sync.save.p95Ms].map(milliseconds).join(" / ")],
    ["Folder read time (last / average / 95th)", [metrics.sync.scan.lastMs, metrics.sync.scan.avgMs, metrics.sync.scan.p95Ms].map(milliseconds).join(" / ")],
    ["Backlog", `${metrics.backlog.pendingCount} changes, ${metrics.backlog.pendingBytes} bytes, ${metrics.backlog.unreadableFiles} unreadable files`],
    ["Conflicts", `${metrics.conflicts.askOpen} open, ${metrics.conflicts.overlapNotices} overlaps, ${metrics.conflicts.copiesSeen} conflict copies, ${metrics.conflicts.digestMismatches} digest mismatches`],
    ["Errors", String(metrics.errors.total)],
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

function TraceSteps({ trace }: { trace: Trace }) {
  if (trace.steps.length === 0) return <p className="px-2 pb-2 text-xs text-muted-foreground">No file activity.</p>;
  return (
    <table className="mb-2 w-full text-xs">
      <tbody>
        {trace.steps.map((step, index) => (
          <tr key={index} className="border-t">
            <td className="px-2 py-0.5">{step.action}</td>
            <td className="px-2 py-0.5 break-all">{step.path}</td>
            <td className="px-2 py-0.5 text-right">{step.bytes ?? ""}</td>
            <td className="px-2 py-0.5 text-right">{milliseconds(step.durationMs)}</td>
            <td className="px-2 py-0.5">{step.error ?? step.result}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SyncInspector({ engine, view }: SyncInspectorProps) {
  const [openId, setOpenId] = useState<Trace["id"] | null>(null);
  return (
    <section id="inspector" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="mr-auto font-semibold">Sync inspector</h2>
        <Button variant="outline" size="sm" onClick={() => void engine.flush()}>Save now</Button>
        <Button variant="outline" size="sm" onClick={() => void engine.scan()}>Read folder now</Button>
      </div>
      <MetricsSummary metrics={view.metrics} />
      <ul className="max-h-96 overflow-auto rounded-md border text-sm">
        {view.traces.map((trace) => (
          <li key={trace.id} className="border-b last:border-b-0">
            <button
              type="button"
              className="flex w-full items-center gap-3 px-2 py-1 text-left hover:bg-muted"
              onClick={() => setOpenId(openId === trace.id ? null : trace.id)}
            >
              <span className="w-20 tabular-nums">{clockTime(trace.startedAt)}</span>
              <span className="w-24">{trace.kind}</span>
              <Badge variant={trace.outcome === "failed" ? "destructive" : "secondary"}>{trace.outcome}</Badge>
              <span className="text-muted-foreground">{trace.reason}</span>
              <span className="ml-auto tabular-nums">{milliseconds(trace.durationMs)}</span>
            </button>
            {openId === trace.id && <TraceSteps trace={trace} />}
          </li>
        ))}
        {view.traces.length === 0 && <li className="px-2 py-1 text-muted-foreground">No sync attempts yet.</li>}
      </ul>
    </section>
  );
}
