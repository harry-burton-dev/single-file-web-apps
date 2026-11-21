// Shared helpers for simulator tests: path based read/write over handles.
import { createWorld } from "../../src/sim/world.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const bytesOf = (text) => encoder.encode(text);
export const textOf = (bytes) => decoder.decode(bytes);

async function directoryFor(root, dirPath, create) {
  let dir = root;
  for (const segment of dirPath === "" ? [] : dirPath.split("/")) {
    dir = await dir.getDirectoryHandle(segment, { create });
  }
  return dir;
}

const splitFile = (path) => {
  const slash = path.lastIndexOf("/");
  return [slash < 0 ? "" : path.slice(0, slash), path.slice(slash + 1)];
};

export async function writeFile(device, path, content) {
  const [dirPath, name] = splitFile(path);
  const dir = await directoryFor(device.root, dirPath, true);
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(typeof content === "string" ? bytesOf(content) : content);
  await writable.close();
}

export async function readFile(device, path) {
  const [dirPath, name] = splitFile(path);
  const dir = await directoryFor(device.root, dirPath, false);
  const file = await (await dir.getFileHandle(name)).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

export async function removeFile(device, path) {
  const [dirPath, name] = splitFile(path);
  const dir = await directoryFor(device.root, dirPath, false);
  await dir.removeEntry(name);
}

// Returns undefined when `promise` rejects with an error named `name`,
// otherwise a description of what happened (for use with assert.equal).
export async function rejectsWithName(promise, name) {
  try {
    await promise;
  } catch (error) {
    return error.name === name ? undefined : `expected ${name}, got ${error.name}: ${error.message}`;
  }
  return `expected ${name}, but it resolved`;
}

export function textMap(map) {
  return Object.fromEntries([...map].map(([path, bytes]) => [path, textOf(bytes)]));
}

export function newWorld(options = {}) {
  const world = createWorld({ seed: "test", ...options });
  const a = world.addDevice("alice-aaaaaaaa");
  const b = world.addDevice("bob-bbbbbbbb");
  return { world, a, b };
}
