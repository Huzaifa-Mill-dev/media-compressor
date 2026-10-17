/**
 * Generic bounded scheduler. Jobs belong to a lane; a job starts when both the global limit and its
 * lane limit have room. Later jobs may overtake earlier ones that are blocked on a full lane (so one
 * long video never starves ten images). Aborting a queued job removes it; aborting a running job
 * invokes the job's own abort (the job must reject with AbortError and release its resources).
 */
import { abortError, isAbortError } from "./errors";

export interface SchedulerOptions {
  /** Max simultaneously running jobs overall. */
  limit: number;
  /** Per-lane limits (lanes not listed are limited only by the global limit). */
  lanes?: Record<string, number>;
}

interface Entry<T> {
  lane: string;
  run: (signal: AbortSignal) => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  controller: AbortController;
  userSignal?: AbortSignal;
  onUserAbort?: () => void;
  started: boolean;
  onStart?: () => void;
}

export class Scheduler {
  private queue: Entry<unknown>[] = [];
  private running = 0;
  private laneRunning = new Map<string, number>();
  readonly limit: number;
  private lanes: Record<string, number>;
  /** Highest number of simultaneously running jobs observed (for tests/diagnostics). */
  peak = 0;

  constructor(opts: SchedulerOptions) {
    this.limit = Math.max(1, Math.floor(opts.limit));
    this.lanes = opts.lanes ?? {};
  }

  get runningCount(): number {
    return this.running;
  }
  get queuedCount(): number {
    return this.queue.length;
  }

  schedule<T>(
    lane: string,
    run: (signal: AbortSignal) => Promise<T>,
    opts: { signal?: AbortSignal; onStart?: () => void } = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (opts.signal?.aborted) return reject(abortError());
      const e: Entry<T> = {
        lane,
        run,
        resolve,
        reject,
        controller: new AbortController(),
        userSignal: opts.signal,
        started: false,
        onStart: opts.onStart,
      };
      if (opts.signal) {
        e.onUserAbort = () => {
          if (!e.started) {
            const i = this.queue.indexOf(e as Entry<unknown>);
            if (i >= 0) this.queue.splice(i, 1);
            reject(abortError());
          } else {
            e.controller.abort();
          }
        };
        opts.signal.addEventListener("abort", e.onUserAbort, { once: true });
      }
      this.queue.push(e as Entry<unknown>);
      this.pump();
    });
  }

  private laneLimit(lane: string): number {
    return Math.min(this.lanes[lane] ?? Infinity, this.limit);
  }

  private pump(): void {
    for (let i = 0; i < this.queue.length && this.running < this.limit; ) {
      const e = this.queue[i]!;
      if ((this.laneRunning.get(e.lane) ?? 0) >= this.laneLimit(e.lane)) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      this.start(e);
    }
  }

  private start(e: Entry<unknown>): void {
    e.started = true;
    this.running++;
    this.peak = Math.max(this.peak, this.running);
    this.laneRunning.set(e.lane, (this.laneRunning.get(e.lane) ?? 0) + 1);
    const finish = () => {
      this.running--;
      this.laneRunning.set(e.lane, (this.laneRunning.get(e.lane) ?? 1) - 1);
      if (e.userSignal && e.onUserAbort) e.userSignal.removeEventListener("abort", e.onUserAbort);
      this.pump();
    };
    try {
      e.onStart?.();
    } catch {
      /* listener errors must not break scheduling */
    }
    Promise.resolve()
      .then(() => {
        if (e.userSignal?.aborted) e.controller.abort();
        return e.run(e.controller.signal);
      })
      .then(
        (v) => {
          finish();
          e.resolve(v);
        },
        (err) => {
          finish();
          // Normalise: an aborted job always rejects as AbortError.
          e.reject(e.controller.signal.aborted && !isAbortError(err) ? abortError() : err);
        },
      );
  }
}
