import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  deleteSlot,
  getSlot,
  initVault,
  listSlots,
  loadSlots,
  resolveVault,
  resolveVaultPath,
  setSlot,
  unlockVault,
  vaultNeeds,
  vaultStatus,
} from "../src/vault.ts";

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowrun-vault-"));
  fs.mkdirSync(path.join(root, "library"));
  fs.mkdirSync(path.join(root, "sites"));
  return root;
}

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    const v = env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test("seal roundtrip via init/set/get", () => {
  const root = tmpRoot();
  withEnv({ FLOWRUN_VAULT: undefined, FLOWRUN_VAULT_PASS: undefined }, () => {
    const p = initVault({ root, passphrase: "pass-one" });
    assert.ok(fs.existsSync(p));
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    }
    setSlot({ root, passphrase: "pass-one", slot: "sites.gh.password", value: "s3cret" });
    assert.deepEqual(listSlots({ root, passphrase: "pass-one" }), [
      "sites.gh.password",
    ]);
    assert.equal(
      getSlot({ root, passphrase: "pass-one", slot: "sites.gh.password" }),
      "s3cret",
    );
    deleteSlot({ root, passphrase: "pass-one", slot: "sites.gh.password" });
    assert.deepEqual(listSlots({ root, passphrase: "pass-one" }), []);
  });
});

test("wrong passphrase fails", () => {
  const root = tmpRoot();
  initVault({ root, passphrase: "right" });
  assert.throws(
    () => loadSlots({ root, passphrase: "wrong" }),
    /passphrase|decrypt|failed/i,
  );
});

test("resolveVault prefers FLOWRUN_VAULT yaml", () => {
  const root = tmpRoot();
  const yamlPath = path.join(root, "plain.yaml");
  fs.writeFileSync(yamlPath, "sites.x.password: from-yaml\n");
  withEnv({ FLOWRUN_VAULT: yamlPath }, () => {
    assert.equal(resolveVault({ root })["sites.x.password"], "from-yaml");
  });
});

test("resolveVault uses FLOWRUN_VAULT_PASS", () => {
  const root = tmpRoot();
  initVault({ root, passphrase: "env-pass" });
  setSlot({ root, passphrase: "env-pass", slot: "a", value: "1" });
  withEnv({ FLOWRUN_VAULT: undefined, FLOWRUN_VAULT_PASS: "env-pass" }, () => {
    assert.equal(resolveVault({ root }).a, "1");
  });
});

test("resolveVault empty when no vault file", () => {
  const root = tmpRoot();
  withEnv({ FLOWRUN_VAULT: undefined, FLOWRUN_VAULT_PASS: undefined }, () => {
    assert.deepEqual(resolveVault({ root }), {});
  });
});

test("vaultNeeds reports missing only", () => {
  assert.deepEqual(
    vaultNeeds(["sites.gh.password", "sites.gh.user"], {
      "sites.gh.user": "u",
    }),
    ["sites.gh.password"],
  );
});

test("status reads meta without passphrase", () => {
  const root = tmpRoot();
  initVault({ root, passphrase: "p" });
  setSlot({ root, passphrase: "p", slot: "a", value: "1" });
  withEnv({ FLOWRUN_VAULT: undefined }, () => {
    const s = vaultStatus(root);
    assert.equal(s.exists, true);
    assert.equal(s.path, resolveVaultPath(root));
    assert.equal(s.source, "encrypted");
    assert.equal(s.slot_count, 1);
  });
});

test("unlock verifies passphrase", () => {
  const root = tmpRoot();
  initVault({ root, passphrase: "p" });
  const r = unlockVault({ root, passphrase: "p" });
  assert.equal(r.ok, true);
  assert.equal(r.slot_count, 0);
});

test("CLI vault init set list status", () => {
  const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cli = path.join(pkg, "dist", "cli.js");
  if (!fs.existsSync(cli)) {
    spawnSync("npm", ["run", "build"], { cwd: pkg, encoding: "utf8" });
    assert.ok(fs.existsSync(cli), "dist/cli.js missing after build");
  }

  const root = tmpRoot();
  const env = {
    ...process.env,
    FLOWRUN_ROOT: root,
    FLOWRUN_VAULT_PASS: "cli-pass",
  };
  delete env.FLOWRUN_VAULT;

  let r = spawnSync(process.execPath, [cli, "vault", "init"], {
    encoding: "utf8",
    env,
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);

  r = spawnSync(
    process.execPath,
    [cli, "vault", "set", "sites.demo.password", "secret"],
    { encoding: "utf8", env },
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);

  r = spawnSync(process.execPath, [cli, "vault", "list"], {
    encoding: "utf8",
    env,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /sites\.demo\.password/);

  r = spawnSync(process.execPath, [cli, "vault", "status"], {
    encoding: "utf8",
    env,
  });
  assert.equal(r.status, 0, r.stderr);
  const status = JSON.parse(r.stdout);
  assert.equal(status.exists, true);
  assert.equal(status.slot_count, 1);
});
