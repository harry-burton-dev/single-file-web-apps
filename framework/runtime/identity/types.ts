// Types for the identity modules, which are plain JavaScript so they run in Node too.

/** What unlock() gives: who the user is and the keys to start the engine with, held in memory only. */
export interface Identity {
  user: { id: string; name: string };
  /** The key id to write with: the workspace's current key. */
  keyId: number;
  key: CryptoKey;
  /** Every key the passport holds, by key id, for reading. Non-extractable. */
  keys: Map<number, CryptoKey>;
}
