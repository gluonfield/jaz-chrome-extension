export function chromePromise(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (...callbackArgs) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (callbackArgs.length === 0) {
        resolve(undefined);
        return;
      }
      resolve(callbackArgs.length === 1 ? callbackArgs[0] : callbackArgs);
    });
  });
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(error) {
  return error && error.message ? error.message : String(error);
}
