// Data shapes shared by the server (which builds them from transcripts) and the web UI.

export type ChangeKind = 'edit' | 'multiedit' | 'write' | 'notebook';

export type ChangeStatus = 'applied' | 'failed' | 'pending';

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Each line is prefixed with ' ' (context), '-' (removed) or '+' (added). */
  lines: string[];
}

export interface Change {
  /** The tool_use id from the transcript. */
  id: string;
  timestamp: string;
  tool: string;
  kind: ChangeKind;
  filePath: string;
  status: ChangeStatus;
  error?: string;
  /** True when a Write created a file that did not exist before. */
  created: boolean;
  hunks: Hunk[];
  added: number;
  removed: number;
  /** True when line numbers are relative to the edited snippet rather than the real file. */
  approximateLines: boolean;
  /** Index into SessionDetail.prompts of the prompt this change answered, if any. */
  promptIndex: number | null;
  /** Set when the change was made by a subagent; holds the subagent transcript name. */
  subagent?: string;
}

export interface Prompt {
  index: number;
  timestamp: string;
  text: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  projectPath: string;
  projectName: string;
  startedAt: string;
  updatedAt: string;
  changeCount: number;
  fileCount: number;
  added: number;
  removed: number;
}

export interface SessionDetail extends SessionSummary {
  prompts: Prompt[];
  changes: Change[];
}
