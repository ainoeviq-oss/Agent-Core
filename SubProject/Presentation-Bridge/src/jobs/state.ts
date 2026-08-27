import { writeJson } from '../reports/io.js';

export type JobState =
  | 'queued'
  | 'preflight'
  | 'converting_google'
  | 'converting_keynote'
  | 'verifying'
  | 'completed'
  | 'completed_with_warnings'
  | 'failed'
  | 'cancelled';

export interface JobStateRecord {
  jobId: string;
  state: JobState;
  updatedAt: string;
  history: Array<{ state: JobState; at: string }>;
}

export class JobStateWriter {
  private record: JobStateRecord;
  constructor(private readonly path: string, jobId: string) {
    const at = new Date().toISOString();
    this.record = { jobId, state: 'queued', updatedAt: at, history: [{ state: 'queued', at }] };
  }

  async init(): Promise<void> { await writeJson(this.path, this.record); }

  async set(state: JobState): Promise<void> {
    const at = new Date().toISOString();
    this.record.state = state;
    this.record.updatedAt = at;
    this.record.history.push({ state, at });
    await writeJson(this.path, this.record);
  }
}
