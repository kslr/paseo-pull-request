// Runs git, gh and claude for the daemon, with credentials redacted from every error message.
import { execFile } from "node:child_process";

export interface CommandOptions { cwd: string; input?: string; timeout?: number; signal?: AbortSignal; onOutputLine?: (line: string) => void }
export interface CommandResult { stdout: string; stderr: string }
export type Runner = (file: string, args: string[], options: CommandOptions) => Promise<CommandResult>;
export class CommandError extends Error {
  code: string | number | undefined;
  constructor(message: string, code?: string | number) { super(redactError(message)); this.code = code; }
}
// A command that ran and failed, rather than one cancelled with its run.
export const commandFailed = (error: unknown) => error instanceof CommandError && error.code !== "ABORT_ERR";
export function redactError(message: string) {
  return message.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[redacted]")
    .replace(/(authorization:\s*(?:bearer|token)\s+)\S+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@");
}
export const runCommand: Runner = (file, args, options) => new Promise((resolve, reject) => {
  const child = execFile(file, args, { cwd: options.cwd, timeout: options.timeout ?? 60_000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8", signal: options.signal, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
    if (error) reject(new CommandError(String(stderr).trim() || (error.killed ? `${file} exceeded its time limit.` : error.message), error.code ?? undefined));
    else resolve({ stdout, stderr });
  });
  if (options.onOutputLine) {
    for (const stream of [child.stdout, child.stderr]) {
      let pending = "";
      stream?.on("data", (chunk: string) => {
        const lines = (pending + chunk).split(/\r\n|[\r\n]/);
        pending = lines.pop()!;
        for (const line of lines) if (line.trim()) options.onOutputLine!(line);
      });
      stream?.on("end", () => { if (pending.trim()) options.onOutputLine!(pending); });
    }
  }
  child.stdin?.on("error", () => { /* Process completion reports early stdin closure. */ });
  child.stdin?.end(options.input);
});
