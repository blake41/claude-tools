import PQueue from "p-queue";

export interface JobStatus {
  total: number;
  completed: number;
  failed: number;
  running: boolean;
  cancelled: boolean;
  errors: Array<{ id: string; error: string }>;
}

export class BackgroundJob {
  private state: JobStatus | null = null;
  private queue: PQueue | null = null;
  private concurrency: number;

  constructor(concurrency: number) {
    this.concurrency = concurrency;
  }

  start<T>(
    items: T[],
    getId: (item: T) => string,
    processor: (item: T) => Promise<void>,
    onComplete?: () => void
  ): { total: number; message?: string } {
    if (this.state?.running) {
      return { total: 0, message: "A job is already running" };
    }

    if (items.length === 0) {
      return { total: 0, message: "Nothing to process" };
    }

    this.state = {
      total: items.length,
      completed: 0,
      failed: 0,
      running: true,
      cancelled: false,
      errors: [],
    };

    this.run(items, getId, processor, onComplete);
    return { total: items.length };
  }

  private async run<T>(
    items: T[],
    getId: (item: T) => string,
    processor: (item: T) => Promise<void>,
    onComplete?: () => void
  ): Promise<void> {
    const queue = new PQueue({ concurrency: this.concurrency });
    this.queue = queue;

    const tasks = items.map((item) =>
      queue.add(async () => {
        if (!this.state || this.state.cancelled) return;
        try {
          await processor(item);
          this.state.completed++;
        } catch (err: unknown) {
          this.state.failed++;
          const msg = err instanceof Error ? err.message : String(err);
          this.state.errors.push({ id: getId(item), error: msg });
        }
      })
    );

    await Promise.allSettled(tasks);
    if (this.state) this.state.running = false;
    this.queue = null;
    onComplete?.();
  }

  getStatus(): JobStatus | { running: false } {
    return this.state ?? { running: false as const };
  }

  cancel(): void {
    if (this.state) {
      this.state.cancelled = true;
      this.queue?.clear();
    }
  }

  get isRunning(): boolean {
    return this.state?.running ?? false;
  }
}
