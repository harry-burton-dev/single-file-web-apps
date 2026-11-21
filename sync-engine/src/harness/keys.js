// One fixed AES-GCM key shared by every simulated device, so runs are
// deterministic. KEY_ID is the envelope key id the harness uses.
export const KEY_ID = 1;
const RAW = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);

export function importFixedKey() {
  return globalThis.crypto.subtle.importKey("raw", RAW, "AES-GCM", false, ["encrypt", "decrypt"]);
}
