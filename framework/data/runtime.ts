// The data runtime (spec S2): one object per device that the hooks talk to. It opens
// the configured tables, keeps a view per table, derives the open-conflict list and
// runs commands against the views. Commands are the only write path it offers.
import type { AppDefinition } from "../runtime/definition.ts";
import { openRegistry, type EngineLike, type Identity } from "./registry.ts";
import { createView, type TableView, type Store } from "./view.ts";
import { createConflictStore, type Conflict, type ConflictSink } from "./conflicts.ts";
import { createRunner, type CommandRegistry, type CommandRun, type Runner } from "./commands.ts";

export interface Data {
  readonly tables: readonly string[];
  view(table: string): TableView;
  readonly conflicts: Store<readonly Conflict[]>;
  run: Runner["run"];
  commandLog(): readonly CommandRun[];
  close(): void;
}

export interface DataDeps extends Identity {
  engine: EngineLike & ConflictSink;
  config: AppDefinition;
  /** App commands; defaults to the module-level registry that defineCommand fills. */
  commands?: CommandRegistry;
}

export function createData(deps: DataDeps): Data {
  const { engine, config, commands, ...who } = deps;
  const registry = openRegistry(engine, config, who);
  const views = new Map<string, TableView>(registry.names.map((name) => [name, createView(registry.table(name))]));
  const view = (name: string) => {
    const found = views.get(name);
    if (!found) throw new Error(`unknown table: ${name}`);
    return found;
  };
  const conflicts = createConflictStore(views, engine);
  // Flushing the written views makes a run notify screens before it returns.
  const runner = createRunner({ registry, who, commands, source: view, onApplied: (tables) => tables.forEach((t) => view(t).flush()) });
  return {
    tables: registry.names,
    view,
    conflicts,
    run: runner.run,
    commandLog: runner.log,
    close() {
      conflicts.close();
      for (const v of views.values()) v.close();
    },
  };
}
