import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSession } from '../src/server/transcripts.ts';

function jsonl(...entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n');
}

function userPrompt(text: string, timestamp: string) {
  return { type: 'user', timestamp, cwd: '/repo', message: { role: 'user', content: text } };
}

function toolUse(id: string, name: string, input: unknown, timestamp: string) {
  return {
    type: 'assistant',
    timestamp,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  };
}

function toolResult(id: string, timestamp: string, toolUseResult?: unknown, isError = false, content = 'ok') {
  return {
    type: 'user',
    timestamp,
    toolUseResult,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] },
  };
}

test('uses the structured patch from a successful Edit result', () => {
  const session = parseSession('s1', [
    {
      text: jsonl(
        userPrompt('rename the greeting', '2026-01-01T00:00:00Z'),
        toolUse('t1', 'Edit', { file_path: '/repo/a.ts', old_string: 'hello', new_string: 'hi' }, '2026-01-01T00:00:01Z'),
        toolResult('t1', '2026-01-01T00:00:02Z', {
          filePath: '/repo/a.ts',
          structuredPatch: [
            { oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, lines: [' a', '-hello', '+hi', ' b'] },
          ],
        }),
      ),
    },
  ]);

  assert.equal(session.changes.length, 1);
  const [change] = session.changes;
  assert.equal(change.status, 'applied');
  assert.equal(change.approximateLines, false);
  assert.equal(change.hunks[0].oldStart, 10);
  assert.equal(change.added, 1);
  assert.equal(change.removed, 1);
  assert.equal(change.promptIndex, 0);
  assert.equal(session.projectPath, '/repo');
  assert.equal(session.projectName, 'repo');
});

test('marks a rejected edit as failed and keeps the proposed diff', () => {
  const session = parseSession('s1', [
    {
      text: jsonl(
        toolUse('t1', 'Edit', { file_path: '/repo/a.ts', old_string: 'x = 1\n', new_string: 'x = 2\n' }, '2026-01-01T00:00:01Z'),
        toolResult('t1', '2026-01-01T00:00:02Z', 'Error: user rejected', true, 'The user rejected this edit'),
      ),
    },
  ]);

  const [change] = session.changes;
  assert.equal(change.status, 'failed');
  assert.equal(change.error, 'The user rejected this edit');
  assert.equal(change.approximateLines, true);
  assert.deepEqual(change.hunks[0].lines, ['-x = 1', '+x = 2']);
});

test('detects files created by Write', () => {
  const session = parseSession('s1', [
    {
      text: jsonl(
        toolUse('t1', 'Write', { file_path: '/repo/new.ts', content: 'one\ntwo\n' }, '2026-01-01T00:00:01Z'),
        toolResult('t1', '2026-01-01T00:00:02Z', { type: 'create', filePath: '/repo/new.ts', structuredPatch: [] }),
      ),
    },
  ]);

  const [change] = session.changes;
  assert.equal(change.created, true);
  assert.equal(change.approximateLines, false);
  assert.equal(change.added, 2);
  assert.equal(change.removed, 0);
});

test('expands MultiEdit into one diff per edit', () => {
  const session = parseSession('s1', [
    {
      text: jsonl(
        toolUse(
          't1',
          'MultiEdit',
          {
            file_path: '/repo/a.ts',
            edits: [
              { old_string: 'a', new_string: 'b' },
              { old_string: 'c', new_string: 'd' },
            ],
          },
          '2026-01-01T00:00:01Z',
        ),
      ),
    },
  ]);

  const [change] = session.changes;
  assert.equal(change.status, 'pending');
  assert.equal(change.hunks.length, 2);
  assert.equal(change.added, 2);
});

test('collects prompts, skips harness messages and links changes to the latest prompt', () => {
  const session = parseSession('s1', [
    {
      text: jsonl(
        { type: 'ai-title', aiTitle: 'Fix the parser' },
        userPrompt('first request', '2026-01-01T00:00:00Z'),
        userPrompt('<system-reminder>ignore me</system-reminder>', '2026-01-01T00:00:01Z'),
        userPrompt('<command-name>/review</command-name><command-args>src</command-args>', '2026-01-01T00:00:02Z'),
        { ...userPrompt('meta message', '2026-01-01T00:00:03Z'), isMeta: true },
        toolUse('t1', 'Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }, '2026-01-01T00:00:04Z'),
        'not json',
        userPrompt('second request', '2026-01-01T00:00:05Z'),
        toolUse('t2', 'Edit', { file_path: '/repo/b.ts', old_string: 'a', new_string: 'b' }, '2026-01-01T00:00:06Z'),
        toolUse('t3', 'Bash', { command: 'ls' }, '2026-01-01T00:00:07Z'),
      ),
    },
  ]);

  assert.equal(session.title, 'Fix the parser');
  assert.deepEqual(
    session.prompts.map((p) => p.text),
    ['first request', '/review src', 'second request'],
  );
  assert.deepEqual(
    session.changes.map((c) => c.promptIndex),
    [1, 2],
  );
  assert.equal(session.fileCount, 2);
  assert.equal(session.startedAt, '2026-01-01T00:00:00Z');
  assert.equal(session.updatedAt, '2026-01-01T00:00:07Z');
});

test('labels changes from subagent transcripts and orders them by time', () => {
  const session = parseSession('s1', [
    {
      text: jsonl(
        userPrompt('do it', '2026-01-01T00:00:00Z'),
        toolUse('t1', 'Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }, '2026-01-01T00:00:05Z'),
      ),
    },
    {
      subagent: 'agent-1',
      text: jsonl(
        userPrompt('subagent task text', '2026-01-01T00:00:01Z'),
        toolUse('t2', 'Write', { file_path: '/repo/c.ts', content: 'x' }, '2026-01-01T00:00:02Z'),
      ),
    },
  ]);

  assert.deepEqual(
    session.changes.map((c) => [c.id, c.subagent]),
    [
      ['t2', 'agent-1'],
      ['t1', undefined],
    ],
  );
  assert.equal(session.prompts.length, 1);
});

test('falls back to the first prompt for the title', () => {
  const session = parseSession('s1', [{ text: jsonl(userPrompt('make the button blue', '2026-01-01T00:00:00Z')) }]);
  assert.equal(session.title, 'make the button blue');
  assert.equal(session.changeCount, 0);
});
