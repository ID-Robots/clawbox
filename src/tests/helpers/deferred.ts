/**
 * A promise settled by the test, not by the code under test — for pinning
 * ordering: "B must not start until A has finished".
 */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
