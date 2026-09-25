export type Mode = 'chat' | 'work';

export type ApprovalPolicy = 'risky' | 'writes' | 'never';

export type Risk = 'safe' | 'normal' | 'risky';

export type ToolStatus = 'pending' | 'awaiting-approval' | 'running' | 'done' | 'error' | 'denied' | 'cancelled';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
  status: ToolStatus;
  result?: string;
  summary?: string;
  risk?: Risk;
  startedAt?: number;
  endedAt?: number;
}

export interface UserMessage {
  id: string;
  role: 'user';
  content: string;
  createdAt: number;
}

export interface AssistantMessage {
  id: string;
  role: 'assistant';
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  createdAt: number;
  streaming?: boolean;
  error?: string;
  usage?: Usage;
}

export type Message = UserMessage | AssistantMessage;

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface ConversationSummary {
  id: string;
  mode: Mode;
  title: string;
  cwd?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Conversation extends ConversationSummary {
  messages: Message[];
}

export interface Settings {
  apiBase: string;
  model: string;
  hasApiKey: boolean;
  hasGithubToken: boolean;
  approvalPolicy: ApprovalPolicy;
  defaultWorkDir: string;
  searxngUrl: string;
  contextTokens: number;
  maxOutputTokens: number;
  theme: 'system' | 'light' | 'dark';
}

export type SettingsPatch = Partial<Omit<Settings, 'hasApiKey' | 'hasGithubToken'>> & {
  apiKey?: string;
  githubToken?: string;
};

export interface ApprovalRequest {
  id: string;
  conversationId: string;
  toolCallId: string;
  tool: string;
  title: string;
  detail: string;
  cwd?: string;
  reason: string;
}

export type ApprovalDecision = 'once' | 'always' | 'deny';

export interface ModelStatus {
  state: 'online' | 'offline' | 'unauthorized' | 'no-key';
  detail: string;
}

export interface ProcessInfo {
  id: string;
  name: string;
  command: string;
  cwd: string;
  pid: number;
  running: boolean;
  exitCode: number | null;
  startedAt: number;
}

export type AgentEvent =
  | { type: 'message'; conversationId: string; message: Message }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval-resolved'; id: string }
  | { type: 'run-state'; conversationId: string; running: boolean }
  | { type: 'conversation'; summary: ConversationSummary }
  | { type: 'processes'; processes: ProcessInfo[] };

export interface ZehnoraApi {
  listConversations(): Promise<ConversationSummary[]>;
  getConversation(id: string): Promise<Conversation | null>;
  createConversation(mode: Mode): Promise<Conversation>;
  deleteConversation(id: string): Promise<void>;
  renameConversation(id: string, title: string): Promise<void>;
  setWorkDir(id: string): Promise<string | null>;
  send(id: string, text: string): Promise<void>;
  stop(id: string): Promise<void>;
  decide(approvalId: string, decision: ApprovalDecision): Promise<void>;
  getSettings(): Promise<Settings>;
  saveSettings(patch: SettingsPatch): Promise<Settings>;
  chooseDirectory(current?: string): Promise<string | null>;
  modelStatus(): Promise<ModelStatus>;
  listProcesses(): Promise<ProcessInfo[]>;
  stopProcess(id: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  revealPath(target: string): Promise<void>;
  platform: NodeJS.Platform;
  onEvent(listener: (event: AgentEvent) => void): () => void;
}
