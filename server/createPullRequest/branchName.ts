// Names the feature branch a run cuts from the default branch: the generated name as a valid ref
// under feature/, made unique among the existing branches.
function sanitizeBranchFragment(raw: string): string {
  const fragment = raw
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/^[./\s_-]+|[./\s_-]+$/g, "")
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");
  return fragment || "update";
}

export function featureBranchName(existingBranches: readonly string[], preferred = ""): string {
  const sanitized = sanitizeBranchFragment(preferred.trim() || "update");
  const parts = (sanitized.includes("/") ? sanitized : `feature/${sanitized}`).split("/");
  const existing = existingBranches.map(name => name.toLowerCase());
  const taken = new Set(existing);
  let resolved = "";
  // A name can neither be a branch already nor sit where one is a directory, at any level.
  for (const [index, part] of parts.entries()) {
    const base = resolved ? `${resolved}/${part}` : part;
    let candidate = base;
    for (let suffix = 2; taken.has(candidate) || (index === parts.length - 1 && existing.some(name => name.startsWith(`${candidate}/`))); suffix++) candidate = `${base}-${suffix}`;
    resolved = candidate;
  }
  return resolved;
}
