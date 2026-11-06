import { randomUUID } from "node:crypto";
import type { JobView, QueryResult } from "../shared/contracts";
import { errorMessage } from "./errors";
import { PartialRunError } from "./adapters/sql-base";

// A finished job is kept long enough for a client to come back for it, then forgotten. Rows are in memory.
const KEEP_FINISHED_MS = 10 * 60 * 1000;
const MAX_JOBS = 200;

export interface JobOutcome {
  results?: QueryResult[];
  affected?: number;
  count?: number;
  text?: string;
  truncated?: boolean;
  message?: string;
}

interface Job {
  view: JobView;
  controller: AbortController;
  finishedAt: number | null;
}

// Every statement, write, count, import and export runs as a job the client polls. Paseo stops waiting
// for an RPC after 30 seconds without telling the handler. A statement waited on directly would report
// a failure and then commit anyway, and the user would run it again.
export class Jobs {
  private readonly jobs = new Map<string, Job>();

  start(kind: JobView["kind"], path: string | null, work: (job: { signal: AbortSignal; setRows(rows: number): void; setPath(path: string): void }) => Promise<JobOutcome>): JobView {
    this.forgetOld();
    const job: Job = {
      controller: new AbortController(),
      finishedAt: null,
      view: { id: randomUUID(), kind, status: "running", rows: 0, message: null, path, startedAt: new Date().toISOString(), results: null, affected: null, count: null, text: null, truncated: false, error: null },
    };
    this.jobs.set(job.view.id, job);
        void Promise.resolve()
      .then(() =>
        work({
          signal: job.controller.signal,
          setRows: (rows) => {
            job.view.rows = rows;
          },
          setPath: (next) => {
            job.view.path = next;
          },
        }),
      )
      .then((outcome) => {
        job.view.status = job.controller.signal.aborted ? "cancelled" : "done";
        job.view.results = outcome.results ?? null;
        job.view.affected = outcome.affected ?? null;
        job.view.count = outcome.count ?? null;
        job.view.text = outcome.text ?? null;
        job.view.truncated = outcome.truncated ?? false;
        job.view.message = outcome.message ?? null;
      })
      .catch((error: unknown) => {
        job.view.status = job.controller.signal.aborted ? "cancelled" : "failed";
        job.view.error = errorMessage(error);
        if (error instanceof PartialRunError) job.view.results = error.results;
      })
      .finally(() => {
        job.finishedAt = Date.now();
      });
    return job.view;
  }

  status(id: string): JobView {
    const job = this.jobs.get(id);
    // Jobs live in memory. Say what that means instead of a bare "not found": a write may have landed.
    if (!job) throw new Error("This job is gone, because the plugin restarted or too much time passed. If it was changing data, check the database before running it again.");
    return job.view;
  }

  cancel(id: string): void {
    this.jobs.get(id)?.controller.abort();
  }

  private forgetOld() {
    const now = Date.now();
    for (const [id, job] of this.jobs) if (job.finishedAt !== null && now - job.finishedAt > KEEP_FINISHED_MS) this.jobs.delete(id);
    if (this.jobs.size < MAX_JOBS) return;
    for (const [id, job] of this.jobs) if (job.finishedAt !== null) this.jobs.delete(id);
  }

  cancelAll(): void {
    for (const job of this.jobs.values()) job.controller.abort();
  }
}
