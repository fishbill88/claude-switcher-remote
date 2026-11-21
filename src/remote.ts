import { Keys, deriveKeys, normalizeUsername, seal, toBase64, unseal } from './crypto';
import { CommandInfo, Down, DownMessage, PcState, PromptAnswer, Row, SessionAction, UpMessage, downLabel, stateLabel, upLabel } from './types';

/** A PC as the relay reports it, with its state once decrypted. */
export interface Pc {
  id: string;
  online: boolean;
  state?: PcState;
  /** Its state couldn't be decrypted: published under another vault password. */
  unreadable?: boolean;
}

export interface Transcript {
  rows: Row[];
  loaded: boolean;
  missing?: boolean;
  /** Older rows were left out: only the latest are kept. */
  trimmed?: boolean;
}

/** Rows kept per session, as the PC sends them. */
const KEEP_ROWS = 50;

export class SignInError extends Error {}

/** A reply typed here, and what became of it. */
export interface Reply {
  pc: string;
  session: string;
  text: string;
  status: 'uploading' | 'sending' | 'queued' | 'delivered' | 'refused';
  reason?: string;
  at: number;
}

/** How often a watched session is renewed; the PC drops a watch it hasn't heard about for 90 seconds. */
const RENEW_MS = 45_000;
/** The relay pings every 25 seconds; silence for longer than this means the connection is dead. */
const SILENT_MS = 70_000;

/**
 * The browser's side of the relay: signs in to the vault, keeps the event stream open (reconnecting as needed),
 * decrypts what PCs publish, and asks a PC for the transcript of the session being viewed.
 */
export class Remote {
  readonly pcs = new Map<string, Pc>();
  readonly transcripts = new Map<string, Transcript>();
  /** Replies sent from this tab, by message id. */
  readonly replies = new Map<string, Reply>();
  /** What became of each control and move sent from this tab, by message id. */
  readonly results = new Map<string, { ok: boolean; text?: string; error?: string }>();
  /** Each session's slash commands, once asked for. */
  readonly commands = new Map<string, CommandInfo[]>();
  /** Sessions started from this tab, by message id. */
  readonly starts = new Map<string, { pc: string; status: 'starting' | 'started' | 'refused'; session?: string; reason?: string; note?: string }>();
  /** Answers sent to Claude's prompts, by prompt id: in flight, or why the PC refused one. */
  readonly answers = new Map<string, { ref: string; error?: string }>();
  connected = false;
  private watching?: { pc: string; session: string };
  private renewTimer?: number;
  private abort?: AbortController;
  private stopped = false;
  private heardAt = 0;
  private readonly listeners = new Set<() => void>();
  private readonly watchdog: number;

  private constructor(
    private readonly keys: Keys,
    private session: string,
  ) {
    this.watchdog = window.setInterval(() => {
      if (this.heardAt && Date.now() - this.heardAt > SILENT_MS) {
        this.heardAt = 0;
        this.abort?.abort();
      }
    }, 5000);
    void this.loop();
  }

  static async signIn(username: string, password: string, onProgress?: (fraction: number) => void): Promise<Remote> {
    return Remote.withKeys(username, await deriveKeys(username, password, onProgress));
  }

  /** Signs in with keys already derived (from the password, or kept under this device's passkey). */
  static async withKeys(username: string, keys: Keys): Promise<Remote> {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `web`: a sign-in that ends after hours unused, since this tab keeps it only in memory.
      body: JSON.stringify({ username: normalizeUsername(username), authKey: keys.authKey, device: 'Switcher Remote (web)', web: true }),
    }).catch(() => {
      throw new SignInError("Can't reach the vault.");
    });
    const body = (await res.json().catch(() => ({}))) as { session?: string; error?: string };
    if (!res.ok || !body.session) {
      throw new SignInError(body.error ?? `The vault answered ${res.status}.`);
    }
    return new Remote(keys, body.session);
  }

  /** Signs out as the tab closes; `keepalive` lets the request outlive the page. */
  leave(): void {
    this.stopped = true;
    void fetch('/api/logout', { method: 'POST', keepalive: true, headers: { authorization: `Bearer ${this.session}` } }).catch(() => undefined);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async signOut(): Promise<void> {
    this.stopped = true;
    this.abort?.abort();
    clearInterval(this.watchdog);
    clearInterval(this.renewTimer);
    await fetch('/api/logout', { method: 'POST', headers: { authorization: `Bearer ${this.session}` } }).catch(() => undefined);
  }

  /** Shows one session's transcript, live; the previous one stops streaming. */
  watch(pc: string, session: string): void {
    const prev = this.watching;
    if (prev?.pc === pc && prev.session === session) {
      return;
    }
    if (prev) {
      void this.tell(prev.pc, { type: 'unwatch', session: prev.session });
    }
    this.watching = { pc, session };
    this.transcripts.set(key(pc, session), { rows: this.transcripts.get(key(pc, session))?.rows ?? [], loaded: false });
    void this.tell(pc, { type: 'watch', session, reset: true });
    clearInterval(this.renewTimer);
    this.renewTimer = window.setInterval(() => void this.tell(pc, { type: 'watch', session }), RENEW_MS);
    this.changed();
  }

  sessionCommands(pc: string, session: string): CommandInfo[] | undefined {
    return this.commands.get(key(pc, session));
  }

  transcript(pc: string, session: string): Transcript | undefined {
    return this.transcripts.get(key(pc, session));
  }

  /** A signed-in call to the vault's own API (notifications). */
  async api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const res = await fetch(path, {
      method,
      headers: { authorization: `Bearer ${this.session}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      throw new Error(json.error ?? `The vault answered ${res.status}.`);
    }
    return json as T;
  }

  /** Sends a reply to a session; the PC reports it queued, then delivered (or refused). */
  async send(pc: string, session: string, text: string, images: { blob: Blob; mime: string }[] = []): Promise<void> {
    const id = crypto.randomUUID();
    this.replies.set(id, { pc, session, text, status: images.length ? 'uploading' : 'sending', at: Date.now() });
    this.changed();
    const uploaded: string[] = [];
    for (const image of images) {
      const upload = await this.upload(pc, session, image.blob, image.mime);
      if (!upload) {
        this.replies.set(id, { pc, session, text, status: 'refused', reason: 'An image couldn’t be sent to the PC.', at: Date.now() });
        this.changed();
        return;
      }
      uploaded.push(upload);
    }
    this.replies.set(id, { pc, session, text, status: 'sending', at: Date.now() });
    this.changed();
    if (!(await this.tell(pc, { type: 'send', session, text, ...(uploaded.length && { images: uploaded }) }, id))) {
      this.replies.set(id, { pc, session, text, status: 'refused', reason: 'The PC couldn’t be reached.', at: Date.now() });
      this.changed();
    }
  }

  /** Sends an image to a PC in parts (each well within the relay's limit); resolves its id, or nothing if a part failed. */
  private async upload(pc: string, session: string, blob: Blob, mime: string): Promise<string | undefined> {
    const id = crypto.randomUUID();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const size = 96 * 1024;
    const parts = Math.max(1, Math.ceil(bytes.length / size));
    for (let part = 0; part < parts; part++) {
      const data = toBase64(bytes.subarray(part * size, (part + 1) * size));
      if (!(await this.tell(pc, { type: 'upload', session, upload: id, part, parts, mime, data }))) {
        return undefined;
      }
    }
    return id;
  }

  /** The newest reply sent to a session from this tab. */
  lastReply(pc: string, session: string): Reply | undefined {
    return [...this.replies.values()].filter((r) => r.pc === pc && r.session === session).pop();
  }

  /** Answers one of Claude's prompts; the prompt leaves the PC's state once taken, or `answers` says why not. */
  async answer(pc: string, session: string, prompt: string, answer: PromptAnswer): Promise<void> {
    const ref = crypto.randomUUID();
    this.answers.set(prompt, { ref });
    this.changed();
    if (!(await this.tell(pc, { type: 'answer', session, prompt, answer }, ref))) {
      this.answers.set(prompt, { ref, error: 'The PC couldn’t be reached.' });
      this.changed();
    }
  }

  /** Starts a session on a PC; `starts` follows it to its id (or why not). */
  async start(pc: string, account: string, repo: string, text: string): Promise<string> {
    const ref = crypto.randomUUID();
    this.starts.set(ref, { pc, status: 'starting' });
    this.changed();
    if (!(await this.tell(pc, { type: 'start', account, repo, text }, ref))) {
      this.starts.set(ref, { pc, status: 'refused', reason: 'The PC couldn’t be reached.' });
      this.changed();
    }
    return ref;
  }

  /** Asks a session to change something (model, effort, mode), compact, list or run a command; resolves the message id. */
  async control(pc: string, session: string, action: SessionAction): Promise<string> {
    const ref = crypto.randomUUID();
    if (!(await this.tell(pc, { type: 'control', session, action }, ref))) {
      this.results.set(ref, { ok: false, error: 'The PC couldn’t be reached.' });
      this.changed();
    }
    return ref;
  }

  /** Moves a session to another saved account; it restarts on it. */
  async move(pc: string, session: string, account: string): Promise<string> {
    const ref = crypto.randomUUID();
    if (!(await this.tell(pc, { type: 'move', session, account }, ref))) {
      this.results.set(ref, { ok: false, error: 'The PC couldn’t be reached.' });
      this.changed();
    }
    return ref;
  }

  /** Asks a session to end the turn it's running. */
  stop(pc: string, session: string): void {
    void this.tell(pc, { type: 'stop', session });
  }

  setRemote(pc: string, session: string, on: boolean): void {
    void this.tell(pc, { type: 'remote', session, on });
  }

  private changed(): void {
    this.listeners.forEach((fn) => fn());
  }

  /** Returns whether the relay took the message (the PC was online). */
  private async tell(pc: string, msg: Down, id = crypto.randomUUID()): Promise<boolean> {
    const target = this.pcs.get(pc);
    if (!target?.online || !target.state?.epoch) {
      return false; // Offline, or not yet told which run of its agent to address: a watch is asked again when its state arrives.
    }
    const full: DownMessage = { id, at: Date.now(), epoch: target.state.epoch, ...msg };
    const res = await fetch(`/api/relay/pcs/${encodeURIComponent(pc)}/down`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.session}`, 'content-type': 'application/json' },
      body: JSON.stringify({ data: await seal(this.keys, downLabel(pc), full) }),
    }).catch(() => undefined);
    return !!res?.ok;
  }

  private async loop(): Promise<void> {
    let delay = 1000;
    while (!this.stopped) {
      const started = Date.now();
      try {
        await this.listen();
      } catch (err) {
        if (err instanceof SignInError) {
          this.stopped = true;
          this.connected = false;
          this.changed();
          window.dispatchEvent(new CustomEvent('remote-signed-out'));
          return;
        }
      }
      this.connected = false;
      this.changed();
      if (this.stopped) {
        return;
      }
      delay = Date.now() - started > 60_000 ? 1000 : Math.min(delay * 2, 30_000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  private async listen(): Promise<void> {
    this.abort = new AbortController();
    const res = await fetch('/api/relay/stream', { headers: { authorization: `Bearer ${this.session}` }, signal: this.abort.signal });
    if (res.status === 401) {
      throw new SignInError('Signed out');
    }
    if (!res.ok || !res.body) {
      throw new Error(`relay answered ${res.status}`);
    }
    this.heardAt = Date.now();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }
      this.heardAt = Date.now();
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, end);
        buf = buf.slice(end + 2);
        let event = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) {
            event = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            data += line.slice(5).replace(/^ /, '');
          }
        }
        if (data) {
          await this.onEvent(event, JSON.parse(data));
        }
      }
    }
  }

  private async onEvent(event: string, data: { id?: string; online?: boolean; state?: string | null; pc?: string; data?: string }): Promise<void> {
    if (event === 'ready') {
      this.connected = true;
      // A reconnect: ask again for the session on screen, from the top.
      if (this.watching) {
        void this.tell(this.watching.pc, { type: 'watch', session: this.watching.session, reset: true });
      }
    } else if (event === 'pc' && data.id) {
      const pc: Pc = { id: data.id, online: !!data.online, state: this.pcs.get(data.id)?.state };
      if (data.state) {
        try {
          pc.state = await unseal<PcState>(this.keys, stateLabel(data.id), data.state);
        } catch {
          pc.unreadable = true;
        }
      }
      const before = this.pcs.get(data.id);
      this.pcs.set(data.id, pc);
      // Back online, its agent restarted (a new epoch), or the session on screen just appeared (one started from
      // here): ask again for it.
      const appeared = (s?: PcState) => !!this.watching && !!s?.sessions.some((x) => x.id === this.watching!.session);
      const fresh = pc.online && (!before?.online || before.state?.epoch !== pc.state?.epoch || (appeared(pc.state) && !appeared(before?.state)));
      if (fresh && this.watching?.pc === data.id) {
        void this.tell(data.id, { type: 'watch', session: this.watching.session, reset: true });
      }
    } else if (event === 'gone' && data.id) {
      this.pcs.delete(data.id);
    } else if (event === 'msg' && data.pc && data.data) {
      let msg: UpMessage;
      try {
        msg = await unseal<UpMessage>(this.keys, upLabel(data.pc), data.data);
      } catch {
        return;
      }
      if (msg.type === 'rows') {
        const k = key(data.pc, msg.session);
        const current = this.transcripts.get(k);
        this.transcripts.set(k, {
          // The latest rows only; the whole conversation stays on the PC.
          rows: (msg.reset ? msg.rows : [...(current?.rows ?? []), ...msg.rows]).slice(-KEEP_ROWS),
          trimmed: (msg.reset ? msg.rows.length : (current?.rows.length ?? 0) + msg.rows.length) >= KEEP_ROWS || (!msg.reset && !!current?.trimmed),
          loaded: true,
          missing: msg.missing,
        });
      } else if (msg.type === 'action') {
        this.results.set(msg.ref, { ok: msg.ok, text: msg.text, error: msg.error });
        if (msg.commands) {
          this.commands.set(key(data.pc, msg.session), msg.commands);
        }
      } else if (msg.type === 'started') {
        const start = this.starts.get(msg.ref);
        if (start) {
          this.starts.set(msg.ref, { pc: start.pc, status: msg.session ? 'started' : 'refused', session: msg.session, reason: msg.reason, note: msg.note });
        }
      } else if (msg.type === 'answered') {
        for (const [prompt, a] of this.answers) {
          if (a.ref === msg.ref) {
            this.answers.set(prompt, { ref: a.ref, error: msg.reason });
          }
        }
      } else if (msg.type === 'sent') {
        const reply = this.replies.get(msg.ref);
        if (reply) {
          this.replies.set(msg.ref, { ...reply, status: msg.status, reason: msg.reason, at: Date.now() });
        }
      }
    }
    this.changed();
  }
}

const key = (pc: string, session: string) => `${pc}/${session}`;
