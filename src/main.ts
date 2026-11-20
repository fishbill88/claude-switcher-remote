import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles.css';
import { Pc, Remote, SignInError } from './remote';
import type { Account, Limit, Prompt, PromptAnswer, Row, Session } from './types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const icon = (id: string, size = 16) => `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#${id}"/></svg>`;
const meter = (percent: number) => `<span class="meter ${percent >= 80 ? 'hot' : ''}"><b data-w="${Math.round(Math.min(100, Math.max(0, percent || 0)))}"></b></span>`;
const phone = matchMedia('(max-width: 760px)');
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
    try {
      remote = await Remote.signIn(user.value, pass.value, (f) => (bar.style.width = `${Math.round(f * 100)}%`));
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
    remote.onChange(scheduleDraw);
    $('hero').classList.add('leaving');
    setTimeout(() => {
      $('hero').hidden = true;
      $('app').hidden = false;
      drawApp();
    }, 380);
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
  conn.innerHTML = `<span class="dot"></span>${remote!.connected ? 'Live' : 'Reconnecting…'}`;
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

function drawMain(): void {
  const cur = selected();
  if (!cur) {
    $('main-head').innerHTML = '';
    $('main-head').hidden = true;
    $('response').hidden = true;
    ui.drawn = { key: '', rows: undefined, loaded: false, count: 0 };
    $('transcript').innerHTML = pcList().length
      ? `<div class="empty-big"><span class="serif">Pick a session</span><span>Its transcript appears here and follows along live.</span></div>`
      : `<div class="empty-big"><span class="serif">No PCs yet</span><span>In VS Code on each PC, connect to this vault and turn on <code>claudeSwitcher.remoteSessions</code>. Its sessions show up here within seconds.</span></div>`;
    return;
  }
  const { pc, session } = cur;
  const a = session ? accountOf(pc, session) : undefined;
  $('main-head').hidden = false;
  $('response').hidden = false;
  $('main-head').innerHTML = `
    <button class="btn btn-ghost btn-icon back" type="button" data-act="back" aria-label="Back to sessions">${icon('i-back', 22)}</button>
    <div class="head-text">
      <h2>${esc(session?.title ?? 'Closed session')}</h2>
      <div class="meta lg">${
        session
          ? `<span class="mono head-dir">${esc(folder(session.cwd))}</span><span class="sep">·</span>${esc(pcName(pc))}<span class="sep">·</span><span class="acct-tag lg"><span class="dot" data-hue="${a!.hue}"></span>${esc(a!.name)}</span>`
          : esc(pcName(pc))
      }</div>
    </div>
    ${
      pc.online && session && pc.state?.replies
        ? `<button class="switch" type="button" aria-pressed="${!!session.remote}" data-act="remote"><span class="track"><i></i></span>Remote</button>`
        : `<span class="ro">${icon('i-eye', 14)}Read-only</span>`
    }`;
  drawResponse(pc, session);
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
    $('response').innerHTML =
      mode === 'offline'
        ? note(`${name} is offline. The transcript picks up again when it’s back.`)
        : mode === 'closed'
          ? note('This session has closed in VS Code.')
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
  return `<form class="enter" id="composer"><div class="composer">
    <label><span class="sr">Reply to Claude</span><textarea class="input" id="draft" rows="2" enterkeyhint="send" maxlength="20000" placeholder="Reply to Claude…"></textarea></label>
    <div class="composer-row">${['Continue', 'Run the tests', 'Commit it'].map((c) => `<button class="chip" type="button" data-act="chip" data-v="${c}">${c}</button>`).join('')}
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
  const text = draft?.value.trim();
  if (!cur?.session || !draft || !text) {
    draft?.focus();
    return;
  }
  ui.follow = true;
  void remote!.send(cur.pc.id, cur.session.id, text);
  draft.value = '';
  drafts.delete(responseKey);
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
  if (!t?.loaded) {
    $('transcript').innerHTML = `<div class="loading-rows"><span class="dots"><i></i><i></i><i></i></span>Loading the transcript…</div>`;
  } else if (t.missing) {
    $('transcript').innerHTML = `<div class="empty-big"><span>This session’s transcript isn’t on ${esc(pcName(remote!.pcs.get(sel.pc)!))} any more.</span></div>`;
  } else if (!t.rows.length) {
    $('transcript').innerHTML = `<div class="empty-big"><span>Nothing in this session yet.</span></div>`;
  } else {
    // Rows already on screen stay still; only new ones rise in.
    const from = same && ui.drawn.loaded ? Math.min(ui.drawn.count, t.rows.length) : 0;
    const stagger = from === 0;
    $('transcript').innerHTML = t.rows
      .map((r, i) => (i < from ? `<div>${row(r)}</div>` : `<div class="row-in" data-delay="${stagger ? Math.max(0, Math.min(i - (t.rows.length - 8), 8)) * 40 : (i - from) * 40}">${row(r)}</div>`))
      .join('');
  }
  // Opening a session (or its rows arriving) lands on the newest; new rows follow along only if you were at the bottom.
  const firstRows = !same || !ui.drawn.loaded;
  if (firstRows || nearBottom || ui.follow) {
    ui.follow = false;
    box.scrollTo({ top: box.scrollHeight, behavior: firstRows ? 'auto' : 'smooth' });
  }
  ui.drawn = { key, rows: t?.rows, loaded: !!t?.loaded, count: t?.rows.length ?? 0 };
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
    case 'tab':
      $('app').dataset.tab = el.dataset.v!;
      document.querySelectorAll('.tabbar button').forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
      return scrollTo(0, 0);
    case 'remote': {
      const cur = selected();
      if (cur?.session) {
        remote!.setRemote(cur.pc.id, cur.session.id, !cur.session.remote);
      }
      return;
    }
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
  if (p && t.id === 'card-note') {
    cardOf(p).note = (t as HTMLInputElement).value;
  }
});

document.addEventListener('keydown', (e) => {
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
