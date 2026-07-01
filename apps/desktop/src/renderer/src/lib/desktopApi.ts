import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  AgentApprovalResponse,
  AgentRunRequest,
  AgentRunResult,
  AgentRuntimeEvent,
  AgentTopicTitleRequest,
  AppInfo,
  AudioTranscriptionRequest,
  CredentialSetRequest,
  CredentialStatusRequest,
  DocumentExtractionRequest,
  DocumentExtractionResult,
  EmailCredentialSetRequest,
  KnowledgeExtractionEvent,
  KnowledgeExtractionRequest,
  KnowledgeIndexRequest,
  KnowledgeIndexResult,
  KnowledgeSourceReadRequest,
  KnowledgeSourceSaveRequest,
  MailCheckResult,
  MailSendRequest,
  MailSendResult,
  McpServerConfig,
  McpServerTestResult,
  MemoryAvatarUpdateRequest,
  MemoryGreeting,
  MemoryProfile,
  MemoryProfileFactUpdateRequest,
  MemoryProfileRelationUpdateRequest,
  ProviderConfig,
  SecretVaultStatus,
  SecretVaultUnlockRequest,
  SpeechSynthesisRequest,
  SkillImportRequest,
  SkillImportResult,
  WorkspaceContentSnapshot,
  WorkspaceFileContent,
  WorkspaceFileMatch
} from '@emphant/shared/types'

const toBytes = (bytes: Uint8Array | number[]) =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))

const tauriApi = {
  getAppInfo: (): Promise<AppInfo> => invoke('get_app_info'),
  scanWorkspaceFiles: (
    query: string,
    limit = 5,
    workspaceDirectory?: string
  ): Promise<WorkspaceFileMatch[]> =>
    invoke('scan_workspace_files', { payload: { query, limit, workspaceDirectory } }),
  readWorkspaceFile: (path: string): Promise<WorkspaceFileContent> =>
    invoke('read_workspace_file', { payload: { path } }),
  extractDocument: (
    request: DocumentExtractionRequest
  ): Promise<DocumentExtractionResult> =>
    invoke('extract_document', {
      request: {
        ...request,
        bytes: toBytes(request.bytes)
      }
    }),
  selectWorkspaceDirectory: (defaultPath?: string): Promise<string | null> =>
    invoke('select_workspace_directory', { payload: { defaultPath } }),
  selectSkillDirectory: (): Promise<string | null> =>
    invoke('select_skill_directory'),
  importSkillSource: (request: SkillImportRequest): Promise<SkillImportResult> =>
    invoke('import_skill_source', { request }),
  getDefaultWorkspaceDirectory: (): Promise<string> =>
    invoke('get_default_workspace_directory'),
  loadWorkspaceContent: (
    workspaceDirectory?: string
  ): Promise<WorkspaceContentSnapshot | null> =>
    invoke('load_workspace_content', { payload: { workspaceDirectory } }),
  saveWorkspaceContent: (
    workspaceDirectory: string,
    snapshot: WorkspaceContentSnapshot
  ): Promise<void> =>
    invoke('save_workspace_content', {
      payload: {
        workspaceDirectory,
        snapshot
      }
    }),
  reindexWorkspace: (workspaceDirectory?: string): Promise<void> =>
    invoke('reindex_workspace', { payload: { workspaceDirectory } }),
  saveKnowledgeSource: (request: KnowledgeSourceSaveRequest): Promise<string> =>
    invoke('save_knowledge_source', {
      request: {
        ...request,
        bytes: toBytes(request.bytes)
      }
    }),
  readKnowledgeSource: async (request: KnowledgeSourceReadRequest): Promise<Uint8Array> => {
    const bytes = await invoke<number[]>('read_knowledge_source', { request })
    return new Uint8Array(bytes)
  },
  indexKnowledgeSource: (
    request: KnowledgeIndexRequest
  ): Promise<KnowledgeIndexResult> =>
    invoke('index_knowledge_source', { request }),
  embedTexts: (
    provider: ProviderConfig,
    model: string,
    texts: string[]
  ): Promise<number[][]> =>
    invoke('embed_texts', { request: { provider, model, texts } }),
  rerankDocuments: (
    provider: ProviderConfig,
    model: string,
    query: string,
    documents: string[]
  ): Promise<number[]> =>
    invoke('rerank_documents', { request: { provider, model, query, documents } }),
  transcribeAudio: (request: AudioTranscriptionRequest): Promise<string> =>
    invoke('transcribe_audio', {
      request: {
        ...request,
        bytes: toBytes(request.bytes)
      }
    }),
  synthesizeSpeech: async (request: SpeechSynthesisRequest): Promise<Uint8Array> => {
    const bytes = await invoke<number[]>('synthesize_speech', { request })
    return new Uint8Array(bytes)
  },
  startKnowledgeExtraction: (request: KnowledgeExtractionRequest): Promise<void> =>
    invoke('start_knowledge_extraction', { request }),
  onKnowledgeExtractionEvent: (listener: (event: KnowledgeExtractionEvent) => void) => {
    const unlisten = listen<KnowledgeExtractionEvent>('knowledge:extraction-event', (event) =>
      listener(event.payload)
    )
    return () => {
      void unlisten.then((dispose) => dispose())
    }
  },
  copyText: (text: string): Promise<void> => invoke('copy_text', { text }),
  runAgent: (request: AgentRunRequest): Promise<AgentRunResult> =>
    invoke('run_agent', { request }),
  approveAgent: (response: AgentApprovalResponse): Promise<AgentRunResult> =>
    invoke('approve_agent', { response }),
  cancelAgent: (runId: string): Promise<void> =>
    invoke('cancel_agent', { payload: { runId } }),
  onAgentEvent: (listener: (event: AgentRuntimeEvent) => void) => {
    const unlisten = listen<AgentRuntimeEvent>('agent:event', (event) =>
      listener(event.payload)
    )
    return () => {
      void unlisten.then((dispose) => dispose())
    }
  },
  generateTopicTitle: (request: AgentTopicTitleRequest): Promise<string> =>
    invoke('generate_topic_title', { request }),
  getMemoryGreeting: (): Promise<MemoryGreeting> => invoke('get_memory_greeting'),
  getMemoryProfile: (): Promise<MemoryProfile> => invoke('get_memory_profile'),
  updateMemoryProfileFact: (request: MemoryProfileFactUpdateRequest): Promise<string> =>
    invoke('update_memory_profile_fact', { request }),
  deleteMemoryProfileFact: (id: string): Promise<void> =>
    invoke('delete_memory_profile_fact', { payload: { id } }),
  updateMemoryProfileRelation: (
    request: MemoryProfileRelationUpdateRequest
  ): Promise<string> =>
    invoke('update_memory_profile_relation', { request }),
  deleteMemoryProfileRelation: (id: string): Promise<void> =>
    invoke('delete_memory_profile_relation', { payload: { id } }),
  updateMemoryAvatar: (request: MemoryAvatarUpdateRequest): Promise<void> =>
    invoke('update_memory_avatar', { request }),
  deleteMemoryAvatar: (): Promise<void> => invoke('delete_memory_avatar'),
  setEmailCredential: (request: EmailCredentialSetRequest): Promise<void> =>
    invoke('set_email_credential', { request }),
  deleteEmailCredential: (email: string): Promise<void> =>
    invoke('delete_email_credential', { payload: { email } }),
  checkAllEmailAccounts: (): Promise<MailCheckResult> =>
    invoke('check_all_email_accounts'),
  sendEmail: (request: MailSendRequest): Promise<MailSendResult> =>
    invoke('send_email', { request }),
  setCredential: (request: CredentialSetRequest): Promise<void> =>
    invoke('set_credential', { request }),
  deleteCredential: (request: CredentialStatusRequest): Promise<void> =>
    invoke('delete_credential', { request }),
  hasCredential: (request: CredentialStatusRequest): Promise<boolean> =>
    invoke('has_credential', { request }),
  secretVaultStatus: (): Promise<SecretVaultStatus> =>
    invoke('secret_vault_status'),
  unlockSecretVault: (request: SecretVaultUnlockRequest): Promise<SecretVaultStatus> =>
    invoke('unlock_secret_vault', { request }),
  lockSecretVault: (): Promise<SecretVaultStatus> =>
    invoke('lock_secret_vault'),
  resetSecretVault: (): Promise<SecretVaultStatus> =>
    invoke('reset_secret_vault'),
  listProviderModels: (provider: ProviderConfig): Promise<string[]> =>
    invoke('list_provider_models', { provider }),
  testMcpServer: (server: McpServerConfig): Promise<McpServerTestResult> =>
    invoke('test_mcp_server', { server })
}

window.emphant = tauriApi

export {}
