import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles.css';
import { deriveKeys } from './crypto';
import { forget, passkeysSupported, recall, remember, remembered } from './device';
import { Pc, Remote, SignInError } from './remote';
import type { Account, Limit, Prompt, PromptAnswer, Row, Session, SessionAction } from './types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const icon = (id: string, size = 16) => `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#${id}"/></svg>`;
const meter = (percent: number) => `<span class="meter ${percent >= 80 ? 'hot' : ''}"><b data-w="${Math.round(Math.min(100, Math.max(0, percent || 0)))}"></b></span>`;
const phone = matchMedia('(max-width: 760px)');

// Tablets: accounts slide over from the right edge, and the session list can be hidden to give the transcript the width.
let drawerOpen = false;
let railHidden = false;
function setDrawer(open: boolean): void {
  drawerOpen = open;
  $('app').dataset.drawer = open ? 'open' : '';
  $('acc-btn').setAttribute('aria-expanded', String(open));
  if (open) setTimeout(() => $('side').querySelector<HTMLElement>('.close')?.focus({ preventScroll: true }), 300);
}
function setRail(hidden: boolean): void {
  railHidden = hidden;
  $('app').dataset.rail = hidden ? 'hidden' : '';
  const b = document.querySelector('.rail-btn');
  b?.setAttribute('aria-label', `${hidden ? 'Show' : 'Hide'} sessions`);
  b?.setAttribute('aria-expanded', String(!hidden));
}
const USERNAME_KEY = 'switcher-remote.username';
/** Account colours, in label order: told apart by name too, never by colour alone. */
const HUES = ['#7CC4FF', '#B9A3FF', '#7FE0C2', '#FF9EB5', '#FFD07A', '#9FE870', '#FFA98A', '#A5B4FF'];

let remote: Remote | undefined;
const ui = {
  sel: undefined as { pc: string; session: string } | undefined,
  view: 'list' as 'list' | 'session',
  /** What the transcript pane last drew, so it only redraws (and only animates) what changed. */
  drawn: { key: '', rows: undefined as Row[] | undefined, loaded: false, count: 0 },
  /** Set when you send a reply: the transcript follows it to the bottom however far up it was. */
  follow: false,
};

// ---------- formatting ----------

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

function inTime(ms: number): string {
  const m = Math.max(1, Math.ceil((ms - Date.now()) / 60_000));
  const [d, h, mm] = [Math.floor(m / 1440), Math.floor((m % 1440) / 60), m % 60];
  return d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`;
}

const folder = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;

/** Claude's text, kept as written: code fences and `code` stay code, **bold** stays bold, nothing else is interpreted. */
function md(text: string): string {
  return text
    .split('```')
    .map((part, i) => (i % 2 ? `<pre><code>${esc(part.replace(/^[\w+.-]*\n/, ''))}</code></pre>` : inline(part)))
    .join('');
}
const inline = (s: string) =>
  esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

// ---------- data ----------

const pcList = (): Pc[] =>
  [...(remote?.pcs.values() ?? [])].sort((a, b) => Number(b.online) - Number(a.online) || pcName(a).localeCompare(pcName(b)));
const pcName = (pc: Pc) => pc.state?.pc.name ?? (pc.unreadable ? 'A PC on another vault password' : 'A PC');

/** Every account across all PCs, the freshest usage reading winning. */
function accounts(): (Account & { hue: string })[] {
  const byId = new Map<string, Account>();
  for (const pc of pcList()) {
    for (const a of pc.state?.accounts ?? []) {
      const known = byId.get(a.id);
      if (!known || (a.seenAtMs ?? 0) > (known.seenAtMs ?? 0)) {
        byId.set(a.id, a);
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label)).map((a, i) => ({ ...a, hue: HUES[i % HUES.length] }));
}

function accountOf(pc: Pc, s: Session): { name: string; hue: string } {
  const all = accounts();
  const a = all.find((x) => x.id === s.accountId) ?? all.find((x) => s.email && x.email.toLowerCase() === s.email.toLowerCase());
  if (a) return { name: a.label, hue: a.hue };
  const local = pc.state?.accounts.find((x) => x.id === s.accountId);
  return { name: local?.label ?? s.email ?? 'Active account', hue: '#8A909A' };
}

/** Claude's open prompts, on every PC. */
const allPrompts = (): { pc: Pc; prompt: Prompt }[] => pcList().flatMap((pc) => (pc.online ? (pc.state?.prompts ?? []).map((prompt) => ({ pc, prompt })) : []));
const promptFor = (pc: Pc, session: string) => (pc.online ? pc.state?.prompts?.find((p) => p.session === session) : undefined);
const KIND: Record<Prompt['kind'], string> = { permission: 'Permission', question: 'Question', plan: 'Plan' };

const sessionsOf = (pc: Pc) => [...(pc.state?.sessions ?? [])].sort((a, b) => b.startedAt - a.startedAt);

function selected(): { pc: Pc; session?: Session } | undefined {
  const pc = ui.sel && remote?.pcs.get(ui.sel.pc);
  return pc ? { pc, session: pc.state?.sessions.find((s) => s.id === ui.sel!.session) } : undefined;
}

// ---------- unlock ----------

function drawHero(): void {
  // Placeholders around the relay (positions are the .pos-N and .pcpos-N classes): no real account is known yet.
  const demo = [62, 18, 88, 5];
  $('orbit-accs').innerHTML = demo
    .map(
      (p, i) => `<div class="node pos-${i}"><div class="counter"><div class="acc-chip">
        <span class="chip-name"><span class="dot" data-hue="${HUES[i]}"></span>Account ${i + 1}</span>
        ${meter(p)}<span class="mono chip-sub">5h ${p}%</span></div></div></div>`,
    )
    .join('');
  $('orbit-pcs').innerHTML = [0, 1, 2]
    .map((i) => `<div class="node pcpos-${i}"><div class="counter"><div class="pc-chip">${icon('i-pc', 14)}PC ${i + 1}<span class="dot sm dot-ok"></span></div></div></div>`)
    .join('');
}

function setupUnlock(): void {
  const form = $<HTMLFormElement>('unlock');
  const user = $<HTMLInputElement>('username');
  const pass = $<HTMLInputElement>('password');
  const btn = $<HTMLButtonElement>('unlock-btn');
  const error = $('unlock-error');
  const idle = btn.innerHTML;
  try {
    user.value = localStorage.getItem(USERNAME_KEY) ?? '';
  } catch {
    // Storage blocked: type it each time.
  }
  (user.value ? pass : user).focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    if (!user.value.trim() || !pass.value) {
      error.textContent = 'Enter your vault username and password.';
      error.hidden = false;
      (user.value.trim() ? pass : user).focus();
      return;
    }
    error.hidden = true;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>Deriving keys <span class="progress"><b></b></span>';
    const bar = btn.querySelector<HTMLElement>('.progress b')!;
    const keep = $<HTMLInputElement>('remember').checked;
    try {
      const keys = await deriveKeys(user.value, pass.value, (f) => (bar.style.width = `${Math.round(f * 100)}%`), keep);
      remote = await Remote.withKeys(user.value, keys);
      if (keep && keys.rawEnc) {
        const raw = keys.rawEnc;
        // After the app is up, so a passkey dialog never stands between someone and their sessions.
        setTimeout(() => {
          void remember(user.value.trim(), keys, raw).then(
            () => toast('Remembered: next time, unlock with your passkey.'),
            (err) => toast(`Not remembered: ${(err as Error).message}.`),
          ).finally(() => raw.fill(0));
        }, 600);
      }
    } catch (err) {
      error.textContent = err instanceof SignInError ? err.message : `Couldn't unlock (${(err as Error).message}).`;
      error.hidden = false;
      btn.disabled = false;
      btn.innerHTML = idle;
      pass.select();
      return;
    }
    try {
      localStorage.setItem(USERNAME_KEY, user.value.trim());
    } catch {
      // Not remembered.
    }
    pass.value = '';
    enterApp();
  });
  setupPasskey(user, error);
}

/** Shows the app once `remote` is signed in. */
function enterApp(): void {
  if (!remote) return;
  remote.onChange(scheduleDraw);
  drawBell();
  // This browser was subscribed before: make sure the vault account just unlocked has it too.
  if (notifyOn() && canPush) {
    void subscribePush().catch(() => undefined);
  }
  $('hero').classList.add('leaving');
  setTimeout(() => {
    $('hero').hidden = true;
    $('app').hidden = false;
    drawApp();
  }, 380);
}

/** "Unlock with passkey" when this device remembers a vault account; the checkbox to make it remember one. */
function setupPasskey(user: HTMLInputElement, error: HTMLElement): void {
  if (!passkeysSupported()) return;
  $('remember-box').hidden = false;
  void remembered().then((record) => {
    if (!record) return;
    $('passkey-box').hidden = false;
    $('passkey-user').textContent = `as ${record.username}`;
    user.value = record.username;
    $('passkey-btn').focus();
  });
  $('passkey-btn').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('passkey-btn');
    const record = await remembered();
    if (!record || btn.disabled) return;
    btn.disabled = true;
    error.hidden = true;
    try {
      remote = await Remote.withKeys(record.username, await recall(record));
      enterApp();
    } catch (err) {
      error.textContent = err instanceof SignInError ? err.message : `Couldn’t unlock with the passkey (${(err as Error).message}). Use your password.`;
      error.hidden = false;
      btn.disabled = false;
    }
  });
  $('passkey-forget').addEventListener('click', async () => {
    await forget();
    $('passkey-box').hidden = true;
    toast('This device no longer remembers your vault.');
  });
}

// ---------- app ----------

let frame = 0;
function scheduleDraw(): void {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(drawApp);
}

function drawApp(): void {
  // Not while the unlock screen is still leaving: a hidden pane can't be scrolled to its newest rows.
  if (!remote || $('app').hidden) return;
  notifyNewPrompts();
  if (!ui.sel && !phone.matches) {
    const first = pcList().find((pc) => pc.online && sessionsOf(pc).length);
    if (first) select(first.id, sessionsOf(first)[0].id);
  }
  drawBar();
  drawRail();
  drawMain();
  drawSide();
  paint();
}

/**
 * Widths, account colours and animation delays, set through the DOM: the page's Content-Security-Policy refuses
 * inline style attributes (so injected markup couldn't style anything), and allows this.
 */
function paint(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-w]').forEach((el) => (el.style.width = `${el.dataset.w}%`));
  root.querySelectorAll<HTMLElement>('[data-hue]').forEach((el) => (el.style.background = el.dataset.hue!));
  root.querySelectorAll<HTMLElement>('[data-delay]').forEach((el) => (el.style.animationDelay = `${el.dataset.delay}ms`));
}

function drawBar(): void {
  $('usage').innerHTML = accounts()
    .map((a) => {
      const five = a.limits.find((l) => l.key === '5h');
      return `<div class="usage-card"><span class="dot" data-hue="${a.hue}"></span>
        <div class="usage-body">
          <div class="top-line"><b class="usage-name">${esc(a.label)}</b><span class="mono usage-pct">${five ? `5h ${Math.round(five.percent)}%` : '—'}</span></div>
          ${meter(five?.percent ?? 0)}
        </div></div>`;
    })
    .join('');
  const conn = $('conn');
  conn.className = `conn ${remote!.connected ? '' : 'off'}`;
  conn.innerHTML = `<span class="dot"></span><span class="conn-text">${remote!.connected ? 'Live' : 'Reconnecting…'}</span>`;
  $('new-btn').hidden = !startablePcs().length;
  if (sheet) {
    drawSheet();
  }
  if (commandSheet) {
    drawCommandSheet();
  }
}

function drawRail(): void {
  const pcs = pcList();
  const total = pcs.reduce((n, pc) => n + sessionsOf(pc).length, 0);
  $('session-count').textContent = total ? String(total) : '';
  if (!pcs.length) {
    $('rail').innerHTML = `<div class="empty-note">${remote!.connected ? 'No PCs are sharing yet.' : 'Connecting to the relay…'}</div>`;
    return;
  }
  const waiting = allPrompts();
  document.title = waiting.length ? `(${waiting.length}) Switcher Remote` : 'Switcher Remote';
  const needs = waiting.length
    ? `<section class="group needs"><div class="group-head"><span class="dot sm pulse dot-need"></span>Needs you<small>${waiting.length}</small></div>${waiting
        .map(({ pc, prompt }) => {
          const s = pc.state?.sessions.find((x) => x.id === prompt.session);
          return `<button class="sess need" type="button" data-act="select" data-pc="${esc(pc.id)}" data-id="${esc(prompt.session)}">
            <span class="kind">${KIND[prompt.kind]}</span>
            <span class="sess-title"><span>${esc(prompt.title)}</span><span class="mono sess-age">${ago(prompt.at)}</span></span>
            <span class="meta">${esc(s?.title ?? 'A session')} · ${esc(pcName(pc))}</span>
          </button>`;
        })
        .join('')}</section>`
    : '';
  $('rail').innerHTML = needs + pcs
    .map((pc) => {
      const items = sessionsOf(pc);
      const note = !pc.online ? 'Offline' : `${items.length} session${items.length === 1 ? '' : 's'}`;
      const body = items.length
        ? items.map((s) => sessionButton(pc, s)).join('')
        : `<div class="empty-note">${
            pc.unreadable
              ? 'Shared under a different vault password, so this browser can’t read it.'
              : pc.online
                ? 'No Claude sessions open.'
                : 'VS Code isn’t open there, or it stopped sharing.'
          }</div>`;
      return `<section class="group">
        <div class="group-head"><span class="dot sm ${pc.online ? 'dot-ok' : 'dot-off'}"></span>${esc(pcName(pc))}<small>${note}</small></div>${body}</section>`;
    })
    .join('');
}

function sessionButton(pc: Pc, s: Session): string {
  const a = accountOf(pc, s);
  const on = ui.sel?.pc === pc.id && ui.sel.session === s.id;
  const need = promptFor(pc, s.id);
  const status = need
    ? `<span class="status need-pill"><span class="dot pulse dot-need"></span>Needs you · ${KIND[need.kind]}</span>`
    : s.working && pc.online
      ? `<span class="status live"><span class="dots"><i></i><i></i><i></i></span>Working</span>`
      : `<span class="status idle"><span class="dot dot-off"></span>${pc.online ? 'Idle' : 'Offline'}</span>`;
  return `<button class="sess ${on ? 'on' : ''}" type="button" data-act="select" data-pc="${esc(pc.id)}" data-id="${esc(s.id)}">
    <span class="sess-title"><span>${esc(s.title)}</span><span class="mono sess-age">${ago(s.startedAt)}</span></span>
    <span class="meta"><span class="mono sess-dir">${esc(folder(s.cwd))}</span><span class="sep">·</span><span class="acct-tag"><span class="dot sm" data-hue="${a.hue}"></span>${esc(a.name)}</span></span>
    <span class="sess-foot">${status}</span>
  </button>`;
}

/** Sessions asked to stop, until they go idle. */
const stopping = new Set<string>();

function drawMain(): void {
  const cur = selected();
  if (!cur) {
    $('main-head').innerHTML = '';
    $('main-head').hidden = true;
    $('response').hidden = true;
    $('controls').hidden = true;
    $('agents-panel').hidden = true;
    controlsKey = '';
    ui.drawn = { key: '', rows: undefined, loaded: false, count: 0 };
    $('pin-msg').textContent = '';
    $('pinbar').classList.remove('on');
    $('transcript').innerHTML = pcList().length
      ? `<div class="empty-big"><span class="serif">Pick a session</span><span>Its transcript appears here and follows along live.</span></div>`
      : `<div class="empty-big"><span class="serif">No PCs yet</span><span>In VS Code on each PC, connect to this vault and turn on <code>claudeSwitcher.remoteSessions</code>. Its sessions show up here within seconds.</span></div>`;
    return;
  }
  const { pc, session } = cur;
  if (session && !session.working) {
    stopping.delete(session.id);
  }
  const a = session ? accountOf(pc, session) : undefined;
  $('main-head').hidden = false;
  $('response').hidden = false;
  $('main-head').innerHTML = `
    <button class="btn btn-ghost btn-icon tab-only rail-btn" type="button" data-act="rail" aria-label="${railHidden ? 'Show' : 'Hide'} sessions" aria-expanded="${!railHidden}"><svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16M15.5 10l-2 2 2 2"/></g></svg></button>
    <button class="btn btn-ghost btn-icon back" type="button" data-act="back" aria-label="Back to sessions">${icon('i-back', 22)}</button>
    <div class="head-text">
      <h2>${esc(session?.title ?? (startingHere(pc.id, ui.sel!.session) ? 'Starting…' : 'Closed session'))}</h2>
      <div class="meta lg">${
        session
          ? `<span class="mono head-dir">${esc(folder(session.cwd))}</span><span class="sep">·</span>${esc(pcName(pc))}<span class="sep">·</span><span class="acct-tag lg"><span class="dot" data-hue="${a!.hue}"></span>${esc(a!.name)}</span>`
          : esc(pcName(pc))
      }</div>
    </div>
    ${
      pc.online && session?.working && session.remote && pc.state?.replies
        ? `<button class="btn btn-ghost btn-stop" type="button" data-act="stop" ${stopping.has(session.id) ? 'disabled' : ''}>${stopping.has(session.id) ? 'Stopping…' : 'Stop'}</button>`
        : ''
    }${
      pc.online && session && pc.state?.replies
        ? `<button class="switch" type="button" aria-pressed="${!!session.remote}" data-act="remote"><span class="track"><i></i></span>Remote</button>`
        : `<span class="ro">${icon('i-eye', 14)}Read-only</span>`
    }`;
  drawResponse(pc, session);
  drawControls(pc, session);
  drawTranscript();
}

/** Drafts kept per session, so switching sessions or a redraw never loses what was typed. */
const drafts = new Map<string, string>();
let responseKey = '';

/**
 * The response area: a reply box when this PC takes replies and the session's Remote switch is on, else why not.
 * Rebuilt only when that changes (never under the cursor of someone typing); the delivery line updates on its own.
 */
function drawResponse(pc: Pc, session: Session | undefined): void {
  const prompt = session && promptFor(pc, session.id);
  const mode = !pc.online ? 'offline' : !session ? 'closed' : prompt ? `prompt:${prompt.id}:${cardVersion}` : !pc.state?.replies ? 'no-replies' : !session.remote ? 'remote-off' : 'compose';
  const key = `${pc.id}/${session?.id ?? ''}/${mode}`;
  if (key !== responseKey) {
    responseKey = key;
    const note = (text: string, action = '') => `<div class="readonly">${icon('i-eye', 18)}<span>${text}</span>${action}</div>`;
    const name = esc(pcName(pc));
    clearAttachments();
    $('response').innerHTML =
      mode === 'offline'
        ? note(`${name} is offline. The transcript picks up again when it’s back.`)
        : mode === 'closed'
          ? note(startingHere(pc.id, ui.sel!.session) ? `Starting on ${name}: it shows up here as soon as it’s running.` : 'This session has closed in VS Code.')
          : mode === 'no-replies'
            ? note(`Read-only: ${name} doesn’t take replies. To reply from here, turn on <code>claudeSwitcher.remoteReplies</code> in VS Code there.`)
            : mode === 'remote-off'
              ? note(`Remote is off for this session, so replies stay in VS Code on ${name}.`, '<button class="btn btn-quiet" type="button" data-act="remote">Turn on Remote</button>')
              : prompt
                ? card(pc, prompt)
                : composer(pc, session!);
    const draft = $<HTMLTextAreaElement>('draft');
    if (draft) {
      draft.value = drafts.get(key) ?? '';
    }
  }
  drawSendStatus(pc, session);
  if (prompt) {
    drawCardStatus(prompt);
  }
}

// ---------- Notifications ----------

const NOTIFY_KEY = 'switcher-remote.notify';
const canNotify = 'Notification' in window && 'serviceWorker' in navigator;
const canPush = canNotify && 'PushManager' in window;
const notifyOn = () => {
  try {
    return localStorage.getItem(NOTIFY_KEY) === 'on' && Notification.permission === 'granted';
  } catch {
    return false;
  }
};
/** Prompts already seen on this page, so each notifies once (and none for what was waiting at unlock). */
let seenPrompts: Set<string> | undefined;

const worker = canNotify ? navigator.serviceWorker.register('./sw.js').catch(() => undefined) : Promise.resolve(undefined);

function drawBell(): void {
  const bell = $<HTMLButtonElement>('bell');
  bell.hidden = !canNotify;
  bell.setAttribute('aria-pressed', String(notifyOn()));
  bell.title = notifyOn() ? 'Notifications are on for this browser' : 'Notify me when Claude is waiting on me';
}

const fromBase64Url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

/** Subscribes this browser to the vault's pushes (nothing in them but "a prompt is waiting"). */
async function subscribePush(): Promise<void> {
  const reg = await worker;
  if (!reg || !canPush || !remote) return;
  const { key } = await remote.api<{ key: string }>('/api/push/key');
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(key) }));
  await remote.api('/api/push/subscribe', 'POST', { endpoint: sub.endpoint, origin: location.origin });
}

async function toggleNotifications(): Promise<void> {
  if (notifyOn()) {
    try {
      localStorage.removeItem(NOTIFY_KEY);
    } catch {
      // Not remembered.
    }
    const sub = await (await worker)?.pushManager?.getSubscription();
    if (sub) {
      await remote?.api('/api/push/unsubscribe', 'POST', { endpoint: sub.endpoint }).catch(() => undefined);
      await sub.unsubscribe().catch(() => undefined);
    }
    toast('Notifications off for this browser.');
  } else {
    if ((await Notification.requestPermission()) !== 'granted') {
      toast('Notifications are blocked for this site in the browser’s settings.');
      drawBell();
      return;
    }
    try {
      localStorage.setItem(NOTIFY_KEY, 'on');
    } catch {
      // Not remembered: on for this visit.
    }
    if (canPush) {
      await subscribePush().then(
        () => toast('Notifications on: you’ll hear when Claude is waiting on you, even with this closed.'),
        (err) => toast(`Notifications on while this is open (${(err as Error).message})`),
      );
    } else {
      const ios = /iPhone|iPad/.test(navigator.userAgent);
      toast(ios ? 'On iPhone, add this to your Home Screen (Share, then Add to Home Screen) for notifications while it’s closed.' : 'Notifications on while this page is open.');
    }
  }
  drawBell();
}

/** A notification for each new prompt while this page is in the background: it can say what's waiting, the push can't. */
function notifyNewPrompts(): void {
  const waiting = allPrompts();
  if (!seenPrompts) {
    seenPrompts = new Set(waiting.map(({ prompt }) => prompt.id));
    return;
  }
  const fresh = waiting.filter(({ prompt }) => !seenPrompts!.has(prompt.id));
  fresh.forEach(({ prompt }) => seenPrompts!.add(prompt.id));
  if (!fresh.length || !document.hidden || !notifyOn()) return;
  const { pc, prompt } = fresh[0];
  const s = pc.state?.sessions.find((x) => x.id === prompt.session);
  void worker.then((reg) =>
    reg?.showNotification(`${KIND[prompt.kind]}: ${prompt.title}`, {
      body: `${s?.title ?? 'A session'} · ${pcName(pc)}${fresh.length > 1 ? ` (and ${fresh.length - 1} more)` : ''}`,
      tag: 'needs-you',
      icon: 'icon-192.png',
    }),
  );
}

let toastTimer = 0;
function toast(text: string): void {
  const t = $('toast');
  t.querySelector('span')!.textContent = text;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('on'), 4000);
}

// ---------- session controls: model, effort, mode, context, subagents, commands, account ----------

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODES: [string, string][] = [
  ['default', 'Ask'],
  ['acceptEdits', 'Accept edits'],
  ['auto', 'Auto'],
];
const MODE_NAMES: Record<string, string> = { default: 'Ask', acceptEdits: 'Accept edits', auto: 'Auto', plan: 'Plan', bypassPermissions: 'Bypass', dontAsk: 'Don’t ask' };
let controlsKey = '';
let agentsOpen = false;
/** On a phone the controls fold into one line until opened. */
let controlsOpen = false;
/** Controls sent from this tab, waiting for the session to say how they went. */
const pendingResults = new Map<string, string>();

/**
 * The strip under the session's title. Read-only unless the session takes the web app's say (replies on, Remote on);
 * redrawn only when what it shows changes, and never under an open dropdown.
 */
function drawControls(pc: Pc, session: Session | undefined): void {
  const live = session?.live;
  const box = $('controls');
  const panel = $('agents-panel');
  if (!session || !live || !pc.online) {
    box.hidden = true;
    panel.hidden = true;
    controlsKey = '';
    return;
  }
  const can = !!(pc.state?.replies && session.remote);
  const accounts = (pc.state?.accounts ?? []).filter((a) => a.pinnable);
  const current = accounts.find((a) => a.id === session.accountId);
  const key = JSON.stringify([session.id, can, live, accounts.map((a) => a.id), session.accountId, agentsOpen, controlsOpen]);
  // An open dropdown is never redrawn under the pointer; a button that keeps focus after a click doesn't hold it back.
  if (key === controlsKey || (document.activeElement instanceof HTMLSelectElement && box.contains(document.activeElement))) {
    drawResults();
    return;
  }
  controlsKey = key;
  const dis = can ? '' : 'disabled';
  const option = (value: string, label: string, selected: boolean) => `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(label)}</option>`;
  const models = live.models?.length ? live.models : live.model ? [live.model] : [];
  const modelValue = models.find((m) => live.model?.includes(m)) ?? live.model ?? '';
  const percent = live.context?.percent;
  const agents = live.agents ?? [];
  const running = agents.filter((a) => a.status === 'running').length;
  box.hidden = false;
  box.classList.toggle('open', controlsOpen);
  const summary = [live.model ?? '—', live.effort, MODE_NAMES[live.pendingMode ?? live.mode ?? ''], percent === undefined ? undefined : `${Math.round(percent)}% context`].filter(Boolean).join(' · ');
  box.innerHTML = `
    <button class="ctl-summary" type="button" data-act="ctl-toggle" aria-expanded="${controlsOpen}">${esc(summary)}<span aria-hidden="true">${controlsOpen ? '▴' : '▾'}</span></button>
    <label class="ctl"><span>Model</span><select data-ctl="model" ${dis}>${
      models.includes(modelValue) ? '' : option(modelValue, live.model ?? '—', true)
    }${models.map((m) => option(m, m, m === modelValue)).join('')}</select></label>
    <label class="ctl"><span>Effort</span><select data-ctl="effort" ${dis}>${live.effort ? '' : option('', '—', true)}${EFFORTS.map((e) => option(e, e, e === live.effort)).join('')}</select></label>
    <label class="ctl"><span>Mode</span><select data-ctl="mode" ${dis}>${
      MODES.some(([m]) => m === live.mode) ? '' : option(live.mode ?? '', MODE_NAMES[live.mode ?? ''] ?? '—', true)
    }${MODES.map(([m, label]) => option(m, label, m === (live.pendingMode ?? live.mode))).join('')}</select>${
      live.pendingMode ? '<span class="ctl-note">from the next prompt</span>' : ''
    }</label>
    <div class="ctl ctx" title="${live.context?.tokens ? `${live.context.tokens.toLocaleString()} of ${(live.context.window ?? 0).toLocaleString()} tokens` : 'Fills in after the next reply'}">
      <span>Context</span>${meter(percent ?? 0)}<span class="mono">${percent === undefined ? '—' : `${Math.round(percent)}%`}</span>
      <button class="btn btn-quiet ctl-btn" type="button" data-act="compact" ${dis}>Compact now</button>
    </div>
    <button class="btn btn-quiet ctl-btn" type="button" data-act="agents" aria-expanded="${agentsOpen}">Agents ${agents.length ? `<span class="mono">${running}/${agents.length}</span>` : '<span class="mono">0</span>'}</button>
    <button class="btn btn-quiet ctl-btn" type="button" data-act="commands" ${dis}>/ Commands</button>
    ${
      accounts.length
        ? `<label class="ctl"><span>Account</span><select data-ctl="account" ${dis}>${current ? '' : option('', session.email ?? '—', true)}${accounts.map((a) => option(a.id, a.label, a.id === session.accountId)).join('')}</select></label>`
        : ''
    }`;
  panel.hidden = !agentsOpen;
  panel.innerHTML = agents.length
    ? agents
        .map(
          (a) => `<div class="agent-row"><span class="dot ${a.status === 'running' ? 'pulse dot-run' : 'dot-off'}"></span><span class="agent-name">${esc(a.name ?? a.type)}</span><span class="agent-desc">${esc(a.description)}</span><span class="mono agent-status">${esc(a.status)}</span></div>`,
        )
        .join('')
    : '<div class="empty-note">No subagents in this session yet.</div>';
  paint(box);
  drawResults();
}

/** Sends a control for the session on screen, and tells how it went when the session answers. */
async function sendControl(action: SessionAction, what: string): Promise<string | undefined> {
  const cur = selected();
  if (!cur?.session) return undefined;
  const ref = await remote!.control(cur.pc.id, cur.session.id, action);
  pendingResults.set(ref, what);
  drawResults();
  return ref;
}

function drawResults(): void {
  for (const [ref, what] of pendingResults) {
    const r = remote!.results.get(ref);
    if (!r) continue;
    pendingResults.delete(ref);
    if (what === 'commands') continue; // The sheet shows them.
    toast(r.ok ? (r.text?.trim() ? r.text.trim().slice(0, 180) : `${what}: done.`) : `${what}: ${r.error ?? 'not done'}`);
    if (what === 'Command' && commandSheet) {
      commandSheet.output = r.ok ? r.text?.trim() || 'Done.' : `Not run: ${r.error}`;
      drawCommandSheet();
    }
  }
}

/** The session's slash commands, to run one with arguments. */
let commandSheet: { filter: string; picked?: string; output?: string } | undefined;

function openCommandSheet(): void {
  const cur = selected();
  if (!cur?.session) return;
  commandSheet = { filter: '' };
  if (!remote!.sessionCommands(cur.pc.id, cur.session.id)) {
    void sendControl({ kind: 'commands' }, 'commands');
  }
  drawCommandSheet(true);
  $<HTMLInputElement>('cmd-filter').focus();
}

function drawCommandSheet(full = false): void {
  if (!commandSheet) return;
  const cur = selected();
  const list = cur?.session ? remote!.sessionCommands(cur.pc.id, cur.session.id) : undefined;
  const f = commandSheet.filter.toLowerCase();
  const shown = (list ?? []).filter((c) => !f || c.name.toLowerCase().includes(f) || c.description.toLowerCase().includes(f)).slice(0, 120);
  const rows = !list
    ? '<div class="empty-note">Asking the session for its commands…</div>'
    : shown.length
      ? shown
          .map(
            (c) => `<button class="cmd-row" type="button" data-act="cmd-pick" data-v="${esc(c.name)}" aria-pressed="${c.name === commandSheet!.picked}"><span class="mono cmd-name">/${esc(c.name)}</span><span class="cmd-desc">${esc(c.description)}</span><span class="cmd-src">${esc(c.source)}</span></button>`,
          )
          .join('')
      : '<div class="empty-note">No command matches.</div>';
  if (full || !document.getElementById('cmd-list')) {
    $('modal').innerHTML = `<div class="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="cmd-title">
      <div class="sheet-head"><div><h2 id="cmd-title" class="serif">Commands</h2><p>The slash commands this session has. Pick one, add arguments if it takes any, and run it there.</p></div>
        <button class="btn btn-ghost btn-icon" type="button" aria-label="Close" data-act="close"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></div>
      <label><span class="sr">Find a command</span><input class="input" id="cmd-filter" type="search" placeholder="Find a command" autocomplete="off"></label>
      <div class="cmd-list" id="cmd-list"></div>
      <div class="cmd-run"><span class="mono cmd-picked" id="cmd-picked"></span><label class="cmd-args"><span class="sr">Arguments</span><input class="input" id="cmd-args" type="text" maxlength="2000" placeholder="Arguments (optional)"></label><button class="btn btn-primary" type="button" data-act="cmd-run" id="cmd-run">Run</button></div>
      <pre class="cmd-output" id="cmd-output" hidden></pre>
    </div></div>`;
  }
  $('cmd-list').innerHTML = rows;
  $('cmd-picked').textContent = commandSheet.picked ? `/${commandSheet.picked}` : 'Pick a command';
  $<HTMLButtonElement>('cmd-run').disabled = !commandSheet.picked;
  $('cmd-output').hidden = !commandSheet.output;
  $('cmd-output').textContent = commandSheet.output ?? '';
}

// ---------- New session ----------

/** A session started from this tab that its PC doesn’t list yet. */
const startingHere = (pc: string, session: string) => [...remote!.starts.values()].some((s) => s.pc === pc && s.session === session);

/** PCs a session can be started on: online, taking replies, with allowed folders and a long-lived-token account. */
const startablePcs = () => pcList().filter((pc) => pc.online && pc.state?.replies && pc.state.repos?.length && pc.state.accounts.some((a) => a.pinnable));

/** The New session sheet while open: what's picked, and the start in flight. */
let sheet: { pc?: string; account?: string; repo?: string; text: string; ref?: string; error?: string } | undefined;

function openSheet(): void {
  const pc = startablePcs()[0];
  sheet = { pc: pc?.id, text: '' };
  drawSheet(true);
  $<HTMLTextAreaElement>('n-msg')?.focus();
}

function closeSheet(): void {
  sheet = undefined;
  commandSheet = undefined;
  $('modal').innerHTML = '';
}

/** Draws the sheet; `full` rebuilds it (opening), otherwise only its picks and status change, never the message box. */
function drawSheet(full = false): void {
  if (!sheet) return;
  const pcs = startablePcs();
  const pc = pcs.find((p) => p.id === sheet!.pc) ?? pcs[0];
  sheet.pc = pc?.id;
  const accounts = (pc?.state?.accounts ?? []).filter((a) => a.pinnable).sort((a, b) => a.label.localeCompare(b.label));
  if (!accounts.some((a) => a.id === sheet!.account)) sheet.account = accounts[0]?.id;
  const repos = pc?.state?.repos ?? [];
  if (!repos.some((r) => r.path === sheet!.repo)) sheet.repo = repos[0]?.path;
  const hue = (id: string) => accounts_hue(id);
  const start = sheet.ref ? remote!.starts.get(sheet.ref) : undefined;
  if (start?.status === 'started' && start.session) {
    const target = { pc: start.pc, session: start.session };
    closeSheet();
    openSession(target.pc, target.session);
    if (start.note) toast(start.note); // Something on the PC to do first, such as trusting the folder.
    return;
  }
  const busy = start?.status === 'starting';
  const status = busy ? 'Starting…' : start?.status === 'refused' ? `Not started: ${start.reason ?? 'refused'}` : sheet.error ?? '';
  const picks = `
    <fieldset><legend>PC</legend><div class="pick-list">${pcs
      .map((p) => `<button class="pick row-pick" type="button" aria-pressed="${p.id === pc?.id}" data-act="n-pc" data-v="${esc(p.id)}"><span class="dot dot-ok"></span><span class="pick-name">${esc(pcName(p))}</span><span class="right">${p.state!.repos!.length} folder${p.state!.repos!.length === 1 ? '' : 's'}</span></button>`)
      .join('')}</div></fieldset>
    <fieldset><legend>Account</legend><div class="acc-grid">${accounts
      .map((a) => {
        const five = a.limits.find((l) => l.key === '5h');
        return `<button class="pick col-pick" type="button" aria-pressed="${a.id === sheet!.account}" data-act="n-acc" data-v="${esc(a.id)}">
          <span class="pick-name"><span class="dot" data-hue="${hue(a.id)}"></span>${esc(a.label)}</span>
          ${meter(five?.percent ?? 0)}<span class="mono pick-sub">5h ${five ? Math.round(five.percent) : '–'}%</span></button>`;
      })
      .join('')}</div></fieldset>
    <fieldset><legend>Folder</legend><div class="pick-list">${repos
      .map((r) => `<button class="pick col-pick" type="button" aria-pressed="${r.path === sheet!.repo}" data-act="n-repo" data-v="${esc(r.path)}"><span class="mono pick-name">${esc(r.name)}</span><span class="mono pick-sub">${esc(r.path)}</span></button>`)
      .join('')}</div></fieldset>`;
  const account = accounts.find((a) => a.id === sheet!.account);
  const summary = pc && account ? `Starts Claude on ${esc(pcName(pc))} in a VS Code terminal, as ${esc(account.label)}, with Remote on. Your message goes in as soon as it’s running.` : '';
  if (full || !document.getElementById('n-picks')) {
    $('modal').innerHTML = `<div class="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="ns-title">
      <div class="sheet-head"><div><h2 id="ns-title" class="serif">New session</h2><p>Pick a PC, an account and a folder. It runs on that account’s own token: no switching.</p></div>
        <button class="btn btn-ghost btn-icon" type="button" aria-label="Close" data-act="close"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></div>
      <div id="n-picks" class="sheet-picks">${picks}</div>
      <label class="sheet-msg"><span class="label">First message</span><textarea class="input" id="n-msg" rows="3" maxlength="20000" placeholder="What should Claude do?"></textarea></label>
      <div class="foot"><span id="n-summary">${summary}</span><button class="btn btn-primary" type="button" data-act="start" id="n-start">Start session</button></div>
      <p class="send-status refused" id="n-status" role="status" aria-live="polite"></p>
    </div></div>`;
    $<HTMLTextAreaElement>('n-msg').value = sheet.text;
  } else {
    $('n-picks').innerHTML = picks;
    $('n-summary').innerHTML = summary;
  }
  $('n-status').textContent = status;
  $('n-status').className = `send-status ${busy ? 'queued' : 'refused'}`;
  $<HTMLButtonElement>('n-start').disabled = !!busy;
  paint($('modal'));
}

/** An account's colour as the rest of the page shows it. */
const accounts_hue = (id: string) => accounts().find((a) => a.id === id)?.hue ?? '#8A909A';

function startFromSheet(): void {
  if (!sheet) return;
  sheet.text = $<HTMLTextAreaElement>('n-msg').value;
  const text = sheet.text.trim();
  if (!sheet.pc || !sheet.account || !sheet.repo) {
    sheet.error = 'Pick a PC, an account and a folder.';
  } else if (!text) {
    sheet.error = 'Write the first message.';
    $<HTMLTextAreaElement>('n-msg').focus();
  } else {
    sheet.error = undefined;
    void remote!.start(sheet.pc, sheet.account, sheet.repo, text).then((ref) => {
      if (sheet) sheet.ref = ref;
      drawSheet();
    });
  }
  drawSheet();
}

// ---------- Claude's prompts ----------

/** What has been picked or typed on each prompt's card, so a redraw keeps it. */
const cards = new Map<string, { picks: Record<string, string[]>; other: Record<string, string>; open?: 'deny' | 'revise'; note: string }>();
/** Bumped to redraw the card itself (a section opened), which the response key otherwise keeps still. */
let cardVersion = 0;

const cardOf = (id: string) => {
  let c = cards.get(id);
  if (!c) {
    c = { picks: {}, other: {}, note: '' };
    cards.set(id, c);
  }
  return c;
};

function card(pc: Pc, p: Prompt): string {
  const c = cardOf(p.id);
  const head = (label: string) =>
    `<div class="dec-head"><span class="kind"><span class="dot pulse dot-need"></span>${label}</span><span class="hint">Or in VS Code on ${esc(pcName(pc))}: /answer-here</span></div>`;
  const busy = remote!.answers.get(p.id) && !remote!.answers.get(p.id)!.error;
  const dis = busy ? 'disabled' : '';
  let body = '';
  if (p.kind === 'permission') {
    body = `${head('Permission needed')}
      <p class="dec-q">${esc(p.title)}</p>
      ${p.detail ? `<div class="cmd"><div class="cmd-head">${icon('i-term', 14)}<span class="mono">${esc(p.tool)}</span></div><pre class="mono">${esc(p.detail)}</pre></div>` : ''}
      ${p.lines?.length ? `<div class="diff"><div class="diff-body mono">${p.lines.map((l) => `<span class="ln ${l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : ''}">${esc(l)}</span>`).join('')}</div></div>` : ''}
      ${p.note ? `<span class="dec-note">Claude says: ${esc(p.note)}</span>` : ''}
      ${c.open === 'deny' ? `<div class="inline enter"><label><span class="sr">Tell Claude why</span><input class="input" id="card-note" type="text" maxlength="2000" placeholder="Tell Claude why, or what to do instead"></label><button class="btn btn-quiet" type="button" data-act="answer" data-v="deny" ${dis}>Deny and send</button></div>` : ''}
      <div class="actions"><button class="btn btn-accent" type="button" data-act="answer" data-v="allow" ${dis}>Allow once</button>${
        p.canRemember ? `<button class="btn btn-quiet" type="button" data-act="answer" data-v="remember" ${dis}>Allow for this session</button>` : ''
      }<button class="btn btn-ghost push" type="button" data-act="open" data-v="deny" ${dis}>Deny…</button></div>`;
  } else if (p.kind === 'question') {
    body = `${head('Claude is asking')}${(p.questions ?? [])
      .map(
        (q, qi) => `<div class="question">
        ${q.header ? `<span class="tag">${esc(q.header)}</span>` : ''}<p class="dec-q">${esc(q.question)}</p>
        <div class="opts">${q.options
          .map(
            (o) => `<button class="opt ${q.multiSelect ? 'multi' : ''}" type="button" aria-pressed="${(c.picks[q.question] ?? []).includes(o.label)}" data-act="pick" data-q="${qi}" data-v="${esc(o.label)}" ${dis}>
              <span class="radio"><i></i></span><span><strong>${esc(o.label)}</strong>${o.description ? `<small>${esc(o.description)}</small>` : ''}</span></button>`,
          )
          .join('')}</div>
        <label><span class="sr">Your own answer</span><input class="input other" type="text" maxlength="2000" data-q="${qi}" placeholder="Or type your own answer" value="${esc(c.other[q.question] ?? '')}" ${dis}></label>
      </div>`,
      )
      .join('')}
      <div class="actions"><button class="btn btn-accent" type="button" data-act="answer" data-v="answers" ${dis}>Send answer</button></div>`;
  } else {
    body = `${head('Plan ready for review')}
      <div class="plan-text md">${md(p.plan ?? '')}</div>
      ${c.open === 'revise' ? `<div class="inline enter"><label><span class="sr">What should change</span><textarea class="input" id="card-note" rows="2" maxlength="4000" placeholder="What should change in the plan?"></textarea></label><button class="btn btn-quiet" type="button" data-act="answer" data-v="revise" ${dis}>Send feedback</button></div>` : ''}
      <div class="actions"><button class="btn btn-accent" type="button" data-act="answer" data-v="approve-auto" ${dis}>Approve, accept edits</button><button class="btn btn-quiet" type="button" data-act="answer" data-v="approve" ${dis}>Approve, ask before edits</button><button class="btn btn-ghost push" type="button" data-act="open" data-v="revise" ${dis}>Keep planning…</button></div>`;
  }
  return `<div class="decision enter" id="decision" data-prompt="${esc(p.id)}">${body}<p class="send-status refused" id="card-status" role="status" aria-live="polite"></p></div>`;
}

function drawCardStatus(p: Prompt): void {
  const a = remote!.answers.get(p.id);
  const line = document.getElementById('card-status');
  if (line) {
    line.textContent = a?.error ? `Not taken: ${a.error}` : '';
  }
  if (a?.error) {
    document.querySelectorAll<HTMLButtonElement>('#decision button, #decision input, #decision textarea').forEach((el) => (el.disabled = false));
  }
}

/** The answer a card's button stands for, from what was picked or typed on it. */
function answerFor(p: Prompt, which: string): PromptAnswer | string {
  const c = cardOf(p.id);
  const note = ($<HTMLInputElement>('card-note')?.value ?? c.note).trim();
  switch (which) {
    case 'allow':
      return { kind: 'allow' };
    case 'remember':
      return { kind: 'allow', remember: true };
    case 'deny':
      return { kind: 'deny', message: note };
    case 'approve-auto':
      return { kind: 'approve', mode: 'acceptEdits' };
    case 'approve':
      return { kind: 'approve', mode: 'default' };
    case 'revise':
      return note ? { kind: 'revise', message: note } : 'Say what should change first.';
    case 'answers': {
      const answers: Record<string, string> = {};
      for (const q of p.questions ?? []) {
        const typed = c.other[q.question]?.trim();
        const picked = c.picks[q.question] ?? [];
        if (typed || picked.length) {
          answers[q.question] = typed || picked.join(', ');
        }
      }
      return Object.keys(answers).length ? { kind: 'answers', answers } : 'Pick or type an answer first.';
    }
  }
  return 'Unknown answer.';
}

function composer(pc: Pc, session: Session): string {
  const a = accountOf(pc, session);
  return `<form class="enter" id="composer"><div class="composer" id="composer-box">
    <div class="attachments" id="attachments" hidden></div>
    <label><span class="sr">Reply to Claude</span><textarea class="input" id="draft" rows="2" enterkeyhint="send" maxlength="20000" placeholder="Reply to Claude… (paste or drop images too)"></textarea></label>
    <div class="composer-row"><label class="btn btn-ghost btn-icon attach" title="Attach images"><span class="sr">Attach images</span><input type="file" id="file-input" accept="image/png,image/jpeg,image/webp,image/gif" multiple><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7-7l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></label>${['Continue', 'Run the tests', 'Commit it'].map((c) => `<button class="chip" type="button" data-act="chip" data-v="${c}">${c}</button>`).join('')}
      <span class="hint">Sends to ${esc(pcName(pc))} as ${esc(a.name)}</span>
      <button class="btn btn-primary btn-icon" type="submit" aria-label="Send"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    </div></div>
    <p class="send-status" id="send-status" role="status" aria-live="polite"></p></form>`;
}

function drawSendStatus(pc: Pc, session: Session | undefined): void {
  const line = document.getElementById('send-status');
  const last = session && remote!.lastReply(pc.id, session.id);
  if (!line) {
    return;
  }
  const text = !last
    ? ''
    : last.status === 'uploading'
      ? 'Uploading images…'
      : last.status === 'sending'
      ? 'Sending…'
      : last.status === 'queued'
        ? `Queued on ${pcName(pc)}: Claude gets it as soon as it finishes what it’s doing.`
        : last.status === 'delivered'
          ? 'Delivered.'
          : `Not sent: ${last.reason ?? 'refused'}`;
  line.textContent = text;
  line.className = `send-status ${last?.status ?? ''}`;
}

function sendDraft(): void {
  const cur = selected();
  const draft = $<HTMLTextAreaElement>('draft');
  const text = draft?.value.trim() ?? '';
  if (!cur?.session || !draft || (!text && !attachments.length)) {
    draft?.focus();
    return;
  }
  ui.follow = true;
  void remote!.send(
    cur.pc.id,
    cur.session.id,
    text,
    attachments.map((a) => ({ blob: a.blob, mime: a.mime })),
  );
  draft.value = '';
  drafts.delete(responseKey);
  clearAttachments();
}

// ---------- images ----------

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_ATTACHMENTS = 4;
/** Images over these are scaled down here before they're sent: Claude reads them fine, and they travel fast. */
const MAX_SIDE = 2000;
const KEEP_AS_IS_BYTES = 1.5 * 1024 * 1024;
let attachments: { blob: Blob; mime: string; url: string }[] = [];

function clearAttachments(): void {
  attachments.forEach((a) => URL.revokeObjectURL(a.url));
  attachments = [];
  drawAttachments();
}

function drawAttachments(): void {
  const box = document.getElementById('attachments');
  if (!box) return;
  box.hidden = !attachments.length;
  box.innerHTML = attachments
    .map((a, i) => `<span class="thumb"><img src="${a.url}" alt="Image ${i + 1} to send"><button type="button" data-act="unattach" data-v="${i}" aria-label="Remove image ${i + 1}">×</button></span>`)
    .join('');
}

/** Scales an image down if it's large; GIFs (which may move) and small images go as they are. */
async function prepareImage(file: Blob): Promise<{ blob: Blob; mime: string }> {
  if (!IMAGE_TYPES.includes(file.type)) {
    throw new Error('Only PNG, JPEG, WebP or GIF images can be sent.');
  }
  if (file.type === 'image/gif') {
    if (file.size > 4 * 1024 * 1024) throw new Error('That GIF is over 4 MB.');
    return { blob: file, mime: file.type };
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= KEEP_AS_IS_BYTES) {
    bitmap.close();
    return { blob: file, mime: file.type };
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const encode = (type: string) => new Promise<Blob | null>((ok) => canvas.toBlob(ok, type, 0.86));
  // Some browsers can't make WebP and hand back a PNG instead; JPEG then.
  let blob = await encode('image/webp');
  if (!blob || blob.type !== 'image/webp') blob = await encode('image/jpeg');
  if (!blob) throw new Error('That image couldn’t be read.');
  return { blob, mime: blob.type };
}

async function addImages(files: Blob[]): Promise<void> {
  for (const file of files) {
    if (attachments.length >= MAX_ATTACHMENTS) {
      toast(`At most ${MAX_ATTACHMENTS} images a reply.`);
      break;
    }
    try {
      const { blob, mime } = await prepareImage(file);
      attachments.push({ blob, mime, url: URL.createObjectURL(blob) });
    } catch (err) {
      toast((err as Error).message);
    }
  }
  drawAttachments();
}

function drawTranscript(): void {
  const sel = ui.sel!;
  const key = `${sel.pc}/${sel.session}`;
  const t = remote!.transcript(sel.pc, sel.session);
  const box = $('transcript-box');
  const same = ui.drawn.key === key;
  if (same && ui.drawn.rows === t?.rows && ui.drawn.loaded === !!t?.loaded) {
    return; // Nothing new: leave the pane alone (and any text being selected in it).
  }
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  $('pin-msg').textContent = ''; // Set again below when there are rows.
  if (!t?.loaded) {
    $('transcript').innerHTML = `<div class="loading-rows"><span class="dots"><i></i><i></i><i></i></span>Loading the transcript…</div>`;
  } else if (t.missing) {
    $('transcript').innerHTML = `<div class="empty-big"><span>This session’s transcript isn’t on ${esc(pcName(remote!.pcs.get(sel.pc)!))} any more.</span></div>`;
  } else if (!t.rows.length) {
    const begun = [...remote!.starts.values()].find((st) => st.pc === sel.pc && st.session === sel.session);
    const empty = begun
      ? `Claude is starting on ${esc(pcName(remote!.pcs.get(sel.pc)!))}. Your first message goes in as soon as it’s ready.${begun.note ? `<br><br>${esc(begun.note)}` : ''}`
      : 'Nothing in this session yet.';
    $('transcript').innerHTML = `<div class="empty-big"><span>${empty}</span></div>`;
  } else {
    // Rows already on screen stay still; only new ones rise in.
    const all = finalOnly(t.rows);
    const shown = all.slice(-SHOW_MESSAGES);
    const from = same && ui.drawn.loaded ? Math.min(ui.drawn.count, shown.length) : 0;
    const stagger = from === 0;
    const lastUser = shown.map((r) => r.t).lastIndexOf('user');
    const mark = (i: number) => (i === lastUser ? ' id="last-user"' : '');
    const older = t.trimmed || all.length > shown.length ? `<div class="older-note">Earlier messages are in VS Code on ${esc(pcName(remote!.pcs.get(sel.pc)!))}.</div>` : '';
    $('transcript').innerHTML = older + shown
      .map((r, i) => (i < from ? `<div${mark(i)}>${row(r)}</div>` : `<div${mark(i)} class="row-in" data-delay="${stagger ? Math.max(0, Math.min(i - (shown.length - 8), 8)) * 40 : (i - from) * 40}">${row(r)}</div>`))
      .join('');
    const last = shown[lastUser];
    $('pin-msg').textContent = last?.t === 'user' ? last.text : '';
  }
  // Opening a session (or its rows arriving) lands on the newest; new rows follow along only if you were at the bottom.
  const firstRows = !same || !ui.drawn.loaded;
  if (firstRows || nearBottom || ui.follow) {
    ui.follow = false;
    box.scrollTo({ top: box.scrollHeight, behavior: firstRows ? 'auto' : 'smooth' });
  }
  ui.drawn = { key, rows: t?.rows, loaded: !!t?.loaded, count: t?.rows ? Math.min(finalOnly(t.rows).length, SHOW_MESSAGES) : 0 };
  placePin();
}

/**
 * The last message you sent stays in sight: once it has scrolled up out of view, a copy sits at the top of the
 * transcript (like VS Code's Claude chat), and tapping it scrolls back to it. A bar over the pane, so nothing moves.
 */
function placePin(): void {
  const msg = document.getElementById('last-user');
  const box = $('transcript-box');
  const on = !!msg && !!$('pin-msg').textContent && msg.getBoundingClientRect().bottom < box.getBoundingClientRect().top + 8;
  $('pinbar').classList.toggle('on', on);
  $('pin-msg').tabIndex = on ? 0 : -1;
}
let pinFrame = 0;
$('transcript-box').addEventListener('scroll', () => {
  cancelAnimationFrame(pinFrame);
  pinFrame = requestAnimationFrame(placePin);
}, { passive: true });

/**
 * What the web app shows of a session: your messages, Claude's last words before each of them (its answer), and its
 * plans and questions. Tool calls, edits and the steps in between stay in VS Code.
 */
/** Messages shown per session; the rest of the conversation is in VS Code. */
const SHOW_MESSAGES = 50;

function finalOnly(rows: Row[]): Row[] {
  return rows.filter((r, i) => {
    if (r.t !== 'text') return r.t === 'user' || r.t === 'plan' || r.t === 'question';
    const next = rows.slice(i + 1).find((x) => x.t === 'text' || x.t === 'user');
    return !next || next.t === 'user';
  });
}

function row(r: Row): string {
  switch (r.t) {
    case 'user':
      return `<div class="msg-user"><div class="md">${md(r.text)}</div></div>`;
    case 'text':
      return `<div class="msg-text">${icon('i-claude', 20)}<div class="md">${md(r.text)}</div></div>`;
    case 'tool':
      return `<div class="tool"><span class="tool-name mono">${esc(r.name)}</span><span class="tool-target mono">${esc(r.target)}</span></div>`;
    case 'diff':
      return `<div class="diff"><div class="diff-head"><span class="tool-name mono">Edit</span><span class="tool-target mono">${esc(r.file)}</span><span class="mono n-add">+${r.add}</span><span class="mono n-del">−${r.del}</span></div>
        <div class="diff-body mono">${r.lines.map((l) => `<span class="ln ${l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : ''}">${esc(l)}</span>`).join('')}</div></div>`;
    case 'plan':
      return `<div class="plan"><span class="kind muted">Plan</span><div class="md">${md(r.text)}</div></div>`;
    case 'question':
      return r.questions
        .map((q) => `<div class="question-row"><span class="kind">Claude asked</span><p>${esc(q.question)}</p><ul>${q.options.map((o) => `<li>${esc(o)}</li>`).join('')}</ul></div>`)
        .join('');
  }
  return '';
}

function drawSide(): void {
  const list = accounts();
  $('accounts').innerHTML = list.length
    ? list
        .map(
          (a) => `<div class="acct">
      <div class="acct-head"><span class="dot" data-hue="${a.hue}"></span>${esc(a.label)}${a.plan ? `<small>${esc(plan(a.plan))}</small>` : ''}</div>
      <div class="acct-email">${esc(a.email)}</div>
      ${a.limits.length ? a.limits.map(limit).join('') : '<span class="note">No usage read yet.</span>'}
      ${a.seenAtMs ? `<span class="note">Read ${ago(a.seenAtMs) === 'now' ? 'just now' : `${ago(a.seenAtMs)} ago`}</span>` : ''}
    </div>`,
        )
        .join('')
    : '<div class="empty-note">Accounts appear once a PC shares.</div>';
  $('pcs').innerHTML = pcList()
    .map((pc) => {
      const n = sessionsOf(pc).length;
      return `<div class="pc"><span class="ic ${pc.online ? 'ic-on' : 'ic-off'}">${icon('i-pc', 18)}</span>
        <div><strong>${esc(pcName(pc))}</strong><span>${pc.online ? `Sharing · ${n} session${n === 1 ? '' : 's'}` : 'Offline'}</span></div>
        <span class="dot ${pc.online ? 'dot-ok' : 'dot-off'}"></span></div>`;
    })
    .join('');
}

const plan = (p: string) => ({ max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' })[p] ?? p;

function limit(l: Limit): string {
  // Once a window has reset nothing of it is used, until the next reading says otherwise.
  const live = !l.resetsAtMs || l.resetsAtMs > Date.now();
  const percent = live ? Math.round(l.percent) : 0;
  return `<div class="limit"><div class="limit-top"><span>${esc(l.name)}</span><span class="mono">${percent}%${live && l.resetsAtMs ? ` · resets in ${inTime(l.resetsAtMs)}` : ''}</span></div>${meter(percent)}</div>`;
}

// ---------- navigation ----------

function select(pc: string, session: string): void {
  ui.sel = { pc, session };
  remote?.watch(pc, session);
}

function setView(v: 'list' | 'session'): void {
  ui.view = v;
  $('app').dataset.view = v;
}

function openSession(pc: string, session: string): void {
  select(pc, session);
  if (phone.matches && ui.view !== 'session') history.pushState({ session: true }, '');
  setView('session');
  drawApp();
}

function goBack(): void {
  if (history.state?.session) history.back();
  else setView('list');
}

addEventListener('popstate', () => setView('list'));
addEventListener('remote-signed-out', () => location.reload());
// The keys are gone with the page, so its vault sign-in should go too.
addEventListener('pagehide', () => remote?.leave());

document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el) return;
  switch (el.dataset.act) {
    case 'select':
      return openSession(el.dataset.pc!, el.dataset.id!);
    case 'back':
      return goBack();
    case 'drawer':
      return setDrawer(!drawerOpen);
    case 'pin-jump': {
      const box = $('transcript-box');
      const msg = document.getElementById('last-user');
      if (msg) box.scrollTo({ top: box.scrollTop + msg.getBoundingClientRect().top - box.getBoundingClientRect().top - 12, behavior: 'smooth' });
      return;
    }
    case 'rail':
      return setRail(!railHidden);
    case 'tab':
      $('app').dataset.tab = el.dataset.v!;
      document.querySelectorAll('.tabbar button').forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
      return scrollTo(0, 0);
    case 'stop': {
      const cur = selected();
      if (cur?.session) {
        stopping.add(cur.session.id);
        remote!.stop(cur.pc.id, cur.session.id);
        drawApp();
      }
      return;
    }
    case 'remote': {
      const cur = selected();
      if (cur?.session) {
        remote!.setRemote(cur.pc.id, cur.session.id, !cur.session.remote);
      }
      return;
    }
    case 'new':
      return openSheet();
    case 'compact':
      void sendControl({ kind: 'compact' }, 'Compact');
      toast('Compacting once the session is idle…');
      return;
    case 'ctl-toggle':
      controlsOpen = !controlsOpen;
      controlsKey = '';
      drawApp();
      return;
    case 'agents':
      agentsOpen = !agentsOpen;
      controlsKey = '';
      drawApp();
      return;
    case 'commands':
      return openCommandSheet();
    case 'cmd-pick':
      if (commandSheet) {
        commandSheet.picked = el.dataset.v;
        drawCommandSheet();
        $<HTMLInputElement>('cmd-args').focus();
      }
      return;
    case 'cmd-run':
      if (commandSheet?.picked) {
        commandSheet.output = `Running /${commandSheet.picked}…`;
        void sendControl({ kind: 'command', name: commandSheet.picked, args: $<HTMLInputElement>('cmd-args').value.trim() }, 'Command');
        drawCommandSheet();
      }
      return;
    case 'bell':
      void toggleNotifications();
      return;
    case 'close':
      return closeSheet();
    case 'n-pc':
    case 'n-acc':
    case 'n-repo':
      if (sheet) {
        sheet.text = $<HTMLTextAreaElement>('n-msg').value;
        if (el.dataset.act === 'n-pc') sheet.pc = el.dataset.v;
        if (el.dataset.act === 'n-acc') sheet.account = el.dataset.v;
        if (el.dataset.act === 'n-repo') sheet.repo = el.dataset.v;
        drawSheet();
      }
      return;
    case 'start':
      return startFromSheet();
    case 'pick': {
      const cur = selected();
      const p = cur?.session && promptFor(cur.pc, cur.session.id);
      const q = p?.questions?.[Number(el.dataset.q)];
      if (!p || !q) return;
      const c = cardOf(p.id);
      const label = el.dataset.v!;
      const now = c.picks[q.question] ?? [];
      c.picks[q.question] = q.multiSelect ? (now.includes(label) ? now.filter((x) => x !== label) : [...now, label]) : [label];
      c.other[q.question] = '';
      el.closest('.question')!.querySelectorAll<HTMLElement>('.opt').forEach((b) => b.setAttribute('aria-pressed', String(c.picks[q.question]!.includes(b.dataset.v!))));
      const other = el.closest('.question')!.querySelector<HTMLInputElement>('.other');
      if (other) other.value = '';
      return;
    }
    case 'open': {
      const cur = selected();
      const p = cur?.session && promptFor(cur.pc, cur.session.id);
      if (!p) return;
      const c = cardOf(p.id);
      c.open = c.open === el.dataset.v ? undefined : (el.dataset.v as 'deny' | 'revise');
      cardVersion++;
      drawApp();
      $<HTMLInputElement>('card-note')?.focus();
      return;
    }
    case 'answer': {
      const cur = selected();
      const p = cur?.session && promptFor(cur.pc, cur.session.id);
      if (!cur || !p) return;
      const a = answerFor(p, el.dataset.v!);
      const line = document.getElementById('card-status');
      if (typeof a === 'string') {
        if (line) line.textContent = a;
        return;
      }
      document.getElementById('decision')?.classList.add('leaving');
      document.querySelectorAll<HTMLButtonElement>('#decision button, #decision input, #decision textarea').forEach((b) => (b.disabled = true));
      void remote!.answer(cur.pc.id, cur.session!.id, p.id, a);
      return;
    }
    case 'unattach': {
      const [gone] = attachments.splice(Number(el.dataset.v), 1);
      if (gone) URL.revokeObjectURL(gone.url);
      drawAttachments();
      return;
    }
    case 'chip': {
      const draft = $<HTMLTextAreaElement>('draft');
      if (draft) {
        draft.value = el.dataset.v!;
        drafts.set(responseKey, draft.value);
        draft.focus();
      }
      return;
    }
    case 'lock':
      void remote?.signOut().finally(() => location.reload());
      return;
  }
});

document.addEventListener('submit', (e) => {
  if ((e.target as HTMLElement).id === 'composer') {
    e.preventDefault();
    sendDraft();
  }
});

document.addEventListener('paste', (e) => {
  if ((e.target as HTMLElement).id !== 'draft') return;
  const images = [...(e.clipboardData?.files ?? [])].filter((f) => IMAGE_TYPES.includes(f.type));
  if (images.length) {
    e.preventDefault();
    void addImages(images);
  }
});

document.addEventListener('dragover', (e) => {
  if ((e.target as HTMLElement).closest?.('#composer-box')) {
    e.preventDefault();
    document.getElementById('composer-box')?.classList.add('dropping');
  }
});
document.addEventListener('dragleave', (e) => {
  if ((e.target as HTMLElement).id === 'composer-box') document.getElementById('composer-box')?.classList.remove('dropping');
});
document.addEventListener('drop', (e) => {
  const box = (e.target as HTMLElement).closest?.('#composer-box');
  if (!box) return;
  e.preventDefault();
  box.classList.remove('dropping');
  void addImages([...(e.dataTransfer?.files ?? [])]);
});

document.addEventListener('change', (e) => {
  const control = (e.target as HTMLElement).closest?.('select[data-ctl]') as HTMLSelectElement | null;
  const cur = selected();
  if (control && cur?.session) {
    const value = control.value;
    const which = control.dataset.ctl!;
    if (which === 'account') {
      const label = control.selectedOptions[0]?.textContent ?? 'that account';
      if (confirm(`Move "${cur.session.title}" to ${label}? It restarts on that account and carries on where it was.`)) {
        void remote!.move(cur.pc.id, cur.session.id, value).then((ref) => pendingResults.set(ref, 'Move'));
      }
      controlsKey = '';
      drawApp();
    } else if (value) {
      void sendControl({ kind: which as 'model' | 'effort' | 'mode', value }, which[0].toUpperCase() + which.slice(1));
    }
    control.blur();
    return;
  }
  const t = e.target as HTMLInputElement;
  if (t.id === 'file-input' && t.files) {
    void addImages([...t.files]);
    t.value = '';
  }
});

document.addEventListener('input', (e) => {
  const t = e.target as HTMLElement;
  if (t.id === 'draft') {
    drafts.set(responseKey, (t as HTMLTextAreaElement).value);
  }
  const p = document.getElementById('decision')?.dataset.prompt;
  if (p && t.classList.contains('other')) {
    const cur = selected();
    const q = cur?.session && promptFor(cur.pc, cur.session.id)?.questions?.[Number(t.dataset.q)];
    if (q) {
      const c = cardOf(p);
      c.other[q.question] = (t as HTMLInputElement).value;
      if (c.other[q.question]) {
        c.picks[q.question] = [];
        t.closest('.question')!.querySelectorAll('.opt').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      }
    }
  }
  if (t.id === 'n-msg' && sheet) {
    sheet.text = (t as HTMLTextAreaElement).value;
    if (sheet.error) {
      sheet.error = undefined;
      $('n-status').textContent = '';
    }
  }
  if (t.id === 'cmd-filter' && commandSheet) {
    commandSheet.filter = (t as HTMLInputElement).value;
    drawCommandSheet();
  }
  if (p && t.id === 'card-note') {
    cardOf(p).note = (t as HTMLInputElement).value;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheet) {
    closeSheet();
    return;
  }
  if (e.key === 'Escape' && drawerOpen) {
    setDrawer(false);
    return;
  }
  // Enter sends; Shift+Enter is a new line.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (e.target as HTMLElement).id === 'draft') {
    e.preventDefault();
    sendDraft();
    return;
  }
  if (e.key === 'Escape' && phone.matches && ui.view === 'session') goBack();
});

// Ages and reset countdowns move on their own.
setInterval(() => {
  if (remote && !$('app').hidden) {
    drawBar();
    drawRail();
    drawSide();
    paint();
  }
}, 30_000);

drawHero();
paint();
setupUnlock();
