import { jobStatusLine } from './jobStatus';

/**
 * Every message string the server can actually put on a job, lifted from
 * server/app/jobs.py `_touch(...)` calls. Testing against invented strings would
 * only prove the function is self-consistent; testing against these proves the
 * line a user sees during a real reconstruction is not gibberish.
 */
const SERVER_MESSAGES = [
  { status: 'running' as const, message: 'preparing input' },
  { status: 'running' as const, message: 'reconstructing with Depth Anything V2 — Small' },
  { status: 'running' as const, message: 'transcoding' },
  { status: 'running' as const, message: 'recording to memory' },
  { status: 'done' as const, message: 'done' },
  { status: 'error' as const, message: 'failed' },
];

describe('jobStatusLine', () => {
  it('never prints the same word twice for a real server message', () => {
    // The defect: `Status: {status} — {message}` rendered "Status: running —
    // running preview", which reads as a formatting bug rather than as progress.
    for (const job of SERVER_MESSAGES) {
      const line = jobStatusLine(job);
      const words = line.replace(/^Status: /, '').split(/[\s—]+/).filter(Boolean);
      const doubled = words.filter((w, i) => i > 0 && w.toLowerCase() === words[i - 1].toLowerCase());
      expect(doubled).toEqual([]);
    }
  });

  it('drops the status word only when the message already opens with it', () => {
    // The historical shape the rule was written for: jobs.py used to phrase the
    // per-engine phase as f"running {engine.name}".
    expect(jobStatusLine({ status: 'running', message: 'running preview' })).toBe(
      'Status: running preview',
    );
    expect(jobStatusLine({ status: 'done', message: 'done' })).toBe('Status: done');

    // ...and does NOT drop it when the message merely starts with the same
    // letters. Matching on a bare prefix rather than on a prefix plus a space
    // would turn a genuine phase name into a status word and lose the phase:
    // "Status: running" for a job that is actually running the runner.
    expect(jobStatusLine({ status: 'running', message: 'runnerpool warming up' })).toBe(
      'Status: running — runnerpool warming up',
    );
  });

  it('keeps the phase when the message is about something else entirely', () => {
    expect(jobStatusLine({ status: 'running', message: 'reconstructing with SHARP' })).toBe(
      'Status: running — reconstructing with SHARP',
    );
    expect(jobStatusLine({ status: 'error', message: 'failed' })).toBe('Status: error — failed');
  });

  it('still says something when the server sends no message at all', () => {
    // A queued job carries message="" until the worker picks it up, and
    // MemoryPicker renders this line unconditionally — an empty trailing
    // em-dash is the visible symptom of forgetting the empty case.
    expect(jobStatusLine({ status: 'queued', message: '' })).toBe('Status: queued');
    expect(jobStatusLine({ status: 'queued', message: '   ' })).toBe('Status: queued');
    expect(
      jobStatusLine({ status: 'queued' } as unknown as { status: 'queued'; message: string }),
    ).toBe('Status: queued');
  });

  it('matches the status prefix regardless of case, and preserves the message casing', () => {
    // jobs.py lower-cases its phases today, but the messages are prose and a
    // capitalised "Running SHARP" is one commit away. The status word is
    // dropped; what is shown is the server's own string, not a lower-cased one.
    expect(jobStatusLine({ status: 'running', message: 'Running SHARP on CPU' })).toBe(
      'Status: Running SHARP on CPU',
    );
  });
});
