import type { PluginServerContext } from "@getpaseo/plugin/server";
import { contributeServer } from "./server/plugin";

export default function contribute(server: PluginServerContext) {
  if (!server.features?.adaptiveAgentFeatures) throw new Error("Update the Paseo host to a version with adaptive agent features before loading Datawise.");
  return contributeServer(server);
}
