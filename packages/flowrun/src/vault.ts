import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { defaultVaultPath } from "./paths.js";

export type VaultFile = {
  version: 1;
  kdf: "scrypt";
  salt: string;
  iv: string;
  ciphertext: string;
  meta: { created_at: string; updated_at: string; slot_count: number };
};

export type PassOpts = {
  root: string;
  passphrase?: string;
  vaultPath?: string;
};

const SERVICE = "flowrun";
const TAG_LEN = 16;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
}

function seal(
  slots: Record<string, string>,
  passphrase: string,
  createdAt?: string,
): VaultFile {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(slots), "utf8")),
    cipher.final(),
  ]);
  const now = new Date().toISOString();
  return {
    version: 1,
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    ciphertext: Buffer.concat([enc, cipher.getAuthTag()]).toString("base64"),
    meta: {
      created_at: createdAt ?? now,
      updated_at: now,
      slot_count: Object.keys(slots).length,
    },
  };
}

function open(file: VaultFile, passphrase: string): Record<string, string> {
  if (file.version !== 1 || file.kdf !== "scrypt") {
    throw new Error(`Unsupported vault format version=${file.version}`);
  }
  const salt = Buffer.from(file.salt, "base64");
  const iv = Buffer.from(file.iv, "base64");
  const blob = Buffer.from(file.ciphertext, "base64");
  if (blob.length <= TAG_LEN) throw new Error("Invalid vault ciphertext");
  const key = deriveKey(passphrase, salt);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(blob.subarray(blob.length - TAG_LEN));
    const plain = Buffer.concat([
      decipher.update(blob.subarray(0, blob.length - TAG_LEN)),
      decipher.final(),
    ]);
    const obj = JSON.parse(plain.toString("utf8")) as Record<string, string>;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      throw new Error("Invalid vault payload");
    }
    return obj;
  } catch {
    throw new Error("Vault decrypt failed (wrong passphrase or corrupted file)");
  }
}

function keychainAccount(vaultPath: string): string {
  return crypto.createHash("sha256").update(vaultPath).digest("hex").slice(0, 16);
}

export function keychainAvailable(): boolean {
  if (process.platform === "darwin") return true;
  if (process.platform === "linux") {
    try {
      execFileSync("which", ["secret-tool"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function keychainGet(vaultPath: string): string | null {
  const account = keychainAccount(vaultPath);
  try {
    if (process.platform === "darwin") {
      return execFileSync(
        "security",
        ["find-generic-password", "-a", account, "-s", SERVICE, "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim() || null;
    }
    if (process.platform === "linux") {
      return execFileSync(
        "secret-tool",
        ["lookup", "service", SERVICE, "account", account],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim() || null;
    }
  } catch {
    return null;
  }
  return null;
}

function keychainSet(vaultPath: string, passphrase: string): void {
  const account = keychainAccount(vaultPath);
  if (process.platform === "darwin") {
    try {
      execFileSync(
        "security",
        ["delete-generic-password", "-a", account, "-s", SERVICE],
        { stdio: "ignore" },
      );
    } catch {
      /* none */
    }
    execFileSync(
      "security",
      ["add-generic-password", "-a", account, "-s", SERVICE, "-U", "-w"],
      { input: passphrase, stdio: ["pipe", "ignore", "ignore"] },
    );
    return;
  }
  if (process.platform === "linux") {
    execFileSync(
      "secret-tool",
      ["store", "--label", "flowrun vault", "service", SERVICE, "account", account],
      { input: passphrase, stdio: ["pipe", "ignore", "ignore"] },
    );
    return;
  }
  throw new Error("OS keychain not supported on this platform");
}

export function resolveVaultPath(root: string): string {
  if (process.env.FLOWRUN_VAULT_PATH) {
    return path.normalize(path.resolve(process.env.FLOWRUN_VAULT_PATH));
  }
  return defaultVaultPath(root);
}

function writeFile(vaultPath: string, file: VaultFile): void {
  fs.mkdirSync(path.dirname(vaultPath), { recursive: true });
  const tmp = `${vaultPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  const tmpFd = fs.openSync(tmp, "r");
  fs.fsyncSync(tmpFd);
  fs.closeSync(tmpFd);
  fs.renameSync(tmp, vaultPath);
  try {
    fs.chmodSync(vaultPath, 0o600);
  } catch (e) {
    if (process.platform !== "win32") throw e;
  }
  const dirFd = fs.openSync(path.dirname(vaultPath), "r");
  fs.fsyncSync(dirFd);
  fs.closeSync(dirFd);
}

function readFile(vaultPath: string): VaultFile {
  return JSON.parse(fs.readFileSync(vaultPath, "utf8")) as VaultFile;
}

function passphraseOf(opts: PassOpts): string {
  if (opts.passphrase) return opts.passphrase;
  if (process.env.FLOWRUN_VAULT_PASS) return process.env.FLOWRUN_VAULT_PASS;
  const vp = opts.vaultPath ?? resolveVaultPath(opts.root);
  const fromKc = keychainGet(vp);
  if (fromKc) return fromKc;
  throw new Error(
    "Vault passphrase required. Set FLOWRUN_VAULT_PASS, use keychain (vault unlock --store-keychain), or pass passphrase.",
  );
}

export function initVault(
  opts: PassOpts & { storeKeychain?: boolean },
): string {
  const vaultPath = opts.vaultPath ?? resolveVaultPath(opts.root);
  if (fs.existsSync(vaultPath)) {
    throw new Error(`Vault already exists: ${vaultPath}`);
  }
  const pass = opts.passphrase ?? process.env.FLOWRUN_VAULT_PASS;
  if (!pass) throw new Error("Passphrase required for vault init");
  writeFile(vaultPath, seal({}, pass));
  if (opts.storeKeychain) keychainSet(vaultPath, pass);
  return vaultPath;
}

export function loadSlots(opts: PassOpts): Record<string, string> {
  const vaultPath = opts.vaultPath ?? resolveVaultPath(opts.root);
  if (!fs.existsSync(vaultPath)) {
    throw new Error(`No vault at ${vaultPath}. Run: flowrun vault init`);
  }
  return open(readFile(vaultPath), passphraseOf({ ...opts, vaultPath }));
}

function saveSlots(opts: PassOpts, slots: Record<string, string>): void {
  const vaultPath = opts.vaultPath ?? resolveVaultPath(opts.root);
  const pass = passphraseOf({ ...opts, vaultPath });
  const prev = readFile(vaultPath);
  open(prev, pass);
  writeFile(vaultPath, seal(slots, pass, prev.meta.created_at));
}

export function setSlot(opts: PassOpts & { slot: string; value: string }): void {
  if (!opts.slot?.trim()) throw new Error("slot name required");
  const slots = loadSlots(opts);
  slots[opts.slot] = opts.value;
  saveSlots(opts, slots);
}

export function getSlot(opts: PassOpts & { slot: string }): string {
  const slots = loadSlots(opts);
  if (!(opts.slot in slots)) throw new Error(`Missing vault slot: ${opts.slot}`);
  return slots[opts.slot];
}

export function listSlots(opts: PassOpts): string[] {
  return Object.keys(loadSlots(opts)).sort();
}

export function deleteSlot(opts: PassOpts & { slot: string }): void {
  const slots = loadSlots(opts);
  if (!(opts.slot in slots)) throw new Error(`Missing vault slot: ${opts.slot}`);
  delete slots[opts.slot];
  saveSlots(opts, slots);
}

export function vaultNeeds(
  required: string[],
  have: Record<string, string>,
): string[] {
  return required.filter((s) => !(s in have));
}

export type VaultStatus = {
  path: string;
  exists: boolean;
  source: "encrypted" | "yaml-override" | "none";
  slot_count?: number;
  keychain: boolean;
};

export function vaultStatus(root: string): VaultStatus {
  const kc = keychainAvailable();
  const yamlOverride = process.env.FLOWRUN_VAULT ? path.resolve(process.env.FLOWRUN_VAULT) : "";
  if (yamlOverride && fs.existsSync(yamlOverride)) {
    const data = parseYaml(
      fs.readFileSync(yamlOverride, "utf8"),
    ) as Record<string, string>;
    return {
      path: yamlOverride,
      exists: true,
      source: "yaml-override",
      slot_count: Object.keys(data ?? {}).length,
      keychain: kc,
    };
  }
  const p = resolveVaultPath(root);
  if (!fs.existsSync(p)) {
    return { path: p, exists: false, source: "none", keychain: kc };
  }
  const file = readFile(p);
  return {
    path: p,
    exists: true,
    source: "encrypted",
    slot_count: file.meta?.slot_count,
    keychain: kc,
  };
}

/** Secrets for run/improve/verify. Never logs values. */
export function resolveVault(opts: { root: string; passphrase?: string }): Record<string, string> {
  const yamlOverride = process.env.FLOWRUN_VAULT ? path.resolve(process.env.FLOWRUN_VAULT) : "";
  if (yamlOverride && fs.existsSync(yamlOverride)) {
    const data = parseYaml(
      fs.readFileSync(yamlOverride, "utf8"),
    ) as Record<string, string>;
    return data ?? {};
  }
  const vaultPath = resolveVaultPath(opts.root);
  if (!fs.existsSync(vaultPath)) return {};

  const pass =
    opts.passphrase ??
    process.env.FLOWRUN_VAULT_PASS ??
    keychainGet(vaultPath) ??
    undefined;
  if (!pass) {
    throw new Error(
      `Vault exists at ${vaultPath} but is locked. Set FLOWRUN_VAULT_PASS or: flowrun vault unlock --store-keychain`,
    );
  }
  return open(readFile(vaultPath), pass);
}

export function unlockVault(
  opts: PassOpts & { storeKeychain?: boolean },
): { ok: true; slot_count: number } {
  const slots = loadSlots(opts);
  if (opts.storeKeychain) {
    const vaultPath = opts.vaultPath ?? resolveVaultPath(opts.root);
    keychainSet(vaultPath, passphraseOf({ ...opts, vaultPath }));
  }
  return { ok: true, slot_count: Object.keys(slots).length };
}
