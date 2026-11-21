// Passports (plan 3.7). Enrol once: open the admin's invite and re-seal its
// keyring under the user's own passphrase. Unlock on every launch: open the
// passport, check it against workspace.json, and import the keys as
// non-extractable CryptoKeys held in memory only (decisions D4 to D6).
import { openKeyFile, sealKeyFile } from "./keyfile.js";
import { checkKeyring } from "./workspace.js";

const MESSAGES = {
  "other-workspace": "This passport is for a different workspace.",
  "out-of-date": "Your passport is out of date. Ask the admin for a new invite.",
  "no-workspace": "This folder has no workspace yet. Ask the admin to create one.",
  "bad-workspace": "The workspace file in this folder is damaged. Ask the admin to check it.",
};

export class PassportError extends Error {
  constructor(code) {
    super(MESSAGES[code]);
    this.name = "PassportError";
    this.code = code;
  }
}

/** Returns { passportText, fileName, user }. The invite can be thrown away afterwards. */
export async function enrol({ inviteText, invitePassphrase, newPassphrase, random }) {
  const payload = await openKeyFile({ text: inviteText, passphrase: invitePassphrase, kind: "invite" });
  try {
    const passportText = await sealKeyFile({ kind: "passport", payload, passphrase: newPassphrase, random });
    return { passportText, fileName: `${payload.user.id}.passport.json`, user: payload.user };
  } finally {
    for (const k of payload.keys) k.raw.fill(0);
  }
}

/** Returns an Identity: { user, keyId, key, keys }. workspaceText is null when the folder has no workspace.json. */
export async function unlock({ passportText, passphrase, workspaceText }) {
  const keyring = await openKeyFile({ text: passportText, passphrase, kind: "passport" });
  try {
    if (workspaceText == null) throw new PassportError("no-workspace");
    const status = await checkKeyring(keyring, workspaceText);
    if (status === "bad-file") throw new PassportError("bad-workspace");
    if (status !== "ok") throw new PassportError(status);
    const keys = new Map();
    for (const { id, raw } of keyring.keys) keys.set(id, await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
    return { user: keyring.user, keyId: keyring.current, key: keys.get(keyring.current), keys };
  } finally {
    for (const k of keyring.keys) k.raw.fill(0);
  }
}
