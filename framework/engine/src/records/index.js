// Record layer entry point (ADR-0002).
//   const table = openTable({ adapterName, adapter, doc, schema, deviceId, user, clock, migrations });
// adapterName is optional and must be "yjs" (the only CRDT library); doc is a Y.Doc.
import { createTable } from "./table.js";
import { createYjsBackend } from "./yjs-backend.js";

export { makeId, newId } from "./ids.js";

export function openTable({ adapterName = "yjs", adapter, doc, schema, deviceId, user, clock, migrations }) {
  if (!schema || typeof schema.version !== "number") throw new TypeError("schema.version is required");
  if (adapterName !== "yjs") throw new TypeError(`unsupported adapter: ${adapterName} (only "yjs" is supported)`);
  return createTable({ backend: createYjsBackend({ doc }), schema, deviceId, user, clock, migrations });
}
