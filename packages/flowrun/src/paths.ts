import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root with library/ + sites/ (packages/flowrun/dist → ../../..) */
export function defaultRoot(): string {
  const fromEnv = process.env.FLOWRUN_ROOT;
  if (fromEnv && fs.existsSync(fromEnv)) return path.resolve(fromEnv);

  const candidates = [
    path.resolve(here, "../../.."),
    path.resolve(process.cwd()),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "../.."),
  ];
  for (const c of candidates) {
    if (
      fs.existsSync(path.join(c, "library")) &&
      fs.existsSync(path.join(c, "sites"))
    ) {
      return c;
    }
  }
  return path.resolve(here, "../../..");
}

export function libraryDirs(root: string) {
  return {
    local: path.join(root, "library", "local"),
    seed: path.join(root, "library", "seed"),
    sites: path.join(root, "sites"),
    traces: path.join(root, "traces"),
  };
}

export function defaultVaultPath(root: string): string {
  return path.join(root, ".flowrun", "vault.enc");
}
