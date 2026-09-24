// Serial execution queue. The host processes commands strictly in order and
// acknowledges each one, with no per-session write lease.

export function createSerialQueue() {
  let tail = Promise.resolve();
  return {
    run(task) {
      const result = tail.then(task, task);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
