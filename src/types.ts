// What a PC sends through the relay. Keep in step with Claude Account Switcher's src/relay.ts and src/transcript.ts:
// add fields, never repurpose them, since an older extension can meet a newer web app and the other way round.

export interface Limit {
  key: string;
  name: string;
  percent: number;
  resetsAtMs?: number;
  windowMs: number;
}

export interface Account {
  id: string;
  label: string;
  email: string;
  plan?: string;
  limits: Limit[];
  seenAtMs?: number;
}

export interface Session {
  id: string;
  title: string;
  cwd: string;
  startedAt: number;
  accountId?: string;
  email?: string;
  working: boolean;
  /** Its Remote switch: replies from this app reach it. */
  remote?: boolean;
}

export interface PcState {
  v: 1;
  at: number;
  /** The agent's current run: quoted in every message to it, so it refuses any from an earlier run. */
  epoch?: string;
  pc: { id: string; name: string; platform: string };
  accounts: Account[];
  sessions: Session[];
  /** The PC takes replies from this app (claudeSwitcher.remoteReplies). */
  replies?: boolean;
  /** Claude's prompts waiting for an answer, in sessions with Remote on. */
  prompts?: Prompt[];
}

export interface Prompt {
  id: string;
  session: string;
  kind: 'permission' | 'question' | 'plan';
  tool: string;
  at: number;
  title: string;
  detail?: string;
  lines?: string[];
  note?: string;
  canRemember?: boolean;
  questions?: { question: string; header?: string; options: { label: string; description?: string }[]; multiSelect: boolean }[];
  plan?: string;
}

export type PromptAnswer =
  | { kind: 'allow'; remember?: boolean }
  | { kind: 'deny'; message?: string }
  | { kind: 'answers'; answers: Record<string, string> }
  | { kind: 'approve'; mode: 'acceptEdits' | 'default' }
  | { kind: 'revise'; message: string };

export type Row =
  | { t: 'user'; text: string; at?: string }
  | { t: 'text'; text: string; at?: string }
  | { t: 'tool'; name: string; target: string; at?: string }
  | { t: 'diff'; file: string; lines: string[]; add: number; del: number; at?: string }
  | { t: 'plan'; text: string; at?: string }
  | { t: 'question'; questions: { question: string; options: string[] }[]; at?: string };

/** What the browser asks of a PC; sent with an `id` and `at` (see DownMessage). */
export type Down =
  | { type: 'watch'; session: string; reset?: boolean }
  | { type: 'unwatch'; session: string }
  | { type: 'remote'; session: string; on: boolean }
  | { type: 'send'; session: string; text: string }
  | { type: 'answer'; session: string; prompt: string; answer: PromptAnswer };
export type DownMessage = { id: string; at: number; epoch: string } & Down;
export type SendStatus = 'queued' | 'delivered' | 'refused';
export type UpMessage = { id: string; at: number } & (
  | { type: 'rows'; session: string; rows: Row[]; reset: boolean; missing?: boolean }
  | { type: 'sent'; session: string; ref: string; status: SendStatus; reason?: string }
  | { type: 'answered'; session: string; ref: string; reason: string }
);

export const stateLabel = (pc: string) => `relay:state:${pc}`;
export const upLabel = (pc: string) => `relay:up:${pc}`;
export const downLabel = (pc: string) => `relay:down:${pc}`;
