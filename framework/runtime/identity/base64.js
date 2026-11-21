// Strict base64 for the key file formats. atob alone accepts whitespace and
// missing padding; these files are machine-written, so anything else is damage.
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function toBase64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Returns null for anything that is not canonical base64. */
export function fromBase64(text) {
  if (typeof text !== "string" || !B64.test(text)) return null;
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
