import type { Change, Hunk, Prompt, SessionDetail, SessionSummary } from '../shared/types.ts';

type View = 'timeline' | 'files';

/** Diffs longer than this start truncated, with a button to show the rest. */
const PREVIEW_LINES = 80;
const LIST_REFRESH_MS = 10000;

const state = {
  sessions: [] as SessionSummary[],
  query: '',
  showEmpty: false,
  current: null as SessionDetail | null,
  view: 'timeline' as View,
  fileFilter: null as string | null,
  follow: true,
  connected: false,
  collapsed: new Set<string>(),
  expanded: new Set<string>(),
  seen: new Set<string>(),
  events: null as EventSource | null,
};

const listEl = document.getElementById('session-list')!;
const mainEl = document.getElementById('main')!;
const searchEl = document.getElementById('search') as HTMLInputElement;
const showEmptyEl = document.getElementById('show-empty') as HTMLInputElement;

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    if (key === 'class') el.className = value;
    else el.setAttribute(key, value);
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

// Formatting

function formatTime(iso: string): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
}

function formatWhen(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h ago`;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function relativePath(path: string, root: string): string {
  const normalized = path.replaceAll('\\', '/');
  const base = root.replaceAll('\\', '/').replace(/\/$/, '');
  if (base && normalized.toLowerCase().startsWith(`${base.toLowerCase()}/`)) {
    return normalized.slice(base.length + 1);
  }
  return normalized;
}

function counts(added: number, removed: number): HTMLElement {
  return h('span', { class: 'change-counts' }, h('span', { class: 'add' }, `+${added}`), ' ', h('span', { class: 'del' }, `−${removed}`));
}

// Sidebar

function renderSessionList() {
  const query = state.query.toLowerCase();
  const visible = state.sessions.filter(
    (s) =>
      (state.showEmpty || s.changeCount > 0 || s.id === state.current?.id) &&
      (!query || `${s.title} ${s.projectPath}`.toLowerCase().includes(query)),
  );

  if (visible.length === 0) {
    const message = state.sessions.length === 0
      ? 'No Claude Code sessions found yet.'
      : 'No sessions match. Try "Show sessions without changes".';
    listEl.replaceChildren(h('div', { class: 'list-empty' }, message));
    return;
  }

  listEl.replaceChildren(
    ...visible.map((s) => {
      const item = h(
        'button',
        { class: `session-item${s.id === state.current?.id ? ' selected' : ''}`, title: s.projectPath },
        h('span', { class: 'session-title' }, s.title),
        h(
          'span',
          { class: 'session-meta' },
          h('span', { class: 'project' }, s.projectName),
          h('span', {}, formatWhen(s.updatedAt)),
          h('span', { class: 'count' }, plural(s.changeCount, 'change')),
        ),
      );
      item.addEventListener('click', () => {
        location.hash = `#/s/${s.id}`;
      });
      return item;
    }),
  );
}

async function refreshSessionList() {
  try {
    state.sessions = await getJson<SessionSummary[]>('/api/sessions');
    renderSessionList();
  } catch (err) {
    listEl.replaceChildren(h('div', { class: 'list-empty' }, `Couldn't load sessions: ${(err as Error).message}`));
  }
}

// Session view

async function openSession(id: string) {
  state.events?.close();
  state.events = null;
  state.connected = false;
  state.fileFilter = null;
  state.collapsed.clear();
  state.expanded.clear();

  let session: SessionDetail;
  try {
    session = await getJson<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`);
  } catch (err) {
    state.current = null;
    mainEl.replaceChildren(h('div', { class: 'placeholder' }, `Couldn't load this session: ${(err as Error).message}`));
    renderSessionList();
    return;
  }
  state.current = session;
  state.seen = new Set(session.changes.map((c) => c.id));
  renderSession();
  renderSessionList();
  subscribe(id);
}

function subscribe(id: string) {
  const events = new EventSource(`/api/sessions/${encodeURIComponent(id)}/events`);
  state.events = events;
  events.addEventListener('open', () => setConnected(true));
  events.addEventListener('error', () => setConnected(false));
  events.addEventListener('change', () => {
    void reloadSession(id);
  });
}

function setConnected(connected: boolean) {
  state.connected = connected;
  mainEl.querySelector('.live')?.classList.toggle('connected', connected);
}

async function reloadSession(id: string) {
  let session: SessionDetail;
  try {
    session = await getJson<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`);
  } catch {
    return;
  }
  if (state.current?.id !== id) return;

  const fresh = session.changes.filter((c) => !state.seen.has(c.id)).map((c) => c.id);
  for (const changeId of fresh) state.seen.add(changeId);
  state.current = session;

  const scroller = mainEl.querySelector('.changes');
  const scrollTop = scroller?.scrollTop ?? 0;
  renderSession(new Set(fresh));
  const newScroller = mainEl.querySelector('.changes');
  if (newScroller) newScroller.scrollTop = scrollTop;

  if (state.follow && fresh.length > 0) {
    document.getElementById(`change-${fresh[fresh.length - 1]}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  void refreshSessionList();
}

function renderSession(fresh: Set<string> = new Set()) {
  const session = state.current;
  if (!session) return;

  mainEl.replaceChildren(
    renderHeader(session),
    session.changes.length === 0
      ? h('div', { class: 'placeholder' }, 'Claude has not changed any files in this session yet.')
      : h('div', { class: 'session-body' }, renderFileList(session), renderChanges(session, fresh)),
  );
}

function renderHeader(session: SessionDetail): HTMLElement {
  const viewButton = (view: View, label: string) => {
    const button = h('button', { class: state.view === view ? 'active' : undefined }, label);
    button.addEventListener('click', () => {
      state.view = view;
      renderSession();
    });
    return button;
  };

  const follow = h('input', { type: 'checkbox' });
  follow.checked = state.follow;
  follow.addEventListener('change', () => {
    state.follow = follow.checked;
  });

  return h(
    'header',
    { class: 'session-header' },
    h(
      'div',
      { class: 'header-title' },
      h('h1', {}, session.title),
      h('div', { class: 'meta' }, `${session.projectPath || session.projectName} · started ${formatWhen(session.startedAt)}`),
    ),
    h(
      'div',
      { class: 'stats' },
      `${plural(session.changeCount, 'change')} · ${plural(session.fileCount, 'file')} · `,
      counts(session.added, session.removed),
    ),
    h(
      'div',
      { class: 'controls' },
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'View' }, viewButton('timeline', 'Timeline'), viewButton('files', 'By file')),
      h(
        'span',
        { class: `live${state.connected ? ' connected' : ''}`, title: 'Updates automatically while Claude works' },
        h('span', { class: 'live-dot' }),
        'Live',
      ),
      h('label', { class: 'check', title: 'Scroll to new changes as they arrive' }, follow, 'Follow'),
    ),
  );
}

interface FileStats {
  path: string;
  changes: number;
  added: number;
  removed: number;
}

function fileStats(session: SessionDetail): FileStats[] {
  const byPath = new Map<string, FileStats>();
  for (const change of session.changes) {
    const stats = byPath.get(change.filePath) ?? { path: change.filePath, changes: 0, added: 0, removed: 0 };
    stats.changes++;
    stats.added += change.added;
    stats.removed += change.removed;
    byPath.set(change.filePath, stats);
  }
  return [...byPath.values()].sort((a, b) =>
    relativePath(a.path, session.projectPath).localeCompare(relativePath(b.path, session.projectPath)),
  );
}

function renderFileList(session: SessionDetail): HTMLElement {
  const item = (path: string | null, label: string, detail: Child, title?: string) => {
    const button = h(
      'button',
      { class: `file-item${state.fileFilter === path ? ' selected' : ''}`, title },
      h('span', { class: 'name' }, h('bdi', {}, label)),
      detail,
    );
    button.addEventListener('click', () => {
      state.fileFilter = path;
      renderSession();
    });
    return button;
  };

  const files = fileStats(session);
  return h(
    'nav',
    { class: 'file-list', 'aria-label': 'Changed files' },
    h('span', { class: 'group-label' }, 'Files'),
    item(null, `All files (${files.length})`, null),
    ...files.map((f) =>
      item(
        f.path,
        relativePath(f.path, session.projectPath),
        h('span', { class: 'n' }, `${f.changes}× `, counts(f.added, f.removed)),
        f.path,
      ),
    ),
  );
}

function renderChanges(session: SessionDetail, fresh: Set<string>): HTMLElement {
  const changes = state.fileFilter ? session.changes.filter((c) => c.filePath === state.fileFilter) : session.changes;
  const container = h('section', { class: 'changes' });

  if (state.view === 'timeline') {
    let lastPrompt: number | null | undefined;
    for (const change of changes) {
      if (change.promptIndex !== lastPrompt && change.promptIndex !== null) {
        const prompt = renderPrompt(session.prompts[change.promptIndex]);
        if (prompt) container.append(prompt);
      }
      lastPrompt = change.promptIndex;
      container.append(renderChange(change, session, fresh.has(change.id)));
    }
  } else {
    const groups = new Map<string, Change[]>();
    for (const change of changes) groups.set(change.filePath, [...(groups.get(change.filePath) ?? []), change]);
    for (const [path, group] of groups) {
      container.append(h('h2', { class: 'file-group-title', title: path }, relativePath(path, session.projectPath)));
      for (const change of group) container.append(renderChange(change, session, fresh.has(change.id), true));
    }
  }
  return container;
}

function renderPrompt(prompt: Prompt | undefined): HTMLElement | null {
  if (!prompt) return null;
  const text = h('div', { class: 'prompt-text clamped' }, prompt.text);
  const el = h('div', { class: 'prompt', title: 'Click to expand' }, h('span', { class: 'prompt-label' }, `You asked · ${formatTime(prompt.timestamp)}`), text);
  el.addEventListener('click', () => text.classList.toggle('clamped'));
  return el;
}

function renderChange(change: Change, session: SessionDetail, isNew: boolean, showPrompt = false): HTMLElement {
  const collapsed = state.collapsed.has(change.id);
  const header = h(
    'button',
    { class: 'change-header', 'aria-expanded': String(!collapsed) },
    h('span', { class: 'chevron', 'aria-hidden': 'true' }, '▾'),
    h('span', { class: 'badge' }, change.tool),
    change.subagent && h('span', { class: 'badge', title: change.subagent }, 'subagent'),
    change.created && h('span', { class: 'badge created' }, 'new file'),
    change.status === 'failed' && h('span', { class: 'badge failed' }, 'not applied'),
    change.status === 'pending' && h('span', { class: 'badge pending' }, 'pending'),
    h('span', { class: 'change-path', title: change.filePath }, relativePath(change.filePath, session.projectPath)),
    counts(change.added, change.removed),
    h('span', { class: 'change-time' }, formatTime(change.timestamp)),
  );

  const prompt = showPrompt && change.promptIndex !== null ? session.prompts[change.promptIndex] : undefined;
  const body = h(
    'div',
    { class: 'change-body' },
    prompt && h('div', { class: 'note' }, `For: ${prompt.text.length > 140 ? `${prompt.text.slice(0, 139)}…` : prompt.text}`),
    change.error && h('pre', { class: 'error' }, change.error.trim()),
    renderDiff(change),
    change.approximateLines &&
      change.hunks.length > 0 &&
      h('div', { class: 'note' }, 'Line numbers are relative to the edited snippet; the real file position was not recorded.'),
  );

  const card = h(
    'article',
    { class: `change${collapsed ? ' collapsed' : ''}${isNew ? ' new' : ''}`, id: `change-${change.id}` },
    header,
    body,
  );
  header.addEventListener('click', () => {
    const nowCollapsed = card.classList.toggle('collapsed');
    header.setAttribute('aria-expanded', String(!nowCollapsed));
    if (nowCollapsed) state.collapsed.add(change.id);
    else state.collapsed.delete(change.id);
  });
  return card;
}

function renderDiff(change: Change): HTMLElement {
  if (change.hunks.length === 0) return h('div', { class: 'empty-diff' }, 'No line changes.');

  const total = change.hunks.reduce((sum, hunk) => sum + hunk.lines.length + 1, 0);
  const limit = state.expanded.has(change.id) ? Infinity : PREVIEW_LINES;
  const table = h('table', { class: 'diff' });
  const tbody = h('tbody');
  table.append(tbody);

  let rendered = 0;
  for (const hunk of change.hunks) {
    if (rendered >= limit) break;
    tbody.append(hunkHeader(hunk));
    rendered++;
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (rendered >= limit) break;
      const sign = line[0];
      const code = line.slice(1);
      if (sign === '+') {
        tbody.append(diffRow('add', '', String(newLine++), '+', code));
      } else if (sign === '-') {
        tbody.append(diffRow('del', String(oldLine++), '', '−', code));
      } else {
        tbody.append(diffRow('ctx', String(oldLine++), String(newLine++), ' ', code));
      }
      rendered++;
    }
  }

  const wrapper = h('div', {}, h('div', { class: 'diff-scroll' }, table));
  if (total > rendered) {
    const more = h('button', { class: 'show-more' }, `Show all ${total} lines`);
    more.addEventListener('click', () => {
      state.expanded.add(change.id);
      wrapper.replaceWith(renderDiff(change));
    });
    wrapper.append(more);
  }
  return wrapper;
}

function hunkHeader(hunk: Hunk): HTMLElement {
  return h(
    'tr',
    { class: 'hunk' },
    h('td', { colspan: '4' }, `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`),
  );
}

function diffRow(kind: string, oldNo: string, newNo: string, sign: string, code: string): HTMLElement {
  return h(
    'tr',
    { class: kind },
    h('td', { class: 'ln' }, oldNo),
    h('td', { class: 'ln' }, newNo),
    h('td', { class: 'sign' }, sign),
    h('td', { class: 'code' }, code),
  );
}

// Routing

function route() {
  const match = /^#\/s\/([\w-]+)$/.exec(location.hash);
  if (match) {
    void openSession(match[1]);
  } else {
    state.events?.close();
    state.events = null;
    state.current = null;
    mainEl.replaceChildren(h('div', { class: 'placeholder' }, 'Pick a session to see what Claude changed.'));
    renderSessionList();
  }
}

searchEl.addEventListener('input', () => {
  state.query = searchEl.value;
  renderSessionList();
});

showEmptyEl.addEventListener('change', () => {
  state.showEmpty = showEmptyEl.checked;
  renderSessionList();
});

window.addEventListener('hashchange', route);

await refreshSessionList();
route();
setInterval(() => void refreshSessionList(), LIST_REFRESH_MS);
