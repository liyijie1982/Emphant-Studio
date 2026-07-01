export type AppInfo = {
  name: string
  platform: string
  version: string
}

export type SecretVaultStatus = {
  exists: boolean
  unlocked: boolean
  itemCount: number
}

export type SecretVaultUnlockRequest = {
  password: string
}

export type ProviderCapability = 'chat' | 'vision' | 'tools' | 'knowledge'

export type ModelDefaultType = 'llm' | 'embedding' | 'asr' | 'tts' | 'rerank'

export type ProviderAccessType =
  | 'openai-compatible'
  | 'ollama'
  | 'chatgpt'
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'qwen'
  | 'moonshot'
  | 'zhipu'
  | 'baichuan'
  | 'minimax'
  | 'doubao'

export type ProviderConfig = {
  id: string
  name: string
  kind: 'cloud' | 'local'
  accessType: ProviderAccessType
  providerKey?: string
  custom?: boolean
  baseUrl: string
  apiKeyHint: string
  credentialConfigured?: boolean
  models: string[]
  capabilities: ProviderCapability[]
  enabled: boolean
}

export type Assistant = {
  id: string
  name: string
  description: string
  providerId: string
  model: string
  embeddingProviderId?: string
  embeddingModel?: string
  asrProviderId?: string
  asrModel?: string
  ttsProviderId?: string
  ttsModel?: string
  rerankProviderId?: string
  rerankModel?: string
  systemPrompt: string
  contextLimit: number
  capabilities: string[]
  knowledgeBaseIds: string[]
  enabledToolIds: string[]
  enabledSkillIds?: string[]
  source?: 'builtin' | 'user' | string
}

export type SkillKind = 'prompt' | 'code'

export type CodeSkillRuntime = 'node' | 'python' | 'rust' | 'shell' | 'mcp' | 'unknown'

export type CodeSkillConfig = {
  runtime: CodeSkillRuntime
  entrypoint?: string
  command?: string
  args?: string[]
  localPath?: string
}

export type Skill = {
  id: string
  name: string
  description: string
  kind: SkillKind
  instructions: string
  tags: string[]
  enabled: boolean
  assistantId?: string
  version?: string
  source?: string
  importUrl?: string
  localPath?: string
  code?: CodeSkillConfig
  requiredToolIds?: string[]
  permissions?: PermissionCapability[]
  triggers?: string[]
}

export type SkillImportRequest = {
  source: string
  kind: 'local' | 'github'
}

export type SkillImportResult = {
  skills: Skill[]
  importedPath?: string
}

export type Topic = {
  id: string
  title: string
  updatedAt: string
  titleMode?: 'placeholder' | 'generated' | 'manual'
  workspaceDirectory?: string
  assistantIds?: string[]
  sourceMailId?: string
  sourceTodoId?: string
}

export type MailAgentSettings = {
  enabled: boolean
  checkIntervalMinutes: number
  accountEmail: string
  lastCheckedAt?: string
  checkedAccountAddresses?: string[]
  checkErrors?: Array<{ accountAddress: string; message: string }>
}

export type MailNotification = {
  id: string
  accountAddress: string
  accountType: MemoryEmailAccount['type']
  sender: string
  senderEmail: string
  messageId?: string
  subject: string
  preview: string
  content?: string
  receivedAt: string
  unread: boolean
  processed: boolean
  taskTopicId?: string
}

export type MailCheckResult = {
  messages: MailNotification[]
  checkedAccounts: string[]
  errors: Array<{ accountAddress: string; message: string }>
  checkedAt: string
}

export type MailSendRequest = {
  accountAddress: string
  to: string
  subject: string
  text: string
  inReplyTo?: string
}

export type MailSendResult = {
  messageId: string
  accepted: string[]
}

export type MessageRole = 'user' | 'assistant'

export type MessageBlockType =
  | 'text'
  | 'thinking'
  | 'tool'
  | 'reference'
  | 'file'
  | 'error'

export type MessageBlock = {
  id: string
  type: MessageBlockType
  content: string
  status: 'streaming' | 'done'
  title?: string
  meta?: Record<string, string>
}

export type Message = {
  id: string
  topicId: string
  role: MessageRole
  createdAt: string
  status: 'done' | 'error'
  assistantName?: string
  blocks: MessageBlock[]
}

export type SystemNote = {
  id: string
  title: string
  content: string
  sourceMessageId: string
  sourceTopicId: string
  assistantName?: string
  createdAt: string
  updatedAt: string
}

export type TodoStatus = 'pending' | 'scheduled' | 'running' | 'completed' | 'failed'

export type TodoItem = {
  id: string
  title: string
  description: string
  taskGroup: string
  businessCategory?: string
  status: TodoStatus
  scheduledAt?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
  lastRunAt?: string
  workspaceTopicId?: string
  workspaceMessageId?: string
  resultSummary?: string
  errorMessage?: string
  createdBy?: 'user' | 'todo-assistant' | 'system'
}

export type TodoNotification = {
  id: string
  todoId: string
  title: string
  message: string
  createdAt: string
  read: boolean
  topicId?: string
}

export type KnowledgeBase = {
  id: string
  name: string
  description: string
  sourceFileIds: string[]
  chunkCount: number
  status: 'ready' | 'indexing'
  tags: string[]
  source?: 'builtin' | 'user' | string
  indexedContent?: string
  chunks?: KnowledgeChunk[]
  graph?: KnowledgeGraph
}

export type KnowledgeChunk = {
  id: string
  sourceFileId?: string
  content: string
  tokenCount: number
  title?: string
  summary?: string
  keywords?: string[]
  entityIds?: string[]
  embedding?: number[]
  embeddingProviderId?: string
  embeddingModel?: string
  rerankProviderId?: string
  rerankModel?: string
  rerankScore?: number
}

export type KnowledgeGraphNode = {
  id: string
  name: string
  type: string
  aliases: string[]
  description?: string
  sourceFileIds: string[]
  sourceChunkIds: string[]
}

export type KnowledgeGraphEdge = {
  id: string
  sourceNodeId: string
  targetNodeId: string
  relation: string
  description?: string
  confidence: number
  sourceFileIds: string[]
  sourceChunkIds: string[]
}

export type KnowledgeGraphFact = {
  id: string
  subjectNodeId?: string
  predicate: string
  value: string
  confidence: number
  sourceFileIds: string[]
  sourceChunkIds: string[]
}

export type KnowledgeGraph = {
  nodes: KnowledgeGraphNode[]
  edges: KnowledgeGraphEdge[]
  facts: KnowledgeGraphFact[]
}

export type McpTool = {
  id: string
  name: string
  description: string
  serverName: string
  enabled: boolean
  category:
    | 'search'
    | 'filesystem'
    | 'filesystem-write'
    | 'automation'
    | 'command'
    | 'database'
    | 'devops'
    | 'knowledge'
    | 'collaboration'
    | 'system'
}

export type PermissionRisk = 'low' | 'medium' | 'high' | 'blocked'
export type PermissionDecision = 'allow' | 'ask' | 'deny'
export type PermissionCapability =
  | 'workspace.list'
  | 'workspace.read'
  | 'workspace.write'
  | 'process.exec'
  | 'network.mcp'
  | 'network.fetch'
  | 'task.read'
  | 'task.write'
  | 'mail.read'
  | 'mail.draft'
  | 'mail.send'
  | 'mail.delete'
  | 'calendar.read'
  | 'calendar.write'
  | 'browser.read'
  | 'browser.interact'
  | 'browser.submit'
  | 'knowledge.write'
  | 'memory.read'
  | 'memory.write'
  | 'desktop.control'

export type PermissionRequest = {
  capability: PermissionCapability
  resource: string
  action: string
  arguments?: Record<string, unknown>
}

export type PermissionEvaluation = {
  decision: PermissionDecision
  risk: PermissionRisk
  reason: string
}

export type PermissionAuditRecord = PermissionRequest &
  PermissionEvaluation & {
    id: string
    runId: string
    toolName: string
    createdAt: string
    approvedByUser?: boolean
  }

export type FileRecord = {
  id: string
  name: string
  mimeType: string
  size: number
  uploadedAt: string
  preview?: string
  contentText?: string
  extractedBy?: 'native' | 'markitdown'
  extractionWarning?: string
  originalRelativePath?: string
  knowledgeStatus?: 'queued' | 'extracting' | 'indexing' | 'ready' | 'failed'
  knowledgeProgress?: number
  knowledgeError?: string
  knowledgeStartedAt?: string
  knowledgeCompletedAt?: string
}

export type KnowledgeSourceSaveRequest = {
  workspaceDirectory: string
  knowledgeBaseId: string
  knowledgeBaseName: string
  fileId: string
  fileName: string
  bytes: Uint8Array
}

export type KnowledgeSourceReadRequest = {
  workspaceDirectory: string
  relativePath: string
}

export type KnowledgeIndexRequest = {
  provider: ProviderConfig
  model: string
  embeddingProvider?: ProviderConfig
  embeddingModel?: string
  rerankProvider?: ProviderConfig
  rerankModel?: string
  fileId: string
  fileName: string
  contentText: string
  existingGraph?: KnowledgeGraph
}

export type KnowledgeIndexResult = {
  chunks: KnowledgeChunk[]
  graph: KnowledgeGraph
}

export type KnowledgeExtractionRequest = {
  jobId: string
  knowledgeBaseId: string
  provider: ProviderConfig
  model: string
  embeddingProvider?: ProviderConfig
  embeddingModel?: string
  rerankProvider?: ProviderConfig
  rerankModel?: string
  fileId: string
  fileName: string
  mimeType: string
  bytes: Uint8Array
  existingGraph?: KnowledgeGraph
}

export type KnowledgeExtractionEvent = {
  jobId: string
  knowledgeBaseId: string
  fileId: string
  status: 'queued' | 'extracting' | 'indexing' | 'ready' | 'failed'
  progress: number
  error?: string
  contentText?: string
  extractedBy?: FileRecord['extractedBy']
  extractionWarning?: string
  indexResult?: KnowledgeIndexResult
  startedAt?: string
  completedAt?: string
}

export type AudioTranscriptionRequest = {
  provider: ProviderConfig
  model: string
  fileName: string
  mimeType: string
  bytes: Uint8Array
  language?: string
  sampleRate?: number
}

export type SpeechSynthesisRequest = {
  provider: ProviderConfig
  model: string
  text: string
  voice?: string
  format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm'
}

export type WorkspaceFileMatch = {
  path: string
  size: number
}

export type WorkspaceFileContent = {
  path: string
  name: string
  size: number
  mimeType: string
  contentText?: string
  extractedBy?: 'native' | 'markitdown'
  extractionWarning?: string
}

export type WorkspaceSettings = {
  defaultProviderId: string
  defaultModel: string
  defaultEmbeddingProviderId?: string
  defaultEmbeddingModel?: string
  defaultAsrProviderId?: string
  defaultAsrModel?: string
  defaultTtsProviderId?: string
  defaultTtsModel?: string
  defaultRerankProviderId?: string
  defaultRerankModel?: string
  defaultWorkingDirectory: string
  restoreWorkspaceOnLaunch: boolean
  useMockResponsesWhenProviderFails: boolean
  openClawCore?: {
    enabled: boolean
    sandboxEnabled: boolean
    maxDelegatedAgents: number
    auditLogEnabled: boolean
    requireToolApproval: boolean
  }
}

export type WorkspaceContentSnapshot = {
  systemNotes: SystemNote[]
  knowledgeBases: KnowledgeBase[]
  files: FileRecord[]
  topics?: Topic[]
  messages?: Message[]
  todoGroups?: string[]
  todoItems?: TodoItem[]
}

export type McpServerConfig = {
  id: string
  name: string
  enabled: boolean
  transport: 'http' | 'sse'
  url: string
  service?:
    | 'generic'
    | 'firecrawl'
    | 'todoist'
    | 'notion'
    | 'google-workspace'
    | 'postgresql'
    | 'sqlite'
    | 'mysql'
    | 'mongodb'
    | 'clickhouse'
    | 'docker-k8s'
    | 'obsidian'
    | 'feishu'
    | 'dingtalk'
  preset?: boolean
  docsUrl?: string
  authMode?: 'none' | 'header' | 'oauth'
  authHeaderName?: string
  credentialConfigured?: boolean
  enabledToolNames?: string[]
  discoveredTools?: Array<{
    name: string
    description?: string
  }>
}

export type CredentialScope = 'provider' | 'mcp' | 'email'

export type CredentialSetRequest = {
  scope: CredentialScope
  id: string
  secret: string
}

export type CredentialStatusRequest = {
  scope: CredentialScope
  id: string
}

export type McpServerTestResult = {
  serverInfo: {
    name?: string
    version?: string
  }
  tools: Array<{
    name: string
    description?: string
  }>
}

export type DocumentExtractionRequest = {
  name: string
  mimeType: string
  bytes: Uint8Array
}

export type DocumentExtractionResult = {
  contentText?: string
  extractedBy?: 'native' | 'markitdown'
  warning?: string
}

export type AgentRunRequest = {
  runId: string
  topicId: string
  assistant: Assistant
  routingMode?: 'main' | 'direct'
  candidateAssistants?: Assistant[]
  availableProviders?: ProviderConfig[]
  provider: ProviderConfig
  history: Message[]
  prompt: string
  workspaceDirectory?: string
  knowledgeContext?: string
  candidateKnowledgeContexts?: Record<string, string>
  enabledTools: McpTool[]
  mcpServers?: McpServerConfig[]
  openClawCore?: WorkspaceSettings['openClawCore']
}

export type AgentApprovalResponse = {
  runId: string
  approvalId: string
  approved: boolean
  reason?: string
}

export type AgentRunResult = {
  runId: string
  status: 'completed' | 'awaiting-approval' | 'cancelled' | 'error'
  errorMessage?: string
}

export type AgentTopicTitleRequest = {
  provider: ProviderConfig
  model: string
  prompt: string
  answer: string
}

export type MemoryGreeting = {
  userName?: string
  message: string
}

export type MemoryProfileFact = {
  id: string
  category: string
  predicate: string
  value: string
  confidence: number
  importance: number
  updatedAt: string
}

export type MemoryProfileRelation = {
  id: string
  targetEntityId: string
  sourceName: string
  relationType: string
  targetName: string
  confidence: number
}

export type MemoryEmailAccount = {
  address: string
  type: 'personal' | 'work' | 'unknown'
  sourceFactId?: string
  sourcePredicate?: string
  credentialConfigured: boolean
  credentialType?: 'password' | 'app_password' | 'api_key'
  username?: string
  imapHost?: string
  imapPort?: number
  imapSecure?: boolean
  smtpHost?: string
  smtpPort?: number
  smtpSecure?: boolean
}

export type MemoryProfile = {
  userName?: string
  avatarDataUrl?: string
  assistantProfile?: {
    name?: string
    gender?: string
    personality?: string
    tone?: string
    avatarDataUrl?: string
  }
  facts: MemoryProfileFact[]
  relations: MemoryProfileRelation[]
  emails: MemoryEmailAccount[]
}

export type MemoryProfileFactUpdateRequest = {
  id?: string
  category: string
  predicate: string
  value: string
}

export type MemoryProfileRelationUpdateRequest = {
  id?: string
  targetEntityId?: string
  targetName: string
  relationType: string
}

export type MemoryAvatarUpdateRequest = {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  bytes: Uint8Array
}

export type EmailCredentialSetRequest = {
  email: string
  credentialType: 'password' | 'app_password' | 'api_key'
  secret?: string
  username: string
  imapHost: string
  imapPort: number
  imapSecure: boolean
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
}

export type AgentRuntimeEvent =
  | { runId: string; type: 'text-delta'; delta: string }
  | { runId: string; type: 'reasoning-delta'; delta: string }
  | {
      runId: string
      type: 'tool-input'
      toolCallId: string
      toolName: string
      input: unknown
    }
  | {
      runId: string
      type: 'tool-output'
      toolCallId: string
      output: unknown
      preliminary?: boolean
    }
  | {
      runId: string
      type: 'approval-request'
      approvalId: string
      toolCallId: string
      toolName: string
      input: unknown
      evaluation: PermissionEvaluation
    }
  | { runId: string; type: 'step-finish' }
  | { runId: string; type: 'finish'; finishReason?: string }
  | { runId: string; type: 'error'; message: string }

export type WorkbenchState = {
  assistants: Assistant[]
  skills: Skill[]
  topics: Topic[]
  messages: Message[]
  systemNotes: SystemNote[]
  providers: ProviderConfig[]
  knowledgeBases: KnowledgeBase[]
  mcpTools: McpTool[]
  mcpServers: McpServerConfig[]
  files: FileRecord[]
  mailAgentSettings: MailAgentSettings
  mailNotifications: MailNotification[]
  todoGroups: string[]
  todoItems: TodoItem[]
  todoNotifications: TodoNotification[]
  activeTodoTaskId: string | null
  settings: WorkspaceSettings
  activeAssistantId: string | null
  activeTopicId: string | null
  activeSystemNoteId: string | null
}
