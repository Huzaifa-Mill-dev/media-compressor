/** An error whose message is safe to show to the client, with an HTTP status. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** A processing failure whose message is safe to surface in job.error. */
export class JobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobError";
  }
}

export class AbortError extends Error {
  constructor(message = "Job was cancelled") {
    super(message);
    this.name = "AbortError";
  }
}

export class TimeoutError extends Error {
  constructor(message = "Job timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

export const badRequest = (msg: string, code?: string) => new HttpError(400, msg, code);

export class MemoryLimitError extends Error {
  constructor(message = "The job needed more memory than this server can spare") {
    super(message);
    this.name = "MemoryLimitError";
  }
}
