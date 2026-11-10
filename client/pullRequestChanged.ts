// Tells mounted pull request panels that a workspace's pull request changed, so they resolve it
// again. The Create PR button tells them after it opens or creates one.
type Listener = (directory: string) => void;

const listeners = new Set<Listener>();

export function onPullRequestChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function pullRequestChanged(directory: string): void {
  for (const listener of [...listeners]) listener(directory);
}
