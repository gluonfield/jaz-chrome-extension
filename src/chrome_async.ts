export function chromePromise<T = unknown>(
  fn: (...args: any[]) => void,
  ...args: any[]
): Promise<T> {
  return new Promise((resolve, reject) => {
    fn(...args, (...callbackArgs: unknown[]) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (callbackArgs.length === 0) {
        resolve(undefined as T);
        return;
      }
      resolve((callbackArgs.length === 1 ? callbackArgs[0] : callbackArgs) as T);
    });
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
