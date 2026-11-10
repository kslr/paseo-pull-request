// Reads grouped by what they read, a pull request or a checkout: each kept for its time to live,
// shared while in flight, and dropped together. A read in flight when its group is dropped settles into the dropped group, so it cannot
// bring old data back.
interface Entry { value: Promise<unknown>; expires: number }

export class ReadCache {
  private groups = new Map<string, Map<string, Entry>>();

  read<T>(group: string, name: string, ttl: number, load: () => Promise<T>): Promise<T> {
    let entries = this.groups.get(group);
    if (!entries) this.groups.set(group, entries = new Map());
    const hit = entries.get(name);
    if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;
    const entry: Entry = { value: load(), expires: Infinity };
    const owner = entries;
    owner.set(name, entry);
    // The time to live runs from the answer; a failure is not kept.
    entry.value.then(() => { entry.expires = Date.now() + ttl; }, () => { if (owner.get(name) === entry) owner.delete(name); });
    return entry.value as Promise<T>;
  }
  drop(group: string) { this.groups.delete(group); }
}
