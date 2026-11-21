// A device's local view of the folder: a tree of directory nodes holding file
// nodes. Paths are strings with forward slashes; "" is the root.
//
//   directory node: { kind: "directory", children: Map<name, node> }
//   file node:      { kind: "file", bytes, modifiedAt, version, ... }
//
// File nodes are replaced, never mutated in place (except the partial-arrival
// completion), and `bytes` arrays are never modified once stored.

export function createTree() {
  return { kind: "directory", children: new Map() };
}

export const splitPath = (path) => (path === "" ? [] : path.split("/"));
export const joinPath = (dir, name) => (dir === "" ? name : `${dir}/${name}`);

export function parentPath(path) {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

export function getNode(root, path) {
  let node = root;
  for (const segment of splitPath(path)) {
    if (node.kind !== "directory") return undefined;
    node = node.children.get(segment);
    if (!node) return undefined;
  }
  return node;
}

// Cloud wins on a file/directory clash: an existing file in the way is replaced.
export function ensureDirectory(root, path) {
  let node = root;
  for (const segment of splitPath(path)) {
    let child = node.children.get(segment);
    if (!child || child.kind !== "directory") {
      child = createTree();
      node.children.set(segment, child);
    }
    node = child;
  }
  return node;
}

export function putFile(root, path, fileNode) {
  ensureDirectory(root, parentPath(path)).children.set(baseName(path), fileNode);
}

export function removeNode(root, path) {
  const parent = getNode(root, parentPath(path));
  if (!parent || parent.kind !== "directory") return undefined;
  const name = baseName(path);
  const node = parent.children.get(name);
  parent.children.delete(name);
  return node;
}

// Depth-first, children in name order, yielding [path, fileNode].
export function* walkFiles(node, prefix = "") {
  const names = [...node.children.keys()].sort();
  for (const name of names) {
    const child = node.children.get(name);
    const childPath = joinPath(prefix, name);
    if (child.kind === "file") yield [childPath, child];
    else yield* walkFiles(child, childPath);
  }
}
