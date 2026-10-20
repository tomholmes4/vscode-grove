import * as vscode from 'vscode';

type Report = vscode.Progress<{ message?: string; increment?: number }>;

// A step's elapsed time only appears once it has run this long, so quick steps
// don't flash a "0s".
const SHOW_ELAPSED_AFTER_MS = 2000;

/**
 * Drives a `withProgress` notification through a known number of steps. The
 * message reads `3/6 Cloning node_modules · 2 of 9 · apps/web/node_modules · 8s`,
 * the bar fills as steps (and fractions of a step) complete, and a
 * once-a-second tick keeps the elapsed counter moving so a long step visibly
 * hasn't hung. Each step's duration is logged, to show where the time goes.
 */
export class StepProgress {
  private progress: Report | undefined;
  private index = -1;
  private label = '';
  private detail = '';
  private fraction = 0;
  private reported = 0;
  private started = 0;
  private stepStarted = 0;
  private finishedAfter = 0;

  constructor(
    private readonly total: number,
    private readonly log: (message: string) => void
  ) {}

  /** The step in progress, or the last one started; names a failure. */
  get current(): string {
    return this.label;
  }

  /** Wall-clock time `run` took, once it has settled. */
  get elapsedMs(): number {
    return this.finishedAfter;
  }

  /** Runs `task` against a `withProgress` reporter, ticking until it settles. */
  async run<T>(progress: Report, task: () => Promise<T>): Promise<T> {
    this.progress = progress;
    this.started = Date.now();
    const ticker = setInterval(() => this.render(), 1000);
    try {
      return await task();
    } finally {
      clearInterval(ticker);
      this.logStep();
      this.finishedAfter = Date.now() - this.started;
    }
  }

  /** Ends the current step and starts the next one. */
  next(label: string): void {
    this.logStep();
    this.index++;
    this.label = label;
    this.detail = '';
    this.fraction = 0;
    this.stepStarted = Date.now();
    this.render();
  }

  /** Sets the current step's detail text and, optionally, how far through it is (0–1). */
  update(detail: string, fraction?: number): void {
    this.detail = detail;
    if (fraction !== undefined) {
      this.fraction = Math.min(Math.max(fraction, 0), 1);
    }
    this.render();
  }

  private logStep(): void {
    if (this.index >= 0) {
      this.log(`${this.label} took ${formatDuration(Date.now() - this.stepStarted)}`);
    }
  }

  private render(): void {
    if (!this.progress || this.index < 0) {
      return;
    }
    const parts = [`${this.index + 1}/${this.total} ${this.label}`];
    if (this.detail) {
      parts.push(this.detail);
    }
    const elapsed = Date.now() - this.stepStarted;
    if (elapsed >= SHOW_ELAPSED_AFTER_MS) {
      parts.push(formatElapsed(elapsed));
    }
    // `increment` is cumulative, so only the growth since the last report is sent.
    const target = ((this.index + this.fraction) / this.total) * 100;
    const increment = target - this.reported;
    if (increment > 0) {
      this.reported = target;
    }
    this.progress.report({
      message: parts.join(' · '),
      ...(increment > 0 ? { increment } : {}),
    });
  }
}

/** `42s`, or `2m 05s` past a minute. */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
