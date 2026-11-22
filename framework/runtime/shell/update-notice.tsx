// The update notice (spec S4, Deliver 2): each update check's result reaches
// the shell through the loader's onUpdate, so the note follows the app's
// design and wording. A version that is current shows nothing.
import { useEffect, useState } from "react";
import type { LoaderServices, UpdateResult } from "../loader/contract";
import { Button } from "./ui/button";
import { useShell } from "./context";

interface UpdateNoticeProps {
  onUpdate: NonNullable<LoaderServices["onUpdate"]>;
  /** What "Load it" does; the page reload by default. */
  reload?: () => void;
}

export function UpdateNotice({ onUpdate, reload = () => location.reload() }: UpdateNoticeProps) {
  const { strings } = useShell();
  const [result, setResult] = useState<UpdateResult | null>(null);
  useEffect(() => onUpdate(setResult), [onUpdate]);
  if (!result || result.status === "current") return null;
  return (
    <div id="update-notice" role="status" className="fixed right-4 bottom-4 flex max-w-sm items-center gap-3 rounded-lg border bg-background p-3 text-sm shadow-md">
      {result.status === "updated" ? (
        <>
          <p>{strings.updateReady(result.version)}</p>
          <Button size="sm" onClick={reload}>
            {strings.loadUpdate}
          </Button>
        </>
      ) : (
        <p className="text-destructive">{strings.updateRefused(result.message)}</p>
      )}
    </div>
  );
}
