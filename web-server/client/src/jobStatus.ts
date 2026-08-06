import { Job } from "./api";

/**
 * One line of progress for a running job.
 *
 * CreatePanel and MemoryPicker both used to print `Status: {status} — {message}`
 * verbatim. The server's per-engine phase message is `f"running {engine.name}"`
 * (server/app/jobs.py), so with the CPU preview engine that rendered as
 *
 *     Status: running — running preview
 *
 * — the word "running" twice, which reads as a string-formatting bug rather than
 * as progress. The message already names the phase, so the status word is
 * redundant whenever the two agree; show the message and keep the bare status
 * only when there is no message to show.
 */
export function jobStatusLine(job: Pick<Job, "status" | "message">): string {
  const message = (job.message ?? "").trim();
  if (!message) return `Status: ${job.status}`;

  // "running" + "running preview", "done" + "done" — the message subsumes the status.
  const redundant =
    message === job.status || message.toLowerCase().startsWith(`${job.status.toLowerCase()} `);

  return redundant ? `Status: ${message}` : `Status: ${job.status} — ${message}`;
}
