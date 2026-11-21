// Directory and file handles (spec section 2.2) over one device's local view.
//
// `device` is { tree, ops }. The tree is read through `device.tree` at call
// time (wipeFolder swaps it). `ops` is supplied by the world and performs the
// side effects that need the clock, the fault streams and the event queue:
//   createFile(path), removeFile(path), beginWrite(path) -> swap,
//   finishWrite(path, swap, bytes), abortWrite(swap),
//   readFault(path, node, kind), countRead(kind, size)

import { baseName, getNode, joinPath, ensureDirectory, walkFiles, removeNode } from "./tree.js";
import { fsError, invalidName, notFound, typeMismatch } from "./errors.js";

const textEncoder = new TextEncoder();

function assertName(name) {
  if (typeof name !== "string" || name === "" || name === "." || name === ".." || name.includes("/")) {
    throw invalidName(name);
  }
}

function toBytes(data) {
  if (typeof data === "string") return textEncoder.encode(data);
  if (data instanceof Uint8Array) return data.slice();
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  throw fsError("TypeError", "write() takes a Uint8Array, ArrayBuffer or string");
}

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function createWritable(device, path) {
  const swap = device.ops.beginWrite(path);
  const chunks = [];
  let state = "open";
  const assertOpen = () => {
    if (state !== "open") throw fsError("TypeError", `writable is ${state}`);
  };
  return {
    async write(data) {
      assertOpen();
      chunks.push(toBytes(data));
    },
    async close() {
      assertOpen();
      state = "closed";
      device.ops.finishWrite(path, swap, concat(chunks));
    },
    async abort() {
      if (state !== "open") return;
      state = "aborted";
      device.ops.abortWrite(swap);
    },
  };
}

function createFileHandle(device, path) {
  const name = baseName(path);
  const currentNode = () => {
    const node = getNode(device.tree, path);
    if (!node) throw notFound(path);
    if (node.kind !== "file") throw typeMismatch(path);
    return node;
  };
  return {
    kind: "file",
    name,
    async getFile() {
      const node = currentNode();
      device.ops.readFault(path, node, "getFile");
      const bytes = node.bytes; // snapshot: node.bytes is never mutated in place
      device.ops.countRead("getFile", 0);
      return {
        name,
        size: bytes.length,
        lastModified: node.modifiedAt,
        async arrayBuffer() {
          device.ops.readFault(path, node, "arrayBuffer");
          device.ops.countRead("arrayBuffer", bytes.length);
          return bytes.slice().buffer;
        },
      };
    },
    async createWritable() {
      currentNode();
      return createWritable(device, path);
    },
  };
}

export function createDirectoryHandle(device, path = "", name = "") {
  const currentDir = () => {
    const node = getNode(device.tree, path);
    if (!node) throw notFound(path || "root");
    if (node.kind !== "directory") throw typeMismatch(path);
    return node;
  };

  function* listing() {
    const dir = currentDir();
    for (const childName of [...dir.children.keys()].sort()) {
      const child = dir.children.get(childName);
      const childPath = joinPath(path, childName);
      yield [
        childName,
        child.kind === "directory"
          ? createDirectoryHandle(device, childPath, childName)
          : createFileHandle(device, childPath),
      ];
    }
  }

  return {
    kind: "directory",
    name,
    async getDirectoryHandle(childName, { create = false } = {}) {
      assertName(childName);
      const child = currentDir().children.get(childName);
      const childPath = joinPath(path, childName);
      if (child) {
        if (child.kind !== "directory") throw typeMismatch(childPath);
      } else if (create) {
        ensureDirectory(device.tree, childPath);
      } else {
        throw notFound(childPath);
      }
      return createDirectoryHandle(device, childPath, childName);
    },
    async getFileHandle(childName, { create = false } = {}) {
      assertName(childName);
      const child = currentDir().children.get(childName);
      const childPath = joinPath(path, childName);
      if (child) {
        if (child.kind !== "file") throw typeMismatch(childPath);
      } else if (create) {
        device.ops.createFile(childPath);
      } else {
        throw notFound(childPath);
      }
      return createFileHandle(device, childPath);
    },
    async removeEntry(childName, { recursive = false } = {}) {
      assertName(childName);
      const child = currentDir().children.get(childName);
      const childPath = joinPath(path, childName);
      if (!child) throw notFound(childPath);
      if (child.kind === "file") {
        device.ops.removeFile(childPath);
        return;
      }
      if (child.children.size && !recursive) {
        throw fsError("InvalidModificationError", `${childPath} is not empty`);
      }
      for (const [filePath] of [...walkFiles(child, childPath)]) device.ops.removeFile(filePath);
      removeNode(device.tree, childPath);
    },
    async *entries() {
      yield* listing();
    },
    async *keys() {
      for (const [childName] of listing()) yield childName;
    },
    async *values() {
      for (const [, handle] of listing()) yield handle;
    },
    [Symbol.asyncIterator]() {
      return this.entries();
    },
  };
}
