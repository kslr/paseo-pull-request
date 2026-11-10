// The daemon API types, taken from the plugin SDK. Plugins installed from a source checkout get
// only the host's modules, so these are derived from it instead of importing @getpaseo/client.
import type { PluginHandlerContext } from "@getpaseo/plugin/server";

export type PaseoApi = PluginHandlerContext["paseo"];
export type PaseoAgentCreateOptions = Parameters<PaseoApi["agents"]["create"]>[0];
export type PaseoAgentConfig = PaseoAgentCreateOptions["config"];
export type PaseoAgentHandle = Awaited<ReturnType<PaseoApi["agents"]["create"]>>;
export type PaseoAgentRunResult = Awaited<ReturnType<PaseoAgentHandle["waitForFinish"]>>;
