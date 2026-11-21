// The always-visible sync status (ADR-0004 section 5).
import { Badge } from "@/components/ui/badge";
import type { Health, HealthState } from "@trellis/framework";
import { clockTime } from "./format";

const LABELS: Record<HealthState, string> = {
  saved: "Saved",
  saving: "Saving",
  retrying: "Retrying",
  "folder-disconnected": "Folder disconnected",
  "not-reaching-peers": "Not reaching colleagues",
  offline: "Offline",
};

const PROBLEM_STATES: ReadonlySet<HealthState> = new Set(["retrying", "folder-disconnected", "not-reaching-peers", "offline"]);

interface ConnectionIndicatorProps {
  health: Health | null;
}

export function ConnectionIndicator({ health }: ConnectionIndicatorProps) {
  if (!health) return <Badge variant="secondary">Starting</Badge>;
  const peers = Object.entries(health.peers ?? {});
  return (
    <div id="connection" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <Badge variant={PROBLEM_STATES.has(health.state) ? "destructive" : "secondary"}>{LABELS[health.state]}</Badge>
      {health.pending > 0 && <span>{health.pending} waiting</span>}
      <span>Last save {clockTime(health.lastSaveAt)}</span>
      <span>Last folder read {clockTime(health.lastScanOkAt)}</span>
      {peers.map(([device, peer]) => (
        <span key={device}>
          {peer.user} heard {clockTime(peer.lastHeardAt)}
        </span>
      ))}
    </div>
  );
}
