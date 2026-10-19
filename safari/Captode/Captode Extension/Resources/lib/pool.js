// A small pool of module workers. Tasks go to whichever worker is free; results
// come back as promises.

export class WorkerPool {
  /** `url`: the worker script; `size`: how many workers (defaults to cores − 1, 1–4). */
  constructor(url, size = Math.max(1, Math.min(4, (self.navigator?.hardwareConcurrency || 2) - 1))) {
    this.workers = Array.from({ length: size }, () => {
      const w = new Worker(url, { type: 'module' });
      w.busy = 0;
      w.onmessage = ({ data }) => {
        const task = this.pending.get(data.id);
        if (!task) return;
        this.pending.delete(data.id);
        w.busy--;
        if (data.error) task.reject(new Error(data.error));
        else task.resolve(data.result);
      };
      w.onerror = (e) => {
        for (const [id, task] of this.pending) if (task.worker === w) { this.pending.delete(id); task.reject(new Error(e.message || 'Worker failed')); }
      };
      return w;
    });
    this.pending = new Map();
    this.nextId = 1;
  }

  /** Sends `msg` (plus `transfer`) to the least busy worker. */
  run(msg, transfer = []) {
    const w = this.workers.reduce((a, b) => (b.busy < a.busy ? b : a));
    const id = this.nextId++;
    w.busy++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, worker: w });
      w.postMessage({ ...msg, id }, transfer);
    });
  }

  /** Sends `msg` to every worker (for shared setup); resolves when all have it. */
  broadcast(msg) {
    return Promise.all(this.workers.map((w) => {
      const id = this.nextId++;
      w.busy++;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject, worker: w });
        w.postMessage({ ...msg, id });
      });
    }));
  }

  /** Tasks waiting or running. */
  get load() { return this.pending.size; }

  close() {
    for (const w of this.workers) w.terminate();
    for (const task of this.pending.values()) task.reject(new Error('cancelled'));
    this.pending.clear();
  }
}
