// One pending wake at a time. Every processed OR skipped frame schedules the
// next one, so a frame cap cannot accidentally terminate the render loop.
export class FrameLoop {
  constructor({
    onFrame,
    interval,
    useTimer,
    onError = (error) => {
      throw error;
    },
    now = () => performance.now(),
    requestFrame = (fn) => requestAnimationFrame(fn),
    cancelFrame = (id) => cancelAnimationFrame(id),
    setTimer = (fn, delay) => setTimeout(fn, delay),
    clearTimer = (id) => clearTimeout(id),
  }) {
    Object.assign(this, {
      onFrame,
      interval,
      useTimer,
      onError,
      now,
      requestFrame,
      cancelFrame,
      setTimer,
      clearTimer,
    });
    this.running = false;
    this.pending = null;
    this.lastFrameAt = null;
    this._wake = (time) => {
      this.pending = null;
      if (!this.running) return;
      const gap = this.interval();
      if (this.lastFrameAt === null || time - this.lastFrameAt + 0.5 >= gap) {
        this.lastFrameAt = time;
        try {
          this.onFrame(time);
        } catch (error) {
          this.stop();
          this.onError(error);
          return;
        }
      }
      this._schedule();
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrameAt = null;
    this._schedule();
  }

  stop() {
    this.running = false;
    if (this.pending !== null) {
      if (this.timerWake) this.clearTimer(this.pending);
      else this.cancelFrame(this.pending);
    }
    this.pending = null;
    this.lastFrameAt = null;
  }

  _schedule() {
    if (!this.running || this.pending !== null) return;
    this.timerWake = this.useTimer();
    if (this.timerWake) {
      // Include time spent rendering in the budget, rather than sleeping a
      // full frame interval after each render. Phones retain the 30 fps cap.
      const wait = this.lastFrameAt === null
        ? 0
        : Math.max(1, this.interval() - (this.now() - this.lastFrameAt));
      this.pending = this.setTimer(() => this._wake(this.now()), wait);
    } else {
      this.pending = this.requestFrame(this._wake);
    }
  }
}
