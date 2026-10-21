import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { startServer } from './server/server.ts';
import { TranscriptStore, defaultProjectsRoot } from './server/transcripts.ts';

const HELP = `codetrace - see what Claude Code changed in your code

Usage: codetrace [options]

Options:
  -p, --port <port>   Port to listen on (default: 4777)
  -r, --root <dir>    Claude Code projects directory (default: ${defaultProjectsRoot()})
      --no-open       Don't open a browser
  -h, --help          Show this help
`;

const { values } = parseArgs({
  options: {
    port: { type: 'string', short: 'p', default: '4777' },
    root: { type: 'string', short: 'r' },
    'no-open': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid port: ${values.port}`);
  process.exit(1);
}

const store = new TranscriptStore(values.root ?? defaultProjectsRoot());
const { url } = await startServer(store, port);
console.log(`codetrace is running at ${url}`);
console.log(`Reading transcripts from ${store.root}`);
console.log('Press Ctrl+C to stop.');

if (!values['no-open']) openBrowser(url);

function openBrowser(url: string) {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => console.log(`Open ${url} in your browser.`));
  child.unref();
}
