// Tells mounted pull request panels that a workspace's pull request changed, so they resolve it
// again. The header button emits after a git action opens or creates a pull request.
export interface PullRequestChangedEvent {
  readonly directory: string;
}

type Listener = (event: PullRequestChangedEvent) => void;

const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emit(event: PullRequestChangedEvent): void {
  for (const listener of [...listeners]) listener(event);
}
