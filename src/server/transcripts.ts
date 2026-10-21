// Finds Claude Code session transcripts on disk and turns their file-editing
// tool calls into diffs.

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { structuredPatch } from 'diff';
import type {
  Change,
  ChangeKind,
  Hunk,
  Prompt,
  SessionDetail,
  SessionSummary,
} from '../shared/types.ts';

const TRACKED_TOOLS: Record<string, ChangeKind> = {
  Edit: 'edit',
  MultiEdit: 'multiedit',
  Write: 'write',
  NotebookEdit: 'notebook',
};

export function defaultProjectsRoot(): string {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  return join(base, 'projects');
}

export interface SessionFiles {
  id: string;
  main: string;
  /** Subagent transcripts stored under <project>/<sessionId>/. */
  subagents: string[];
}

/** Lists every session transcript under the projects root: <root>/<project>/<sessionId>.jsonl */
export async function findSessionFiles(root: string): Promise<SessionFiles[]> {
  const found: SessionFiles[] = [];
  for (const project of await readdirSafe(root)) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    for (const entry of await readdirSafe(dir)) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const id = entry.name.slice(0, -'.jsonl'.length);
      found.push({ id, main: join(dir, entry.name), subagents: await findJsonl(join(dir, id)) });
    }
  }
  return found;
}

async function findJsonl(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdirSafe(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findJsonl(path)));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(path);
  }
  return found;
}

async function readdirSafe(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export interface TranscriptSource {
  text: string;
  /** Name of the subagent transcript; omitted for the main session transcript. */
  subagent?: string;
}

/** Builds a session view from its transcripts. Unknown or malformed lines are skipped. */
export function parseSession(id: string, sources: TranscriptSource[]): SessionDetail {
  let title: string | undefined;
  let cwd: string | undefined;
  let startedAt = '';
  let updatedAt = '';
  const prompts: Prompt[] = [];
  const changes: Change[] = [];
  const byToolUseId = new Map<string, Change>();

  for (const source of sources) {
    for (const line of source.text.split('\n')) {
      const entry = parseLine(line);
      if (!entry) continue;

      if (typeof entry.timestamp === 'string') {
        if (!startedAt || entry.timestamp < startedAt) startedAt = entry.timestamp;
        if (entry.timestamp > updatedAt) updatedAt = entry.timestamp;
      }
      if (!source.subagent) {
        if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') title = entry.aiTitle;
        if (entry.type === 'summary' && typeof entry.summary === 'string') title ??= entry.summary;
        if (typeof entry.cwd === 'string') cwd ??= entry.cwd;
      }

      const content = entry.message?.content;
      const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : updatedAt;

      if (entry.type === 'assistant' && Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
          if (byToolUseId.has(block.id)) continue;
          const change = changeFromToolUse(block, timestamp, source.subagent);
          if (!change) continue;
          byToolUseId.set(block.id, change);
          changes.push(change);
        }
      } else if (entry.type === 'user') {
        if (typeof content === 'string') {
          if (!source.subagent && !entry.isMeta) addPrompt(prompts, content, timestamp);
          continue;
        }
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            if (!source.subagent && !entry.isMeta) addPrompt(prompts, block.text, timestamp);
          } else if (block?.type === 'tool_result') {
            const change = byToolUseId.get(block.tool_use_id);
            if (change) applyToolResult(change, block, entry.toolUseResult);
          }
        }
      }
    }
  }

  changes.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  for (const change of changes) change.promptIndex = promptBefore(prompts, change.timestamp);

  const projectPath = cwd ?? '';
  const files = new Set(changes.map((c) => c.filePath));
  return {
    id,
    title: title ?? (prompts[0] ? truncate(prompts[0].text, 80) : 'Untitled session'),
    projectPath,
    projectName: projectPath ? basename(projectPath) : 'Unknown project',
    startedAt,
    updatedAt,
    changeCount: changes.length,
    fileCount: files.size,
    added: changes.reduce((sum, c) => sum + c.added, 0),
    removed: changes.reduce((sum, c) => sum + c.removed, 0),
    prompts,
    changes,
  };
}

// Transcript lines are loosely typed JSON; fields are checked where they are used.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Entry = any;

function parseLine(line: string): Entry | null {
  if (!line.trim()) return null;
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function addPrompt(prompts: Prompt[], raw: string, timestamp: string) {
  const text = promptText(raw);
  if (text) prompts.push({ index: prompts.length, timestamp, text });
}

/** Returns the human-readable part of a user message, or null for harness-generated messages. */
function promptText(raw: string): string | null {
  const text = raw.trim();
  if (!text || text.startsWith('[Request interrupted')) return null;
  const command = /^<command-name>([^<]*)<\/command-name>/.exec(text);
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    return args ? `${command[1]} ${args}` : command[1];
  }
  if (text.startsWith('<')) return null;
  return text;
}

function promptBefore(prompts: Prompt[], timestamp: string): number | null {
  let found: number | null = null;
  for (const prompt of prompts) {
    if (prompt.timestamp > timestamp) break;
    found = prompt.index;
  }
  return found;
}

function changeFromToolUse(block: Entry, timestamp: string, subagent?: string): Change | null {
  const kind = TRACKED_TOOLS[block.name];
  const input = block.input ?? {};
  const filePath = input.file_path ?? input.notebook_path;
  if (!kind || typeof filePath !== 'string') return null;

  let hunks: Hunk[] = [];
  if (kind === 'edit') {
    hunks = diffStrings(str(input.old_string), str(input.new_string));
  } else if (kind === 'multiedit' && Array.isArray(input.edits)) {
    hunks = input.edits.flatMap((e: Entry) => diffStrings(str(e?.old_string), str(e?.new_string)));
  } else if (kind === 'write') {
    hunks = diffStrings('', str(input.content));
  } else if (kind === 'notebook') {
    hunks = diffStrings('', str(input.new_source));
  }

  const change: Change = {
    id: block.id,
    timestamp,
    tool: block.name,
    kind,
    filePath,
    status: 'pending',
    created: false,
    hunks,
    added: 0,
    removed: 0,
    approximateLines: true,
    promptIndex: null,
  };
  if (subagent) change.subagent = subagent;
  countLines(change);
  return change;
}

function applyToolResult(change: Change, block: Entry, result: Entry) {
  if (block.is_error) {
    change.status = 'failed';
    change.error = resultText(block.content);
    return;
  }
  change.status = 'applied';
  if (!result || typeof result !== 'object') return;

  if (result.type === 'create') change.created = true;
  if (Array.isArray(result.structuredPatch) && result.structuredPatch.length > 0) {
    change.hunks = result.structuredPatch.map(normalizeHunk);
    change.approximateLines = false;
  } else if (change.created) {
    // A new file diffed against nothing already has its real line numbers.
    change.approximateLines = false;
  }
  countLines(change);
}

function resultText(content: Entry): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: Entry) => (typeof part?.text === 'string' ? part.text : ''))
      .join('\n');
  }
  return '';
}

function diffStrings(before: string, after: string): Hunk[] {
  if (before === after) return [];
  return structuredPatch('a', 'b', before, after, '', '', { context: 3 }).hunks.map(normalizeHunk);
}

function normalizeHunk(hunk: Entry): Hunk {
  const lines = Array.isArray(hunk?.lines) ? hunk.lines : [];
  return {
    oldStart: Number(hunk?.oldStart) || 0,
    oldLines: Number(hunk?.oldLines) || 0,
    newStart: Number(hunk?.newStart) || 0,
    newLines: Number(hunk?.newLines) || 0,
    lines: lines
      .filter((l: unknown): l is string => typeof l === 'string' && !l.startsWith('\\'))
      .map((l: string) => l.replace(/\r$/, '')),
  };
}

function countLines(change: Change) {
  change.added = 0;
  change.removed = 0;
  for (const hunk of change.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) change.added++;
      else if (line.startsWith('-')) change.removed++;
    }
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ');
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function toSummary(session: SessionDetail): SessionSummary {
  const { prompts: _prompts, changes: _changes, ...summary } = session;
  return summary;
}

/** Reads and caches parsed sessions, re-parsing a session only when its files change. */
export class TranscriptStore {
  readonly root: string;
  private cache = new Map<string, { key: string; session: SessionDetail }>();

  constructor(root: string = defaultProjectsRoot()) {
    this.root = root;
  }

  async list(): Promise<SessionSummary[]> {
    const all = await findSessionFiles(this.root);
    const sessions = await Promise.all(all.map((files) => this.load(files).catch(() => null)));
    return sessions
      .filter((s): s is SessionDetail => s !== null)
      .map(toSummary)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<SessionDetail | null> {
    const files = await this.files(id);
    return files ? this.load(files) : null;
  }

  /** A value that changes whenever any of the session's transcript files change. */
  async fingerprint(id: string): Promise<string | null> {
    const files = await this.files(id);
    return files ? fingerprintOf(files) : null;
  }

  private async files(id: string): Promise<SessionFiles | null> {
    return (await findSessionFiles(this.root)).find((f) => f.id === id) ?? null;
  }

  private async load(files: SessionFiles): Promise<SessionDetail> {
    const key = await fingerprintOf(files);
    const cached = this.cache.get(files.id);
    if (cached?.key === key) return cached.session;

    const paths = [files.main, ...files.subagents];
    const texts = await Promise.all(paths.map((p) => readFile(p, 'utf8')));
    const session = parseSession(
      files.id,
      texts.map((text, i) => (i === 0 ? { text } : { text, subagent: basename(paths[i], '.jsonl') })),
    );
    this.cache.set(files.id, { key, session });
    return session;
  }
}

async function fingerprintOf(files: SessionFiles): Promise<string> {
  const paths = [files.main, ...files.subagents];
  const stats = await Promise.all(paths.map((p) => stat(p)));
  return stats.map((s, i) => `${paths[i]}:${s.size}:${s.mtimeMs}`).join('|');
}
