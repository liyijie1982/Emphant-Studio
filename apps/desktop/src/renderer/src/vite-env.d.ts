/// <reference types="vite/client" />

import type {
  AgentApprovalResponse,
  AgentRunRequest,
  AgentRunResult,
  AgentRuntimeEvent,
  AgentTopicTitleRequest,
  CredentialSetRequest,
  CredentialStatusRequest,
  DocumentExtractionRequest,
  DocumentExtractionResult,
  EmailCredentialSetRequest,
  McpServerConfig,
  KnowledgeSourceSaveRequest,
  KnowledgeSourceReadRequest,
  KnowledgeExtractionEvent,
  KnowledgeExtractionRequest,
  KnowledgeIndexRequest,
  KnowledgeIndexResult,
  MemoryGreeting,
  MemoryAvatarUpdateRequest,
  MemoryProfile,
  MemoryProfileFactUpdateRequest,
  MemoryProfileRelationUpdateRequest,
  MailCheckResult,
  MailSendRequest,
  MailSendResult,
  McpServerTestResult,
  ProviderConfig,
  SkillImportRequest,
  SkillImportResult,
  WorkspaceFileContent,
  WorkspaceFileMatch,
  WorkspaceContentSnapshot
} from '@emphant/shared/types'

declare global {
  interface Window {
    emphant: {
      getAppInfo: () => Promise<{
        name: string
        platform: string
        version: string
      }>
      scanWorkspaceFiles: (query: string, limit?: number) => Promise<WorkspaceFileMatch[]>
      readWorkspaceFile: (path: string) => Promise<WorkspaceFileContent>
      extractDocument: (
        request: DocumentExtractionRequest
      ) => Promise<DocumentExtractionResult>
      selectWorkspaceDirectory: (defaultPath?: string) => Promise<string | null>
      selectSkillDirectory: () => Promise<string | null>
      importSkillSource: (request: SkillImportRequest) => Promise<SkillImportResult>
      getDefaultWorkspaceDirectory: () => Promise<string>
      loadWorkspaceContent: (
        workspaceDirectory?: string
      ) => Promise<WorkspaceContentSnapshot | null>
      saveWorkspaceContent: (
        workspaceDirectory: string,
        snapshot: WorkspaceContentSnapshot
      ) => Promise<void>
      saveKnowledgeSource: (request: KnowledgeSourceSaveRequest) => Promise<string>
      readKnowledgeSource: (request: KnowledgeSourceReadRequest) => Promise<Uint8Array>
      indexKnowledgeSource: (
        request: KnowledgeIndexRequest
      ) => Promise<KnowledgeIndexResult>
      startKnowledgeExtraction: (request: KnowledgeExtractionRequest) => Promise<void>
      onKnowledgeExtractionEvent: (
        listener: (event: KnowledgeExtractionEvent) => void
      ) => () => void
      copyText: (text: string) => Promise<void>
      runAgent: (request: AgentRunRequest) => Promise<AgentRunResult>
      approveAgent: (response: AgentApprovalResponse) => Promise<AgentRunResult>
      cancelAgent: (runId: string) => Promise<void>
      onAgentEvent: (listener: (event: AgentRuntimeEvent) => void) => () => void
      generateTopicTitle: (request: AgentTopicTitleRequest) => Promise<string>
      getMemoryGreeting: () => Promise<MemoryGreeting>
      getMemoryProfile: () => Promise<MemoryProfile>
      updateMemoryProfileFact: (request: MemoryProfileFactUpdateRequest) => Promise<string>
      deleteMemoryProfileFact: (id: string) => Promise<void>
      updateMemoryProfileRelation: (
        request: MemoryProfileRelationUpdateRequest
      ) => Promise<string>
      deleteMemoryProfileRelation: (id: string) => Promise<void>
      updateMemoryAvatar: (request: MemoryAvatarUpdateRequest) => Promise<void>
      deleteMemoryAvatar: () => Promise<void>
      setEmailCredential: (request: EmailCredentialSetRequest) => Promise<void>
      deleteEmailCredential: (email: string) => Promise<void>
      checkAllEmailAccounts: () => Promise<MailCheckResult>
      sendEmail: (request: MailSendRequest) => Promise<MailSendResult>
      setCredential: (request: CredentialSetRequest) => Promise<void>
      deleteCredential: (request: CredentialStatusRequest) => Promise<void>
      hasCredential: (request: CredentialStatusRequest) => Promise<boolean>
      listProviderModels: (provider: ProviderConfig) => Promise<string[]>
      testMcpServer: (server: McpServerConfig) => Promise<McpServerTestResult>
    }
  }
}

export {}
