import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { CABINET_HOME, appVersionDir, ensureCabinetHome } from "./paths.js";
import { log, success } from "./log.js";
import { fetchReleaseManifest, resolveAppBundle } from "./release-manifest.js";

function hasProductionRuntime(appDir: string): boolean {
  return (
    fs.existsSync(path.join(appDir, "server.js")) &&
    fs.existsSync(path.join(appDir, "server", "cabinet-daemon.cjs")) &&
    fs.existsSync(path.join(appDir, ".next", "static")) &&
    fs.existsSync(path.join(appDir, ".native", "node-pty", "package.json"))
  );
}

export function isAppInstalled(version: string): boolean {
  return hasProductionRuntime(appVersionDir(version));
}

export function getAppDir(version: string): string | null {
  if (!isAppInstalled(version)) return null;
  return appVersionDir(version);
}

async function downloadAndExtractBundle(appDir: string, bundleUrl: string): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-app-"));
  const archivePath = path.join(tempDir, "cabinet-app.tgz");

  try {
    log(`Downloading app bundle from ${bundleUrl}...`);
    const response = await fetch(bundleUrl, {
      headers: { "user-agent": "cabinetai" },
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      throw new Error(`App bundle request failed (${response.status})`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(archivePath, bytes);

    fs.rmSync(appDir, { recursive: true, force: true });
    fs.mkdirSync(appDir, { recursive: true });

    const result = spawnSync("tar", ["-xzf", archivePath, "-C", appDir, "--no-same-owner"], {
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw new Error("Failed to extract app bundle");
    }

    if (!hasProductionRuntime(appDir)) {
      throw new Error("App bundle did not include server.js");
    }
  } catch (err) {
    fs.rmSync(appDir, { recursive: true, force: true });
    throw err;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function ensureApp(version: string): Promise<string> {
  ensureCabinetHome();

  const appDir = appVersionDir(version);
  if (isAppInstalled(version)) {
    return appDir;
  }

  log(`Installing Cabinet v${version}...`);
  const manifest = await fetchReleaseManifest(version);
  if (!manifest) {
    throw new Error("Could not fetch release manifest");
  }

  const bundle = resolveAppBundle(manifest);
  if (!bundle) {
    throw new Error(`No prebuilt app bundle available for ${process.platform}/${process.arch}`);
  }

  await downloadAndExtractBundle(appDir, bundle.url);
  success(`Cabinet v${version} installed.`);
  return appDir;
}

export function listInstalledVersions(): string[] {
  const appParent = path.join(CABINET_HOME, "app");
  if (!fs.existsSync(appParent)) return [];

  return fs
    .readdirSync(appParent, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("v"))
    .map((e) => e.name.slice(1))
    .sort();
}
