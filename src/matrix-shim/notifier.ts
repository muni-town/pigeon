/* eslint-disable no-console */
/**
 * Helper class that allows you to wait on the next notification and send notifications.
 */
export class Notifier {
  name: string;

  resolve: () => void;

  promise: Promise<void>;

  constructor(name: string) {
    this.name = name;

    let resolve: () => void = () => {
      // Do nothing
    };
    this.promise = new Promise((r) => {
      resolve = r;
    });
    this.resolve = resolve;
  }

  /** Notify all tasks that are `wait()`-ing for this. */
  notify() {
    console.info(`Notifier "${this.name}" notified.`);
    this.resolve();
    this.promise = new Promise((r) => {
      this.resolve = r;
    });
  }

  /** Wait for the next notification. */
  async wait() {
    await this.promise;
    console.info(`Waiter for "${this.name}" finished.`);
  }
}
