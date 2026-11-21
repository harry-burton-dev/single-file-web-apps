// The always-visible sync status (ADR-0004 section 5): a label and one plain
// sentence per health state, and a small menu whose one item opens the
// diagnostics view.
import { useEffect, useId, useRef, useState } from "react";
import { Badge } from "./ui/badge";
import type { HealthState } from "../host/engine-types";
import { clockTime } from "./format";
import { useHealth, useShell } from "./context";

const PROBLEM_STATES: ReadonlySet<HealthState> = new Set(["retrying", "folder-disconnected", "not-reaching-peers", "offline"]);

export function HealthIndicator() {
  const { engine, strings, openDiagnostics } = useShell();
  const health = useHealth();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const sentenceId = useId();

  useEffect(() => {
    if (!open) return;
    itemRef.current?.focus();
    const outside = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const closeMenu = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const wording = health ? strings.health[health.state] : null;
  const peers = Object.entries(health?.peers ?? {});

  return (
    <div id="connection" ref={rootRef} className="relative flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-describedby={wording ? sentenceId : undefined}
        className="rounded-4xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        onClick={() => setOpen(!open)}
      >
        <Badge variant={health && PROBLEM_STATES.has(health.state) ? "destructive" : "secondary"}>{wording?.label ?? strings.starting}</Badge>
      </button>
      {wording && <span id={sentenceId}>{wording.sentence}</span>}
      {health && health.pending > 0 && <span>{strings.waiting(health.pending)}</span>}
      {health && <span>{strings.lastSave(clockTime(health.lastSaveAt, strings.never))}</span>}
      {health && <span>{strings.lastFolderRead(clockTime(health.lastScanOkAt, strings.never))}</span>}
      {peers.map(([device, peer]) => (
        <span key={device}>{strings.peerHeard(peer.user, clockTime(peer.lastHeardAt, strings.never))}</span>
      ))}
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={strings.healthMenu}
          className="absolute top-full left-0 z-50 mt-1 min-w-40 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
          onKeyDown={(event) => event.key === "Escape" && closeMenu()}
        >
          <button
            ref={itemRef}
            type="button"
            role="menuitem"
            disabled={!engine}
            className="w-full rounded-md px-2 py-1 text-left outline-none hover:bg-muted focus-visible:bg-muted disabled:opacity-50"
            onClick={() => {
              setOpen(false);
              openDiagnostics();
            }}
          >
            {strings.diagnostics}
          </button>
        </div>
      )}
    </div>
  );
}
