// Create the release signing key pair (ECDSA P-256), printed as two JSON
// lines. Run once: `npm run keygen`. Store the first line as the
// GitHub Actions variable TRELLIS_PUBLIC_KEY and the second as the secret
// TRELLIS_SIGNING_KEY, keep a backup of the second somewhere safe, and never
// commit it. Whoever holds the private key can ship code to every colleague.
import { webcrypto } from "node:crypto";

const { subtle } = webcrypto;
const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
console.log(`TRELLIS_PUBLIC_KEY=${JSON.stringify(await subtle.exportKey("jwk", pair.publicKey))}`);
console.log(`TRELLIS_SIGNING_KEY=${JSON.stringify(await subtle.exportKey("jwk", pair.privateKey))}`);
