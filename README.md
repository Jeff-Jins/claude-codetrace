# claude-codetrace

See what Claude Code changed in your code.

When Claude Code edits files, the changes scroll by as text in the terminal and are hard to follow. **codetrace** reads Claude Code's session transcripts and shows every edit as a readable diff in your browser: grouped by the prompt that caused it, or by file, and updated live while Claude works.

## Features

- **Session browser**: every Claude Code session on your machine, newest first, with change counts.
- **Timeline view**: each prompt you sent, followed by the file changes Claude made in response.
- **By-file view**: all changes to one file, in order.
- **Readable diffs**: line numbers and added/removed highlighting. Long diffs are truncated with a "show all" button.
- **Live updates**: new edits appear as Claude makes them, and the view can follow them.
- **Honest status**: edits you rejected or that failed are marked "not applied". Subagent edits are labeled.
- **Local only**: the server listens on `127.0.0.1` and only reads your transcript files.

## Requirements

- Node.js 20 or newer
- Claude Code, which stores transcripts in `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`)

## Getting started

```sh
git clone https://github.com/Jeff-Jins/claude-codetrace.git
cd claude-codetrace
npm install
npm run build
npm start
```

This opens `http://127.0.0.1:4777` in your browser.

### Options

```
codetrace [options]

  -p, --port <port>   Port to listen on (default: 4777)
  -r, --root <dir>    Claude Code projects directory (default: ~/.claude/projects)
      --no-open       Don't open a browser
  -h, --help          Show this help
```

## How it works

Claude Code writes each session to a JSONL transcript. codetrace reads the `Edit`, `MultiEdit`, `Write` and `NotebookEdit` tool calls in those transcripts and pairs each call with its result.

- If the result includes the patch Claude Code applied, codetrace shows it with real file line numbers.
- If it doesn't (for example, an edit that was rejected), codetrace diffs the old and new text from the tool call. Line numbers are then relative to the edited snippet, and the UI says so.

The transcript format is not a public API and may change between Claude Code versions. The parser skips anything it doesn't recognize instead of failing.

## Development

```sh
npm run dev        # rebuild on change (run `npm start` in another terminal)
npm test           # parser tests (Node's built-in test runner)
npm run typecheck  # TypeScript checks
```

Project layout:

```
src/
  cli.ts                 command-line entry point
  server/transcripts.ts  finds and parses transcripts into sessions and diffs
  server/server.ts       HTTP API, live events, static files
  shared/types.ts        data shapes shared by server and UI
  web/                   browser UI (no framework)
test/                    parser tests
```

## Roadmap

- Side-by-side diff view
- Syntax highlighting
- Net change per file across a whole session
- Search inside diffs
