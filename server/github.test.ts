import test from "node:test";
import assert from "node:assert/strict";
import { parseRemoteUrl } from "./github.ts";
import { redactError } from "./process.ts";

test("remote URLs support SSH, SCP, HTTPS and Enterprise without treating local paths as remotes", () => {
  for (const url of ["git@github.com:owner/repo.git", "https://github.com/owner/repo.git", "ssh://git@github.com/owner/repo.git"]) assert.deepEqual(parseRemoteUrl(url), { host: "github.com", repository: "owner/repo" });
  assert.deepEqual(parseRemoteUrl("ssh://git@git.example.com:2222/owner/repo.git"), { host: "git.example.com", repository: "owner/repo" });
  for (const url of ["/tmp/repo", "file:///tmp/repo", "https://github.com/../repo", "git@gitlab.com:owner/repo.git"]) assert.equal(parseRemoteUrl(url), null);
});
test("error sanitization removes tokens and URL credentials", () => {
  assert.equal(redactError("ghp_abcdef Authorization: bearer secret https://u:p@github.com/x"), "[redacted] Authorization: bearer [redacted] https://[redacted]@github.com/x");
});
