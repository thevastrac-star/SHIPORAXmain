// utils/shippingQueue.js — Shipping Queue Worker
// Architecture: Client → API → DB → Queue → Worker → Courier API → DB → UI
//
// In-process queue (no Redis required). Jobs are processed by a background worker.
// For production scale, swap the in-memory queue for Bull/BullMQ + Redis.

const EventEmitter = require('events');

class ShippingQueue extends EventEmitter {
  constructor() {
    super();
    this.queue   = [];          // pending jobs
    this.running = false;       // is worker active
    this.workers = 3;           // max concurrent shipments (parallel courier API calls)
    this.active  = 0;           // current active workers
    this.results = new Map();   // jobId → result (kept 10 min then auto-cleared)
  }

  // ── Enqueue a job ─────────────────────────────────────────────────────────
  enqueue(jobId, data) {
    this.queue.push({ jobId, data, enqueuedAt: Date.now() });
    this.results.set(jobId, { status: 'queued', enqueuedAt: Date.now() });
    this._scheduleCleanup(jobId);
    this._tick();
    return jobId;
  }

  // ── Poll job status ────────────────────────────────────────────────────────
  status(jobId) {
    return this.results.get(jobId) || null;
  }

  // ── Worker tick — process up to `workers` jobs concurrently ───────────────
  _tick() {
    while (this.active < this.workers && this.queue.length > 0) {
      const job = this.queue.shift();
      this.active++;
      this._process(job).finally(() => {
        this.active--;
        this._tick(); // pick up next job
      });
    }
  }

  // ── Process one job ───────────────────────────────────────────────────────
  async _process(job) {
    const { jobId, data } = job;
    this.results.set(jobId, { ...this.results.get(jobId), status: 'processing', startedAt: Date.now() });
    this.emit('started', jobId);

    try {
      const result = await data.handler();
      this.results.set(jobId, {
        ...this.results.get(jobId),
        status:      'done',
        result,
        finishedAt:  Date.now()
      });
      this.emit('done', jobId, result);
    } catch (err) {
      this.results.set(jobId, {
        ...this.results.get(jobId),
        status:     'failed',
        error:      err.message,
        finishedAt: Date.now()
      });
      this.emit('failed', jobId, err);
    }
  }

  // ── Auto-clear results after 10 minutes ───────────────────────────────────
  _scheduleCleanup(jobId) {
    setTimeout(() => this.results.delete(jobId), 10 * 60 * 1000);
  }
}

// Singleton — shared across all route files
const shippingQueue = new ShippingQueue();
module.exports = shippingQueue;
