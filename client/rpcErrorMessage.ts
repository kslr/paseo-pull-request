// Paseo's DaemonClient wraps a handler's message as
// "Request failed: MESSAGE requestType=plugin.rpc.invoke.request code=handler_error".
export function rpcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Request failed: /, "").replace(/ requestType=\S+ code=\S+$/, "");
}
