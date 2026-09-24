// Minimal runtime-agnostic event emitter (works in Node and browsers).

export class Emitter {
  constructor() {
    this.listeners = new Map();
  }

  on(type, listener) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
    return () => this.off(type, listener);
  }

  off(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  once(type, listener) {
    const wrapped = (...args) => {
      this.off(type, wrapped);
      listener(...args);
    };
    return this.on(type, wrapped);
  }

  emit(type, ...args) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(...args);
  }
}
