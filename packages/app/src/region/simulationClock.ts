/** Converts frame time into serialized, bounded requests for game seconds. */
export class SimulationClock {
  running = false;
  private speed = 1;
  private previous: number | null = null;
  private pending = 0;
  private inFlight = false;
  private generation = 0;

  constructor(
    private readonly advance: (seconds: number) => Promise<void>,
    private readonly failed: (error: unknown) => void,
  ) {}

  setRunning(running: boolean): void {
    this.running = running;
    this.previous = null;

    if (!running) {
      this.pending = 0;
      this.generation++;
    }
  }

  setSpeed(speed: number): void {
    if (![1, 5, 20, 120].includes(speed)) {
      throw new Error('Unsupported simulation speed');
    }

    this.speed = speed;
  }

  reset(): void {
    this.setRunning(false);
  }

  tick(now: number): void {
    const previous = this.previous;

    this.previous = now;

    if (!this.running || previous === null) {
      return;
    }

    this.pending += (Math.max(0, now - previous) / 1000) * 10 * this.speed;
    this.flush();
  }

  private flush(): void {
    if (!this.running || this.inFlight || this.pending < 1) {
      return;
    }

    const seconds = Math.min(120, this.pending);
    const token = this.generation;

    this.pending -= seconds;
    this.inFlight = true;
    this.advance(seconds)
      .then(
        () => {
          this.inFlight = false;

          if (token === this.generation) {
            this.flush();
          }
        },
        (error: unknown) => {
          this.inFlight = false;

          if (token === this.generation) {
            this.reset();
            this.failed(error);
          }
        },
      )
      .catch((error: unknown) => {
        this.reset();
        this.failed(error);
      });
  }
}
