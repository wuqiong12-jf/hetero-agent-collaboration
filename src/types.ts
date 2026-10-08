export type Provider = 'codex' | 'deepseek';
export type AccessMode = 'read-only' | 'workspace-write';
export type TaskStatus = 'queued' | 'running' | 'reviewing' | 'accepted' | 'rejected' | 'cancelled';
export interface Message { id: string; agentId: string; role: 'user' | 'assistant' | 'system'; text: string; kind: 'message' | 'tool' | 'review' | 'dispatch'; at: string; taskId?: string; conversationId?: string; status?: 'streaming' | 'completed' | 'cancelled' | 'error' }
export interface Agent { id: string; name: string; model: string; modelId?: string; provider: Provider; role: string; status: string; reasoningEffort?: string; hidden?: boolean; accessMode?: AccessMode }
export interface ChatSession { id: string; startedAt: string; status: 'idle' | 'running'; lastError?: string; providerSession?: {provider: Provider; id: string} }
export interface ChatArchive extends ChatSession {agentId: string}
export interface ModelOption {id: string; label: string; isDefault?: boolean; reasoningEffortSupported?: boolean; defaultReasoningEffort?: string; reasoningEffortUnsupportedReason?: string; supportedReasoningEfforts?: {reasoningEffort: string; description?: string}[]}
export interface ModelCatalog {models: ModelOption[]; available: boolean; detail: string; catalogOnly: boolean}
export interface Criterion { id: string; text: string; status: 'pending' | 'passed' | 'failed'; evidence?: string }
export interface Task { id: string; title: string; description: string; agentId: string; status: TaskStatus; attempt: number; dependsOn: string[]; output?: string; feedback?: string; criteria: Criterion[] }
export interface Activity { id: string; at: string; type: string; text: string; taskId?: string }
export interface Settings { autoReview: boolean; autoDispatch: boolean; maxRetries: number; maxSupervisorCalls: number; maxWorkerCalls: number; maxProviderCalls?: {codex: number; deepseek: number}; maxParallelReaders?: number }
export interface State { id: string; revision?: number; executionSummary?: {readers: number; writers: number; retiringReaders?: number; retiringWriters?: number}; goal: string; goalReady: boolean; phase: 'idle' | 'running' | 'paused' | 'completed' | 'blocked'; mode: 'demo' | 'live'; collaborationMode: 'independent' | 'cooperative'; leaderId: string; epoch: number; agents: Agent[]; tasks: Task[]; messages: Message[]; activity: Activity[]; settings: Settings; usage: { supervisorCalls: number; workerCalls: number; autoSupervisorCalls?: number; autoWorkerCalls?: number; inputTokens: number; outputTokens: number; providerCalls?: {codex: number; deepseek: number}; autoProviderCalls?: {codex: number; deepseek: number} }; chatSessions?: Record<string,ChatSession>; chatArchives?: Record<string,ChatArchive>; error?: string; updatedAt: string }
export interface Capabilities { codex: { available: boolean; detail: string }; harness: { available: boolean; detail: string }; liveReady: boolean }
