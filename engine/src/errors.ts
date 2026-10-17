/** Error helpers shared by the main thread and workers. */

export function abortError(message = "The job was cancelled."): Error {
  // DOMException is available in browsers, workers and Node ≥17.
  try {
    return new DOMException(message, "AbortError");
  } catch {
    const e = new Error(message);
    e.name = "AbortError";
    return e;
  }
}

export function isAbortError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: string }).name === "AbortError";
}

/** A user-facing, expected failure (bad input, unsupported format, limits). */
export class EngineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}

/** Serializable form for postMessage. */
export interface SerializedError {
  name: string;
  message: string;
  code?: string;
}

export function serializeError(e: unknown): SerializedError {
  if (e instanceof EngineError) return { name: e.name, message: e.message, code: e.code };
  if (e instanceof Error) return { name: e.name, message: e.message || String(e) };
  if (typeof e === "string") return { name: "Error", message: e };
  return { name: "Error", message: String(e) };
}

export function deserializeError(s: SerializedError): Error {
  if (s.name === "AbortError") return abortError(s.message);
  if (s.code) return new EngineError(s.code, s.message);
  const e = new Error(s.message);
  e.name = s.name;
  return e;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}
