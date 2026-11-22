// <TrellisApp config strings?>{screens}</TrellisApp> (spec S4, Deliver 1): owns
// everything between opening the page and the app's screens, then shows the
// screens with the health indicator, inside the error boundary. An app can
// reword it (strings) and style it (its tokens), not replace it.
import { useCallback, useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import { createData } from "../../data/runtime";
import { DataProvider } from "../../react/hooks";
import type { AppDefinition } from "../definition";
import type { HostStart } from "../host/host";
import { appNames } from "../names";
import { ConflictPrompt } from "./conflict-prompt";
import { useShell } from "./context";
import { AlreadyOpen, Failed, FolderStep, folderEvent, InviteForm, Message, PassportStep, UnlockStep, describeError, type Flow } from "./first-run";
import { HealthIndicator } from "./health-indicator";
import { reduce, type ShellEvent, type ShellState, type Started } from "./machine";
import { ShellProvider } from "./provider";
import { realServices, type ShellServices } from "./services";
import { mergeStrings, type ShellStringOverrides, type ShellStrings } from "./strings";
import { Button } from "./ui/button";

const DEV_PRIVATE_FOLDER_HASH = "#private-folder";

export interface TrellisAppProps {
  config: AppDefinition;
  /** Rewords any of the shell's text; the rest stays as in defaultStrings. */
  strings?: ShellStringOverrides;
  /** The app's screens, shown once the engine is running. */
  children?: ReactNode;
  /** For tests: stand-ins for the side effects. */
  services?: ShellServices;
}

const booting = new WeakMap<ShellServices, Promise<ShellEvent>>();

/**
 * Start-up runs once per page, however many times React mounts the component
 * (development mode mounts twice). Running it twice would create two device
 * ids and two engines writing to the same folder.
 */
function boot(services: ShellServices, config: AppDefinition, strings: ShellStrings): Promise<ShellEvent> {
  let started = booting.get(services);
  if (!started) {
    started = (async (): Promise<ShellEvent> => {
      let db;
      try {
        db = await services.openDb(appNames(config).database);
      } catch (error: unknown) {
        return { type: "failed", message: strings.storageUnavailable, detail: describeError(error, strings) };
      }
      try {
        const dev = import.meta.env.DEV && location.hash === DEV_PRIVATE_FOLDER_HASH;
        return await folderEvent(services, db, dev ? await services.privateFolder(config.id) : await services.loadFolder(db));
      } catch (error: unknown) {
        return { type: "failed", message: describeError(error, strings) };
      }
    })();
    booting.set(services, started);
  }
  return started;
}

/**
 * The data runtime for a started engine, made here rather than in a component
 * body so React mounting twice cannot make two. Stopping closes it first.
 */
function withData(started: Extract<HostStart, { ok: true }>, config: AppDefinition, user: string): Started {
  const { engine, deviceId, clock, random } = started;
  const data = createData({ engine, config, deviceId, user, clock, random });
  return {
    ...started,
    data,
    stop: async () => {
      data.close();
      await started.stop();
    },
  };
}

export function TrellisApp({ config, strings, children, services = realServices }: TrellisAppProps) {
  const [state, dispatch] = useReducer(reduce, { phase: "starting" } as ShellState);
  const merged = useMemo(() => mergeStrings(strings), [strings]);

  useEffect(() => {
    let cancelled = false;
    void boot(services, config, merged).then((event) => !cancelled && dispatch(event));
    return () => {
      cancelled = true;
    };
  }, [services, config, merged]);

  const start = useCallback(
    async (db: Parameters<Flow["start"]>[0], root: FileSystemDirectoryHandle, identity: Parameters<Flow["start"]>[2]): Promise<void> => {
      const result = await services.startHost({ root, db, user: identity.user.id, key: identity.key, keyId: identity.keyId, keys: identity.keys, app: config });
      if (result.ok) void services.loader()?.checkForUpdate(root);
      dispatch({ type: "started", identity, result: result.ok ? withData(result, config, identity.user.id) : result });
    },
    [services, config],
  );
  const flow = useMemo<Flow>(() => ({ config, services, dispatch, start }), [config, services, start]);
  const engine = state.phase === "running" ? state.session.engine : undefined;

  return (
    <ShellProvider engine={engine} strings={strings} onUpdate={engine && services.loader()?.onUpdate}>
      <main id="app-shell" aria-label={config.name} className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
        {state.phase === "starting" && (
          <p id="loading" role="status" className="text-sm">
            {merged.starting}
          </p>
        )}
        {state.phase === "folder" && <FolderStep state={state} flow={flow} />}
        {state.phase === "passport" && <PassportStep state={state} flow={flow} />}
        {state.phase === "unlock" && <UnlockStep key={state.passport.handle.name} state={state} flow={flow} />}
        {state.phase === "already-open" && <AlreadyOpen state={state} flow={flow} />}
        {state.phase === "failed" && <Failed state={state} />}
        {state.phase === "running" && (
          <Running state={state} flow={flow}>
            {children}
          </Running>
        )}
        <p className="text-xs text-muted-foreground">{merged.version(__APP_VERSION__, __BUILT_AT__)}</p>
      </main>
    </ShellProvider>
  );
}

type RunningState = Extract<ShellState, { phase: "running" }>;

function Running({ state, flow, children }: { state: RunningState; flow: Flow; children?: ReactNode }) {
  const { strings } = useShell();
  const { db, root, session } = state;
  const { engine } = session;
  const [inviting, setInviting] = useState(false);

  // Permission lost mid-session: the engine reports the folder disconnected;
  // the banner appears only when the browser no longer grants access.
  useEffect(() => {
    let live = true;
    const check = async (): Promise<void> => {
      const disconnected = engine.health().state === "folder-disconnected";
      const permission = disconnected ? await flow.services.folderPermission(root) : "granted";
      if (live) flow.dispatch({ type: "health", disconnected, permission });
    };
    const stop = engine.on("health", () => void check());
    void check();
    return () => {
      live = false;
      stop();
    };
  }, [engine, root, flow]);

  /** After a key rotation: enrol from the new invite, then restart the engine with the new keys. */
  const replaced = async (identity: Parameters<Flow["start"]>[2]): Promise<void> => {
    await session.stop();
    await flow.start(db, root, identity);
  };

  return (
    <DataProvider data={session.data}>
      <HealthIndicator />
      <ConflictPrompt />
      {state.reconnect !== "none" && <ReconnectBanner state={state} flow={flow} />}
      {children}
      {inviting ? (
        <InviteForm db={db} root={root} flow={flow} onDone={replaced} onCancel={() => setInviting(false)} />
      ) : (
        <Button id="new-invite" variant="outline" className="self-start" onClick={() => setInviting(true)}>
          {strings.newInvite}
        </Button>
      )}
      <p className="text-xs text-muted-foreground">{strings.signedIn(session.user.name, session.deviceId, root.name)}</p>
    </DataProvider>
  );
}

function ReconnectBanner({ state, flow }: { state: RunningState; flow: Flow }) {
  const { strings } = useShell();
  const reconnect = async (): Promise<void> => {
    // Called straight from the click, so the browser may show its prompt.
    const next = await flow.services.regrant(state.root);
    const granted = next.status === "ready";
    flow.dispatch({ type: "regranted", granted, message: granted ? undefined : strings.folderRefused });
    if (granted) void state.session.engine.scan();
  };
  return (
    <section id="reconnect" aria-label={strings.reconnectTitle} className="flex flex-col items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
      <p>{strings.reconnectBanner(state.root.name)}</p>
      {state.reconnect === "needed" ? (
        <Button size="sm" onClick={() => void reconnect()}>
          {strings.reconnect}
        </Button>
      ) : (
        <p>{strings.reconnected}</p>
      )}
      <Message text={state.message} />
    </section>
  );
}
