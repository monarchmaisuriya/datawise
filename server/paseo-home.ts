import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The plugin API offers no data folder, so resolve PASEO_HOME the way the daemon does. The plugin
// process is started from a script inside @getpaseo/server, which makes that package resolvable.
export async function paseoHome(): Promise<string> {
  const requireFromDaemon = createRequire(process.argv[1] ?? process.cwd());
  const daemonControl: unknown = await import(pathToFileURL(requireFromDaemon.resolve("@getpaseo/server/daemon-control")).href);
  const resolveHome: unknown = Reflect.get(Object(daemonControl), "resolvePaseoHome");
  if (typeof resolveHome !== "function") throw new Error("@getpaseo/server/daemon-control has no resolvePaseoHome; this Paseo version is not supported");
  const home: unknown = resolveHome();
  if (typeof home !== "string" || home === "") throw new Error("Paseo returned no home directory");
  return home;
}

export async function dataFolder(): Promise<string> {
  return join(await paseoHome(), "plugin-data", "datawise");
}
