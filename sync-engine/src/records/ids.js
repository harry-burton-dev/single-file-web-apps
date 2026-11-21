// Record ids. Deterministic ids (makeId) make two devices that perform "the
// same" action land on one record; random ids (newId) are the default.
import { SEP } from "./keys.js";

export function makeId(...parts) {
  if (parts.length === 0) throw new TypeError("makeId needs at least one part");
  for (const part of parts) {
    if (part === undefined || part === null || part === "") throw new TypeError("makeId parts must be non-empty");
    if (String(part).includes(SEP)) throw new TypeError("makeId parts must not contain U+001F");
  }
  return parts.join(":");
}

// random: { bytes(n) } (the injected randomness of the engine). 64 random bits.
export function newId(random) {
  const bytes = random.bytes(8);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
