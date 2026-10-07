type Listener<T> = (detail: T) => void;

export class Emitter<Events extends object> {
  readonly #listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(type: K, listener: Listener<Events[K]>): () => void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener as Listener<never>);
    return () => set.delete(listener as Listener<never>);
  }

  emit<K extends keyof Events>(type: K, detail: Events[K]): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])])
      (listener as Listener<Events[K]>)(detail);
  }
}
