// TEST ONLY. A fixed workspace key so every copy of the test page can read the
// same folder. It protects nothing: anyone with this file has the key. Real
// keys come from invite files minted by the admin app (ADR-0003).
const TEST_KEY_SEED = "engine-test-page-key-v1";

export async function testWorkspaceKey(): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(TEST_KEY_SEED));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}
