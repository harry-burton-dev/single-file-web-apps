import { runAdapterContract } from "./contract.js";
import { yjsAdapter } from "../../src/adapters/yjs.js";

runAdapterContract("yjs", () => yjsAdapter, {
  set: (a, doc, key, value) => doc.transact(() => doc.getMap("records").set(key, value)),
});
