// Names the feature branch a run cuts from the default branch: the generated name as a valid ref,
// under feature/ unless it names its own prefix, made unique among the existing branches.
const MAX_SLUG = 64;
const trimSeparators = (value: string) => value.replace(/^[/_-]+|[/_-]+$/g, "");

// Lowercase letters, digits, "_", "-" and single slashes; anything else becomes one hyphen.
function slug(raw: string) {
  const collapsed = raw.toLowerCase().replace(/['"`]/g, "").replace(/[^a-z0-9/_-]+/g, "-").replace(/\/{2,}/g, "/").replace(/-{2,}/g, "-");
  return trimSeparators(trimSeparators(collapsed).slice(0, MAX_SLUG)) || "update";
}

export function featureBranchName(existingBranches: readonly string[], preferred = ""): string {
  // Ref names are compared as case-insensitive file systems would store them.
  const existing = existingBranches.map(name => name.toLowerCase()), taken = new Set(existing);
  const name = slug(preferred);
  const segments = name.includes("/") ? name.split("/") : ["feature", name];
  // Every level must be free of a branch of that name; the last must not be a directory of branches.
  return segments.reduce((parent, segment, index) => {
    const isLeaf = index === segments.length - 1, base = parent ? `${parent}/${segment}` : segment;
    const free = (candidate: string) => !taken.has(candidate) && !(isLeaf && existing.some(branch => branch.startsWith(`${candidate}/`)));
    let candidate = base;
    for (let suffix = 2; !free(candidate); suffix++) candidate = `${base}-${suffix}`;
    return candidate;
  }, "");
}
