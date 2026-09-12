// Races `work` against a timeout, always clearing the timer so a fast/normal
// resolution doesn't leave a pending `setTimeout` on the event loop for the
// rest of the timeout window. Shared by csp-report.ts (bounding the Blobs
// write on the request path, so a slow/unavailable Blobs region degrades to
// a logged failure marker instead of a hung response) and
// csp-report-prune.ts (bounding the whole scheduled prune run, so a hung
// Blobs call can't run past the platform's own execution limit with nothing
// logged to show for it).
export class TimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} exceeded ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

export async function withTimeout<Value>(
  work: Promise<Value>,
  timeoutMs: number,
  label: string,
): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(label, timeoutMs)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
