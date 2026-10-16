/** Server runtime per docs/PLAN.md: multipart upload (XHR progress) → SSE (polling fallback) → outputs as Blobs. */
import { abortError, EngineError } from "./errors";
import { mimeOf } from "./formats";
import type { JobOutput, JobProgress, JobResult, Options, ToolId } from "./types";

export interface ServerCaps {
  tools: ToolId[];
  maxFileBytes?: number;
  maxFiles?: number;
}

interface ServerJob {
  id: string;
  status: "queued" | "processing" | "done" | "error" | "cancelled";
  percent: number;
  message?: string;
  outputs?: { name: string; size: number; mime: string; url: string }[];
  meta?: JobResult["meta"];
  error?: string;
}

export async function fetchServerCaps(base: string, signal?: AbortSignal): Promise<ServerCaps | null> {
  try {
    const r = await fetch(`${base}/api/capabilities`, { signal: signal ?? AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { tools?: ToolId[]; limits?: { maxFileBytes?: number; maxFiles?: number } };
    return { tools: j.tools ?? [], maxFileBytes: j.limits?.maxFileBytes, maxFiles: j.limits?.maxFiles };
  } catch {
    return null;
  }
}

function upload(url: string, form: FormData, onPct: (p: number) => void, signal: AbortSignal): Promise<{ jobId: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => e.lengthComputable && onPct(e.loaded / e.total);
    xhr.onload = () => {
      const body = xhr.response as { jobId?: string; error?: string } | null;
      if (xhr.status === 202 && body?.jobId) return resolve({ jobId: body.jobId });
      const why = xhr.status === 413 ? "The file is too large for the server." : xhr.status === 429 ? "The server is busy — try again shortly." : body?.error ?? `Server error (${xhr.status}).`;
      reject(new EngineError("server-rejected", why));
    };
    xhr.onerror = () => reject(new EngineError("server-unreachable", "Couldn't reach the server."));
    xhr.onabort = () => reject(abortError());
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

export async function runOnServer(
  base: string,
  toolId: ToolId,
  files: File[],
  options: Options,
  onProgress: (p: JobProgress) => void,
  signal: AbortSignal,
): Promise<Omit<JobResult, "durationMs">> {
  const t = (stage: JobProgress["stage"], percent: number, message?: string) => onProgress({ stage, percent, message, runtime: "server" });
  const form = new FormData();
  form.append("tool", toolId);
  form.append("options", JSON.stringify(options));
  for (const f of files) form.append("files", f, f.name);
  t("uploading", 1, "Uploading");
  const { jobId } = await upload(`${base}/api/jobs`, form, (p) => t("uploading", 1 + p * 29, "Uploading"), signal);
  const cancel = () => void fetch(`${base}/api/jobs/${jobId}`, { method: "DELETE", keepalive: true }).catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const job = await watch(base, jobId, (j) => t(j.status === "queued" ? "queued" : "processing", 30 + (j.percent / 100) * 60, j.message), signal);
    if (job.status === "cancelled") throw abortError();
    if (job.status === "error") throw new EngineError("server-error", job.error ?? "The server couldn't process this file.");
    t("finalizing", 92, "Downloading result");
    const outputs: JobOutput[] = [];
    for (const o of job.outputs ?? []) {
      const r = await fetch(new URL(o.url, `${base || location.origin}/`).toString(), { signal });
      if (!r.ok) throw new EngineError("server-error", `Couldn't download ${o.name}.`);
      const blob = await r.blob();
      const ext = o.name.split(".").pop() ?? "";
      outputs.push({ blob, filename: o.name, mime: o.mime || mimeOf(ext), size: blob.size });
    }
    return { runtime: "server", inputSize: files.reduce((a, f) => a + f.size, 0), outputs, meta: job.meta };
  } catch (e) {
    if (signal.aborted) throw abortError();
    throw e;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function watch(base: string, id: string, onUpdate: (j: ServerJob) => void, signal: AbortSignal): Promise<ServerJob> {
  const terminal = (j: ServerJob) => j.status === "done" || j.status === "error" || j.status === "cancelled";
  return new Promise((resolve, reject) => {
    let done = false;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      es?.close();
      if (timer) clearTimeout(timer);
      fn();
    };
    const got = (j: ServerJob) => {
      onUpdate(j);
      if (terminal(j)) finish(() => resolve(j));
    };
    const poll = async () => {
      if (done) return;
      try {
        const r = await fetch(`${base}/api/jobs/${id}`, { signal });
        if (!r.ok) throw new Error(String(r.status));
        got((await r.json()) as ServerJob);
      } catch (e) {
        if (signal.aborted) return finish(() => reject(abortError()));
        return finish(() => reject(new EngineError("server-unreachable", "Lost connection to the server.")));
      }
      if (!done) timer = setTimeout(poll, 700);
    };
    signal.addEventListener("abort", () => finish(() => reject(abortError())), { once: true });
    if (typeof EventSource === "undefined") return void poll();
    es = new EventSource(`${base}/api/jobs/${id}/events`);
    es.onmessage = (ev) => {
      try {
        got(JSON.parse(ev.data) as ServerJob);
      } catch {
        /* ignore malformed */
      }
    };
    es.onerror = () => {
      es?.close();
      es = null;
      void poll(); // SSE dropped → polling fallback
    };
  });
}
