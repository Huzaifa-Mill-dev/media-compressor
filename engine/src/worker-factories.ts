/** One literal `new Worker(new URL(...))` per worker script so Vite/Rollup can detect and bundle each. */
import type { WorkerKind } from "./protocol";
import type { WorkerLike } from "./pool";

export function createWorker(kind: WorkerKind): WorkerLike {
  switch (kind) {
    case "image":
      return new Worker(new URL("./workers/image.worker.ts", import.meta.url), { type: "module", name: "mt-image" });
    case "media":
      return new Worker(new URL("./workers/media.worker.ts", import.meta.url), { type: "module", name: "mt-media" });
    case "doc":
      return new Worker(new URL("./workers/doc.worker.ts", import.meta.url), { type: "module", name: "mt-doc" });
  }
}
