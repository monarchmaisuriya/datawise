import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { paseoHome } from "./paseo-home";

const PLUGIN_ID = "datawise";
let driverRoot: string | null = null;

// Only the test bed calls this. It has no Paseo daemon to ask.
export function setDriverRoot(root: string): void {
  driverRoot = root;
}

function isThisPlugin(directory: string): boolean {
  try {
    return (JSON.parse(readFileSync(join(directory, "paseo-plugin.json"), "utf8")) as { id?: string }).id === PLUGIN_ID;
  } catch {
    return false;
  }
}

async function findPluginDirectory(): Promise<string> {
  const home = await paseoHome();
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { plugins?: Record<string, { path?: string }> };
  for (const entry of Object.values(config.plugins ?? {})) {
    if (entry?.path && isThisPlugin(entry.path) && existsSync(join(entry.path, "node_modules"))) return entry.path;
  }
  throw new Error("Could not find the Datawise plugin folder in Paseo's config. This Paseo version may store plugins differently.");
}

// Drivers are never bundled. Paseo's compiler breaks some of them and takes half a minute on the rest,
// so each loads from the plugin's own node_modules on first use, and only the engines in use load.
export async function loadDriver<T>(name: string): Promise<T> {
  driverRoot ??= await findPluginDirectory();
  return createRequire(join(driverRoot, "package.json"))(name) as T;
}
