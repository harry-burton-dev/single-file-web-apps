// A keyring made by hand (plan 3.2), standing in for admin.js until OUT-9
// builds newKeyring. Not a test file.
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function handMadeKeyring(random, ids = [1]) {
  const workspace = Array.from(random.bytes(16), (b) => ALPHABET[b % ALPHABET.length]).join("");
  return { workspace, current: Math.max(...ids), keys: ids.map((id) => ({ id, raw: random.bytes(32) })) };
}
