import {
  App,
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tag,
  Typography
} from 'antd'
import { DeleteOutlined, FolderOpenOutlined, PlusOutlined } from '@ant-design/icons'
import { useEffect, useMemo, useState } from 'react'
import { clearWorkbenchSnapshot } from '@/lib/workbenchDb'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  addProviderConfig,
  resetWorkbench,
  deleteProviderConfig,
  deleteMcpServer,
  runTodoTask,
  selectFiles,
  selectActiveTodoTaskId,
  selectKnowledgeBases,
  selectMailAgentSettings,
  selectMessages,
  selectMcpServers,
  selectMcpTools,
  selectProviders,
  selectSettings,
  selectSystemNotes,
  selectTodoGroups,
  selectTodoItems,
  selectTopics,
  syncDefaultModelToAgents,
  updateDefaultLlmModel,
  updateMcpToolConfig,
  updateMailAgentSettings,
  updateProviderConfig,
  updateSettings,
  upsertMcpServer
} from '@/store/workbenchSlice'
import type {
  McpServerConfig,
  ModelDefaultType,
  ProviderAccessType,
  ProviderCapability,
  ProviderConfig
} from '@emphant/shared/types'

type SettingsSection =
  | 'providers'
  | 'model'
  | 'runtime'
  | 'workspace'
  | 'data'
  | 'persistence'
  | 'mcp'

const sectionLabels: Record<SettingsSection, string> = {
  providers: '模型服务',
  model: '默认能力',
  runtime: '执行安全',
  workspace: '工作目录',
  data: '数据管理',
  persistence: '数据恢复',
  mcp: 'MCP 工具'
}

type ProviderPreset = {
  accessType: ProviderAccessType
  label: string
  kind: ProviderConfig['kind']
  baseUrl: string
  apiKeyHint: string
  models: string[]
  capabilities: ProviderCapability[]
}

type AddProviderFormValues = {
  accessType: ProviderAccessType
  name: string
  baseUrl?: string
}

type McpService = NonNullable<McpServerConfig['service']>

type McpServiceProfile = {
  label: string
  defaultName: string
  defaultUrl: string
  transport: McpServerConfig['transport']
  authMode: NonNullable<McpServerConfig['authMode']>
  authHeaderName?: string
  credentialPlaceholder: string
  description: string
}

type ModelDefaultField = {
  modelType: ModelDefaultType
  title: string
  description: string
  providerId: string
  model: string
  onChange: (providerId: string, model: string) => void
}

const mcpServiceProfiles: Record<McpService, McpServiceProfile> = {
  generic: {
    label: '通用 MCP',
    defaultName: '自定义工具服务',
    defaultUrl: 'http://127.0.0.1:3000/mcp',
    transport: 'http',
    authMode: 'header',
    authHeaderName: 'Authorization',
    credentialPlaceholder: '例如 Bearer token',
    description: '适用于自建或第三方工具服务，按服务文档填写 URL 和认证方式。'
  },
  firecrawl: {
    label: 'Firecrawl',
    defaultName: 'Firecrawl',
    defaultUrl: 'http://127.0.0.1:3000/mcp',
    transport: 'http',
    authMode: 'header',
    authHeaderName: 'Authorization',
    credentialPlaceholder: '例如 Bearer fc-...',
    description: '通常是本地或自托管 Firecrawl MCP，使用 Header Token。'
  },
  todoist: {
    label: 'Todoist',
    defaultName: 'Todoist',
    defaultUrl: 'https://ai.todoist.net/mcp',
    transport: 'http',
    authMode: 'oauth',
    authHeaderName: 'Authorization',
    credentialPlaceholder: '当前请填入 Bearer access token',
    description: '官方远程 MCP，通常使用 OAuth Access Token。'
  },
  notion: {
    label: 'Notion',
    defaultName: 'Notion',
    defaultUrl: 'http://127.0.0.1:3000/mcp',
    transport: 'http',
    authMode: 'header',
    authHeaderName: 'Authorization',
    credentialPlaceholder: '例如 Bearer secret_...',
    description: '一般通过本地 Notion MCP 代理连接，Token 由代理或 Header 提供。'
  },
  'google-workspace': {
    label: 'Google Workspace',
    defaultName: 'Google Workspace',
    defaultUrl: 'http://127.0.0.1:3000/mcp',
    transport: 'http',
    authMode: 'oauth',
    authHeaderName: 'Authorization',
    credentialPlaceholder: '当前请填入 Bearer access token',
    description: '日历、文档、邮件等 Google 能力通常走 OAuth。'
  },
  postgresql: {
    label: 'PostgreSQL',
    defaultName: 'PostgreSQL',
    defaultUrl: 'http://127.0.0.1:3010/mcp',
    transport: 'http',
    authMode: 'header',
    authHeaderName: 'Authorization',
    credentialPlaceholder: '例如 Bearer token；数据库连接串建议放在工具服务环境变量',
    description: '建议工具服务自己管理数据库连接串和只读/读写权限，客户端只保存访问工具服务的 Token。'
  },
  sqlite: {
    label: 'SQLite',
    defaultName: 'SQLite',
    defaultUrl: 'http://127.0.0.1:3011/mcp',
    transport: 'http',
    authMode: 'none',
    credentialPlaceholder: '本地 SQLite MCP 通常无需认证',
    description: '适合本机轻量数据；数据库文件路径建议配置在工具服务侧。'
  },
  mysql: {
    label: 'MySQL',
    defaultName: 'MySQL',
    defaultUrl: 'http://127.0.0.1:3012/mcp',
    transport: 'http',
    authMode: 'header',
    authHeaderName: 'Authorization',
    credentialPlaceholder: '例如 Bearer token；数据库账号建议放在工具服务环境变量',
    description: '建议通过工具服务做权限隔离，客户端只连接工具入口。'
  },
  mongodb: {
    label: 'MongoDB',
    defaultName: 'MongoDB',
    defaultUrl: 'http://127.0.0.1:3013/mcp',
    transport: 'http',
    authMode: 'header',
    authHeaderName: 'Authorization',
    credentialPlaceholder: '例如 Bearer token；Mongo URI 建议放在工具服务环境变量',
    description: '适合文档型数据库查询和导出；连接串不建议直接暴露给客户端。'
  },
  clickhouse: {
    label: 'ClickHouse',
    defaultName: 'ClickHouse',
    defaultUrl: 'http://127.0.0.1:3014/mcp',
    transport: 'http',
    authMode: 'header',
    authHeaderName: 'Authorization',
    credentialPlaceholder: '例如 Bearer token；ClickHouse 凭据建议放在工具服务环境变量',
    description: '适合日志、时序和大数据分析，建议由工具服务控制查询权限。'
  },
  'docker-k8s': {
    label: 'Docker / K8s',
    defaultName: 'Docker / K8s',
    defaultUrl: 'http://127.0.0.1:3015/mcp',
    transport: 'http',
    authMode: 'header',
    authHeaderName: 'Authorization',
    credentialPlaceholder: '例如 Bearer token；Docker socket/kubeconfig 建议只在工具服务侧配置',
    description: '高风险运维能力，建议工具服务侧做命名空间、只读日志和审批限制。'
  },
  obsidian: {
    label: 'Obsidian',
    defaultName: 'Obsidian',
    defaultUrl: 'http://127.0.0.1:3016/mcp',
    transport: 'http',
    authMode: 'header',
    authHeaderName: 'Authorization',
    credentialPlaceholder: '例如 Bearer token；Vault 路径建议放在工具服务侧',
    description: '个人知识能力通常跑在本地，Vault 路径由工具服务管理。'
  },
  feishu: {
    label: '飞书',
    defaultName: '飞书',
    defaultUrl: 'http://127.0.0.1:3017/mcp',
    transport: 'http',
    authMode: 'oauth',
    authHeaderName: 'Authorization',
    credentialPlaceholder: '当前请填入 Bearer tenant/user access token',
    description: '企业协作能力通常依赖 OAuth 或应用访问令牌。'
  },
  dingtalk: {
    label: '钉钉',
    defaultName: '钉钉',
    defaultUrl: 'http://127.0.0.1:3018/mcp',
    transport: 'http',
    authMode: 'oauth',
    authHeaderName: 'Authorization',
    credentialPlaceholder: '当前请填入 Bearer access token',
    description: '企业协作能力通常依赖 OAuth 或应用访问令牌。'
  }
}

const mcpServiceOptions = Object.entries(mcpServiceProfiles).map(([value, profile]) => ({
  label: profile.label,
  value
}))

const providerPresets: ProviderPreset[] = [
  {
    accessType: 'chatgpt',
    label: 'ChatGPT',
    kind: 'cloud',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyHint: 'sk-...',
    models: [
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4o-mini',
      'text-embedding-3-small',
      'text-embedding-3-large'
    ],
    capabilities: ['chat', 'vision', 'tools', 'knowledge']
  },
  {
    accessType: 'openai-compatible',
    label: 'OpenAI Compatible',
    kind: 'cloud',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyHint: 'sk-...',
    models: [
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4o-mini',
      'text-embedding-3-small',
      'text-embedding-3-large'
    ],
    capabilities: ['chat', 'vision', 'tools', 'knowledge']
  },
  {
    accessType: 'ollama',
    label: 'Ollama',
    kind: 'local',
    baseUrl: 'http://127.0.0.1:11434',
    apiKeyHint: '无须 API Key',
    models: ['qwen3:8b', 'llama3.1:8b'],
    capabilities: ['chat', 'knowledge']
  },
  {
    accessType: 'openai',
    label: 'OpenAI',
    kind: 'cloud',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyHint: 'sk-...',
    models: [
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4o-mini',
      'text-embedding-3-small',
      'text-embedding-3-large'
    ],
    capabilities: ['chat', 'vision', 'tools', 'knowledge']
  },
  {
    accessType: 'anthropic',
    label: 'Anthropic',
    kind: 'cloud',
    baseUrl: 'https://api.anthropic.com',
    apiKeyHint: 'sk-ant-...',
    models: ['claude-sonnet-4', 'claude-haiku-3.5'],
    capabilities: ['chat', 'vision', 'tools']
  },
  {
    accessType: 'deepseek',
    label: 'DeepSeek',
    kind: 'cloud',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyHint: 'sk-...',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    capabilities: ['chat', 'tools', 'knowledge']
  },
  {
    accessType: 'qwen',
    label: '通义千问',
    kind: 'cloud',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyHint: 'sk-...',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'gte-rerank-v2', 'gte-rerank'],
    capabilities: ['chat', 'vision', 'tools', 'knowledge']
  },
  {
    accessType: 'moonshot',
    label: 'Moonshot',
    kind: 'cloud',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeyHint: 'sk-...',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    capabilities: ['chat', 'knowledge']
  },
  {
    accessType: 'zhipu',
    label: '智谱 GLM',
    kind: 'cloud',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyHint: '请输入 API Key',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash', 'bge-reranker-v2-m3'],
    capabilities: ['chat', 'tools', 'knowledge']
  },
  {
    accessType: 'baichuan',
    label: '百川智能',
    kind: 'cloud',
    baseUrl: 'https://api.baichuan-ai.com/v1',
    apiKeyHint: 'sk-...',
    models: ['Baichuan4', 'Baichuan3-Turbo'],
    capabilities: ['chat', 'knowledge']
  },
  {
    accessType: 'minimax',
    label: 'MiniMax',
    kind: 'cloud',
    baseUrl: 'https://api.minimax.chat/v1',
    apiKeyHint: '请输入 API Key',
    models: ['MiniMax-Text-01'],
    capabilities: ['chat', 'vision', 'knowledge']
  },
  {
    accessType: 'doubao',
    label: '豆包',
    kind: 'cloud',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKeyHint: '请输入 API Key',
    models: ['doubao-1-5-pro-32k-250115', 'doubao-1-5-lite-32k-250115'],
    capabilities: ['chat', 'vision', 'tools', 'knowledge']
  }
]

const customEndpointAccessTypes: ProviderAccessType[] = ['openai-compatible', 'ollama']

const getProviderAccessType = (provider: ProviderConfig): ProviderAccessType => {
  if (provider.accessType) return provider.accessType
  if (provider.id === 'provider-chatgpt') return 'chatgpt'
  if (provider.id === 'provider-ollama') return 'ollama'
  if (provider.id === 'provider-anthropic') return 'anthropic'
  return 'openai-compatible'
}

const getProviderPreset = (accessType: ProviderAccessType) =>
  providerPresets.find((preset) => preset.accessType === accessType) ?? providerPresets[0]

const classifyModelType = (model: string): ModelDefaultType => {
  const normalized = model.toLowerCase()
  if (/(rerank|reranker|ranker|ranking)/.test(normalized)) return 'rerank'
  if (/(tts|text-to-speech|text_to_speech|voice|speech-synthesis|speech_synthesis)/.test(normalized)) {
    return 'tts'
  }
  if (/(asr|whisper|transcrib|transcribe|speech-to-text|speech_to_text|audio)/.test(normalized)) return 'asr'
  if (/(embedding|embed|text-embedding|text_embedding|bge-m3|e5-|gte-|jina-embeddings)/.test(normalized)) {
    return 'embedding'
  }
  return 'llm'
}

const filterModelsByType = (models: string[], modelType: ModelDefaultType) =>
  models.filter((model) => classifyModelType(model) === modelType)

const supplementalModelsByAccessType: Partial<Record<ProviderAccessType, string[]>> = {
  chatgpt: [
    'text-embedding-3-small',
    'text-embedding-3-large',
    'gpt-4o-mini-transcribe',
    'gpt-4o-mini-tts',
    'whisper-1',
    'tts-1',
    'tts-1-hd'
  ],
  openai: [
    'text-embedding-3-small',
    'text-embedding-3-large',
    'gpt-4o-mini-transcribe',
    'gpt-4o-mini-tts',
    'whisper-1',
    'tts-1',
    'tts-1-hd'
  ],
  'openai-compatible': [
    'text-embedding-3-small',
    'text-embedding-3-large',
    'gpt-4o-mini-transcribe',
    'gpt-4o-mini-tts',
    'whisper-1',
    'tts-1',
    'tts-1-hd',
    'gte-rerank-v2',
    'gte-rerank',
    'bge-reranker-v2-m3'
  ],
  qwen: ['gte-rerank-v2', 'gte-rerank'],
  zhipu: ['bge-reranker-v2-m3']
}

const getSupplementalModels = (provider: ProviderConfig) => {
  const accessType = getProviderAccessType(provider)
  const presetModels = getProviderPreset(accessType).models
  return [...presetModels, ...(supplementalModelsByAccessType[accessType] ?? [])]
}

const mergeProviderModels = (provider: ProviderConfig, syncedModels: string[]) =>
  Array.from(
    new Set(
      [...syncedModels, ...provider.models, ...getSupplementalModels(provider)]
        .map((model) => model.trim())
        .filter(Boolean)
    )
  ).sort((left, right) => left.localeCompare(right))

export const SettingsPage = () => {
  const dispatch = useAppDispatch()
  const { message } = App.useApp()
  const providers = useAppSelector(selectProviders)
  const tools = useAppSelector(selectMcpTools)
  const mcpServers = useAppSelector(selectMcpServers)
  const settings = useAppSelector(selectSettings)
  const systemNotes = useAppSelector(selectSystemNotes)
  const knowledgeBases = useAppSelector(selectKnowledgeBases)
  const files = useAppSelector(selectFiles)
  const topics = useAppSelector(selectTopics)
  const messages = useAppSelector(selectMessages)
  const todoGroups = useAppSelector(selectTodoGroups)
  const todoItems = useAppSelector(selectTodoItems)
  const activeTodoTaskId = useAppSelector(selectActiveTodoTaskId)
  const mailAgentSettings = useAppSelector(selectMailAgentSettings)
  const isDevMode = import.meta.env.DEV
  const [activeSection, setActiveSection] = useState<SettingsSection>('providers')
  const [syncingProviderId, setSyncingProviderId] = useState<string | null>(null)
  const [providerSecrets, setProviderSecrets] = useState<Record<string, string>>({})
  const [savingCredentialId, setSavingCredentialId] = useState<string | null>(null)
  const [testingMcpId, setTestingMcpId] = useState<string | null>(null)
  const [editingMcpServer, setEditingMcpServer] = useState<McpServerConfig | null>(null)
  const [addingProvider, setAddingProvider] = useState(false)
  const [mcpCredential, setMcpCredential] = useState('')
  const [runHistoryTopicFilter, setRunHistoryTopicFilter] = useState('all')
  const [runHistoryAssistantFilter, setRunHistoryAssistantFilter] = useState('all')
  const [runHistoryTaskFilter, setRunHistoryTaskFilter] = useState('all')
  const [runHistoryDateFilter, setRunHistoryDateFilter] = useState('')
  const [mcpForm] = Form.useForm<McpServerConfig>()
  const [providerForm] = Form.useForm<AddProviderFormValues>()
  const addingProviderAccessType =
    Form.useWatch('accessType', providerForm) ?? 'openai-compatible'
  const addingProviderPreset = getProviderPreset(addingProviderAccessType)
  const addingProviderUsesCustomEndpoint = customEndpointAccessTypes.includes(
    addingProviderAccessType
  )

  const enabledProviders = useMemo(
    () => providers.filter((provider) => provider.enabled),
    [providers]
  )
  const disabledProviders = useMemo(
    () => providers.filter((provider) => !provider.enabled),
    [providers]
  )
  const selectedMcpService = Form.useWatch('service', mcpForm) as McpService | undefined
  const selectedMcpAuthMode = Form.useWatch('authMode', mcpForm) as
    | McpServerConfig['authMode']
    | undefined
  const selectedMcpServiceProfile =
    mcpServiceProfiles[selectedMcpService ?? 'generic'] ?? mcpServiceProfiles.generic
  const selectedProvider =
    enabledProviders.find((provider) => provider.id === settings.defaultProviderId) ??
    enabledProviders[0]
  const highRiskToolCount = tools.filter((tool) =>
    ['filesystem-write', 'command', 'system', 'database', 'devops'].includes(tool.category)
  ).length
  const enabledHighRiskToolCount = tools.filter(
    (tool) =>
      tool.enabled &&
      ['filesystem-write', 'command', 'system', 'database', 'devops'].includes(tool.category)
  ).length
  const setupWarnings = [
    enabledProviders.length === 0
      ? '还没有启用模型服务，工作台无法调用真实模型。'
      : '',
    settings.defaultWorkingDirectory
      ? ''
      : '还没有设置工作目录，知识、笔记和文件操作无法稳定保存。',
    settings.openClawCore?.requireToolApproval
      ? ''
      : '执行前确认已关闭，外部动作会更难追踪。',
    enabledHighRiskToolCount > 0 && !settings.openClawCore?.requireToolApproval
      ? `已有 ${enabledHighRiskToolCount} 个可改动文件或系统的工具启用，建议打开执行前确认。`
      : ''
  ].filter(Boolean)
  const dataInventory = [
    {
      title: '系统预设',
      description: '默认智能体、默认技能、内置工具和示例知识库，用于新用户快速开始。',
      location: '应用内置配置，启动或升级时合并',
      status: `${providers.length} 个模型服务 · ${tools.length} 个内置工具`,
      exportStatus: '随应用版本提供',
      clearStatus: '不可单独清除，可通过重置恢复'
    },
    {
      title: '用户数据',
      description: '会话、消息、任务、任务组、笔记和用户创建的智能体配置。',
      location: settings.defaultWorkingDirectory || '尚未选择工作目录',
      status: `${topics.length} 个会话 · ${messages.length} 条消息 · ${todoItems.length} 个任务`,
      exportStatus: settings.defaultWorkingDirectory ? '可保存到工作目录' : '需先选择工作目录',
      clearStatus: '可通过重置本地工作区清除'
    },
    {
      title: '本地安全数据',
      description: '模型 API Key、MCP Token、邮箱授权和保险箱解锁状态。',
      location: '本机安全保险箱',
      status: `${providers.filter((provider) => provider.credentialConfigured).length} 个模型凭据 · ${
        mcpServers.filter((server) => server.credentialConfigured).length
      } 个工具凭据`,
      exportStatus: '不导出明文凭据',
      clearStatus: '可在对应模型、工具或邮箱配置中删除'
    },
    {
      title: '工作目录数据',
      description: '知识源文件、知识库索引、笔记、任务记录和导出的工作区内容。',
      location: settings.defaultWorkingDirectory || '尚未选择工作目录',
      status: `${knowledgeBases.length} 个知识库 · ${files.length} 个文件 · ${systemNotes.length} 条笔记`,
      exportStatus: settings.defaultWorkingDirectory ? '已指向工作目录' : '需先选择工作目录',
      clearStatus: '需要在工作目录中管理原始文件'
    },
    {
      title: '临时状态',
      description: '正在运行的 AI 任务、后台轮询状态、表单草稿和未完成的工具调用。',
      location: '当前应用会话内存',
      status: settings.restoreWorkspaceOnLaunch ? '启动时会恢复工作区上下文' : '启动时不恢复工作区上下文',
      exportStatus: '不单独导出',
      clearStatus: '退出或锁定后释放，恢复快照可手动清除'
    }
  ]
  const scheduledTodoItems = todoItems.filter((item) => item.status === 'scheduled')
  const runningTodoItems = todoItems.filter((item) => item.status === 'running')
  const failedTodoItems = todoItems.filter((item) => item.status === 'failed')
  const nextScheduledTodo = scheduledTodoItems
    .filter((item) => item.scheduledAt)
    .sort((left, right) => Date.parse(left.scheduledAt!) - Date.parse(right.scheduledAt!))[0]
  const nextMailCheckAt =
    mailAgentSettings.enabled && mailAgentSettings.lastCheckedAt
      ? new Date(
          Date.parse(mailAgentSettings.lastCheckedAt) +
            Math.max(mailAgentSettings.checkIntervalMinutes, 1) * 60_000
        ).toISOString()
      : ''
  const backgroundTaskStatuses = [
    {
      title: '邮件轮询',
      status: mailAgentSettings.enabled ? '运行中' : '已暂停',
      tone: mailAgentSettings.enabled ? 'processing' : 'default',
      lastRun: mailAgentSettings.lastCheckedAt
        ? new Date(mailAgentSettings.lastCheckedAt).toLocaleString()
        : '尚未执行',
      nextRun: nextMailCheckAt ? new Date(nextMailCheckAt).toLocaleString() : '未安排',
      failure:
        mailAgentSettings.checkErrors && mailAgentSettings.checkErrors.length > 0
          ? mailAgentSettings.checkErrors.map((error) => error.message).join('；')
          : ''
    },
    {
      title: '定时任务',
      status: activeTodoTaskId || runningTodoItems.length > 0 ? '运行中' : '待机',
      tone: activeTodoTaskId || runningTodoItems.length > 0 ? 'processing' : 'default',
      lastRun:
        todoItems
          .filter((item) => item.lastRunAt)
          .sort((left, right) => Date.parse(right.lastRunAt!) - Date.parse(left.lastRunAt!))[0]
          ?.lastRunAt
          ? new Date(
              todoItems
                .filter((item) => item.lastRunAt)
                .sort((left, right) => Date.parse(right.lastRunAt!) - Date.parse(left.lastRunAt!))[0]
                .lastRunAt!
            ).toLocaleString()
          : '尚未执行',
      nextRun: nextScheduledTodo?.scheduledAt
        ? new Date(nextScheduledTodo.scheduledAt).toLocaleString()
        : '未安排',
      failure: failedTodoItems[0]?.errorMessage ?? ''
    }
  ]
  const runHistoryRecords = messages
    .filter((messageItem) => messageItem.role === 'assistant')
    .flatMap((messageItem) => {
      const metaBlock = messageItem.blocks.find((block) => block.meta?.runId)
      if (!metaBlock?.meta?.runId) return []
      const topic = topics.find((item) => item.id === messageItem.topicId)
      const linkedTask = todoItems.find((item) => item.workspaceTopicId === messageItem.topicId)
      const approvalBlocks = messageItem.blocks.filter((block) => block.meta?.approvalState)
      const toolBlocks = messageItem.blocks.filter((block) => block.type === 'tool')
      return [{
        runId: metaBlock.meta.runId,
        topicId: messageItem.topicId,
        topicTitle: topic?.title ?? '未知会话',
        taskId: linkedTask?.id ?? '',
        taskTitle: linkedTask?.title ?? '',
        assistantName: metaBlock.meta.assistantName || messageItem.assistantName || 'AI 助理',
        model: [metaBlock.meta.providerName, metaBlock.meta.model].filter(Boolean).join(' · ') || '未记录',
        status: metaBlock.meta.runStatus || 'completed',
        createdAt: messageItem.createdAt,
        durationMs: Number(metaBlock.meta.durationMs || 0),
        toolCount: toolBlocks.length,
        approvalCount: approvalBlocks.length,
        highRiskCount: approvalBlocks.filter((block) => block.meta?.risk === 'high').length,
        simulated: messageItem.blocks.some((block) => block.meta?.simulated === 'true')
      }]
    })
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
  const filteredRunHistoryRecords = runHistoryRecords.filter((record) => {
    const matchesTopic = runHistoryTopicFilter === 'all' || record.topicId === runHistoryTopicFilter
    const matchesAssistant =
      runHistoryAssistantFilter === 'all' || record.assistantName === runHistoryAssistantFilter
    const matchesTask = runHistoryTaskFilter === 'all' || record.taskId === runHistoryTaskFilter
    const matchesDate =
      !runHistoryDateFilter || record.createdAt.slice(0, 10) === runHistoryDateFilter
    return matchesTopic && matchesAssistant && matchesTask && matchesDate
  })
  const runHistorySummary = {
    runs: filteredRunHistoryRecords.length,
    toolCalls: filteredRunHistoryRecords.reduce((total, record) => total + record.toolCount, 0),
    highRiskActions: filteredRunHistoryRecords.reduce((total, record) => total + record.highRiskCount, 0),
    failureRate: filteredRunHistoryRecords.length
      ? Math.round(
          (filteredRunHistoryRecords.filter((record) => record.status === 'error').length /
            filteredRunHistoryRecords.length) *
            100
        )
      : 0
  }
  const runHistoryAssistantOptions = Array.from(
    new Set(runHistoryRecords.map((record) => record.assistantName))
  )
  const handleExportRunHistory = () => {
    const headers = ['runId', 'time', 'topic', 'task', 'assistant', 'model', 'status', 'durationMs', 'toolCount', 'highRiskCount', 'simulated']
    const rows = filteredRunHistoryRecords.map((record) => [
      record.runId,
      new Date(record.createdAt).toLocaleString(),
      record.topicTitle,
      record.taskTitle,
      record.assistantName,
      record.model,
      record.status,
      String(record.durationMs),
      String(record.toolCount),
      String(record.highRiskCount),
      record.simulated ? 'yes' : 'no'
    ])
    const escapeCell = (value: string) => `"${value.replace(/"/g, '""')}"`
    const csv = [headers, ...rows].map((row) => row.map(escapeCell).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `emphant-run-history-${new Date().toISOString().slice(0, 10)}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
    void message.success('运行日志已导出')
  }

  useEffect(() => {
    if (!selectedProvider) {
      return
    }

    const nextPatch: Partial<typeof settings> = {}
    if (settings.defaultProviderId !== selectedProvider.id) {
      nextPatch.defaultProviderId = selectedProvider.id
    }
    if (
      selectedProvider.models.length > 0 &&
      !selectedProvider.models.includes(settings.defaultModel)
    ) {
      nextPatch.defaultModel = selectedProvider.models[0]
    }
    if (Object.keys(nextPatch).length > 0) {
      dispatch(
        updateDefaultLlmModel({
          providerId: nextPatch.defaultProviderId ?? settings.defaultProviderId,
          model: nextPatch.defaultModel ?? settings.defaultModel
        })
      )
    }
  }, [dispatch, selectedProvider, settings.defaultModel, settings.defaultProviderId])

  const handleDefaultAuxProviderChange = (
    providerId: string,
    modelType: ModelDefaultType,
    providerKey: keyof typeof settings,
    modelKey: keyof typeof settings
  ) => {
    const provider = providers.find((item) => item.id === providerId)
    const models = filterModelsByType(provider?.models ?? [], modelType)
    dispatch(
      updateSettings({
        [providerKey]: providerId,
        [modelKey]: models[0] ?? ''
      })
    )
    void message.success('默认模型已更新')
  }

  const handleDefaultAuxModelChange = (model: string, modelKey: keyof typeof settings) => {
    dispatch(updateSettings({ [modelKey]: model }))
    void message.success('默认模型已更新')
  }

  const handleSelectDefaultWorkingDirectory = async () => {
    try {
      const directory = await window.emphant.selectWorkspaceDirectory(
        settings.defaultWorkingDirectory || undefined
      )
      if (!directory) {
        return
      }
      await window.emphant.saveWorkspaceContent(directory, {
        systemNotes,
        knowledgeBases,
        files,
        topics,
        messages,
        todoGroups,
        todoItems
      })
      dispatch(updateSettings({ defaultWorkingDirectory: directory }))
      void message.success('工作目录已更新，知识和笔记已迁移')
    } catch (error) {
      void message.error(
        error instanceof Error && error.message.includes('No handler registered')
          ? '主进程尚未加载目录选择功能，请重启应用后再试'
          : error instanceof Error
            ? error.message
            : '无法选择工作目录'
      )
    }
  }

  const handleProviderEnabledChange = async (providerId: string, enabled: boolean) => {
    const provider = providers.find((item) => item.id === providerId)
    if (!provider) {
      return
    }

    const accessType = getProviderAccessType(provider)
    if (enabled && accessType === 'ollama' && !provider.baseUrl.trim()) {
      void message.warning('启用 Ollama 前需要先配置 Base URL')
      return
    }

    if (enabled && accessType !== 'ollama') {
      if (!provider.credentialConfigured) {
        void message.warning(`启用 ${provider.name} 前需要先保存 API Key`)
        return
      }
    }

    dispatch(updateProviderConfig({ providerId, patch: { enabled } }))

    if (!enabled && settings.defaultProviderId === providerId) {
      const fallbackProvider = providers.find((item) => item.id !== providerId && item.enabled)
      if (fallbackProvider) {
        dispatch(
          updateDefaultLlmModel({
            providerId: fallbackProvider.id,
            model: fallbackProvider.models[0] ?? ''
          })
        )
      }
    }

    void message.success(`${provider.name} 已${enabled ? '启用' : '停用'}`)
  }

  const handleSyncProviderModels = async (providerId: string) => {
    const provider = providers.find((item) => item.id === providerId)
    if (!provider) {
      return
    }

    setSyncingProviderId(providerId)
    try {
      const syncedModels = await window.emphant.listProviderModels(provider)
      const models = mergeProviderModels(provider, syncedModels)
      dispatch(updateProviderConfig({ providerId, patch: { models } }))
      if (settings.defaultProviderId === providerId && !models.includes(settings.defaultModel)) {
        dispatch(updateDefaultLlmModel({ providerId, model: filterModelsByType(models, 'llm')[0] ?? '' }))
      }
      if (
        settings.defaultEmbeddingProviderId === providerId &&
        !models.includes(settings.defaultEmbeddingModel ?? '')
      ) {
        dispatch(updateSettings({ defaultEmbeddingModel: filterModelsByType(models, 'embedding')[0] ?? '' }))
      }
      if (
        settings.defaultAsrProviderId === providerId &&
        !models.includes(settings.defaultAsrModel ?? '')
      ) {
        dispatch(updateSettings({ defaultAsrModel: filterModelsByType(models, 'asr')[0] ?? '' }))
      }
      if (
        settings.defaultTtsProviderId === providerId &&
        !models.includes(settings.defaultTtsModel ?? '')
      ) {
        dispatch(updateSettings({ defaultTtsModel: filterModelsByType(models, 'tts')[0] ?? '' }))
      }
      if (
        settings.defaultRerankProviderId === providerId &&
        !models.includes(settings.defaultRerankModel ?? '')
      ) {
        dispatch(updateSettings({ defaultRerankModel: filterModelsByType(models, 'rerank')[0] ?? '' }))
      }
      void message.success(`${provider.name} 已同步 ${models.length} 个模型`)
    } catch (error) {
      void message.error(error instanceof Error ? error.message : `${provider.name} 模型同步失败`)
    } finally {
      setSyncingProviderId(null)
    }
  }

  const handleSaveProviderCredential = async (providerId: string) => {
    const secret = providerSecrets[providerId]?.trim()
    if (!secret) {
      return
    }

    setSavingCredentialId(providerId)
    try {
      await window.emphant.setCredential({ scope: 'provider', id: providerId, secret })
      dispatch(
        updateProviderConfig({
          providerId,
          patch: { credentialConfigured: true }
        })
      )
      setProviderSecrets((current) => ({ ...current, [providerId]: '' }))
      void message.success('API Key 已写入系统安全存储')
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'API Key 保存失败')
    } finally {
      setSavingCredentialId(null)
    }
  }

  const handleOpenAddProvider = () => {
    const preset = getProviderPreset('chatgpt')
    providerForm.setFieldsValue({
      accessType: preset.accessType,
      name: preset.label,
      baseUrl: preset.baseUrl
    })
    setAddingProvider(true)
  }

  const handleAddProvider = async () => {
    const values = await providerForm.validateFields()
    const preset = getProviderPreset(values.accessType)
    const usesCustomEndpoint = customEndpointAccessTypes.includes(values.accessType)
    const provider: ProviderConfig = {
      id: `provider-${values.accessType}-${crypto.randomUUID()}`,
      name: values.name.trim() || preset.label,
      kind: preset.kind,
      accessType: preset.accessType,
      providerKey: preset.accessType,
      custom: true,
      baseUrl: usesCustomEndpoint ? values.baseUrl?.trim() || preset.baseUrl : preset.baseUrl,
      apiKeyHint: preset.apiKeyHint,
      models: preset.models,
      capabilities: preset.capabilities,
      enabled: false
    }

    dispatch(addProviderConfig(provider))
    setAddingProvider(false)
    providerForm.resetFields()
    void message.success(`${provider.name} 已添加`)
  }

  const handleDeleteProvider = async (provider: ProviderConfig) => {
    dispatch(deleteProviderConfig(provider.id))
    await window.emphant.deleteCredential({ scope: 'provider', id: provider.id })
    setProviderSecrets((current) => {
      const next = { ...current }
      delete next[provider.id]
      return next
    })
    void message.success(`${provider.name} 已删除`)
  }

  const openMcpEditor = (server?: McpServerConfig) => {
    const genericProfile = mcpServiceProfiles.generic
    const next =
      server ?? {
        id: crypto.randomUUID(),
        name: genericProfile.defaultName,
        enabled: true,
        transport: genericProfile.transport,
        url: genericProfile.defaultUrl,
        service: 'generic' as const,
        preset: false,
        authMode: genericProfile.authMode,
        authHeaderName: genericProfile.authHeaderName,
        credentialConfigured: false,
        enabledToolNames: [],
        discoveredTools: []
      }
    setEditingMcpServer(next)
    setMcpCredential('')
    mcpForm.setFieldsValue(next)
  }

  const handleSaveMcpServer = async () => {
    if (!editingMcpServer) {
      return
    }
    const values = await mcpForm.validateFields()
    const normalizedValues: McpServerConfig = {
      ...values,
      id: editingMcpServer.id,
      name: values.name.trim(),
      url: values.url.trim(),
      authHeaderName: values.authHeaderName?.trim(),
      enabled: editingMcpServer.enabled,
      credentialConfigured: editingMcpServer.credentialConfigured,
      discoveredTools: editingMcpServer.discoveredTools ?? [],
      enabledToolNames: values.enabledToolNames ?? editingMcpServer.enabledToolNames ?? [],
      docsUrl: editingMcpServer.docsUrl,
      preset:
        editingMcpServer.preset &&
        values.name.trim() === editingMcpServer.name &&
        values.url.trim() === editingMcpServer.url &&
        values.transport === editingMcpServer.transport &&
        values.service === editingMcpServer.service &&
        values.authMode === editingMcpServer.authMode &&
        values.authHeaderName?.trim() === editingMcpServer.authHeaderName
    }
    const server = { ...editingMcpServer, ...normalizedValues }

    if (mcpCredential.trim()) {
      await window.emphant.setCredential({
        scope: 'mcp',
        id: server.id,
        secret: mcpCredential.trim()
      })
      server.credentialConfigured = true
    }

    dispatch(upsertMcpServer(server))
    setEditingMcpServer(null)
    void message.success('外部工具服务已保存')
  }

  const handleTestMcpServer = async (server: McpServerConfig) => {
    setTestingMcpId(server.id)
    try {
      const result = await window.emphant.testMcpServer(server)
      dispatch(
        upsertMcpServer({
          ...server,
          discoveredTools: result.tools,
          enabledToolNames:
            server.enabledToolNames?.length
              ? server.enabledToolNames
              : result.tools.map((tool) => tool.name)
        })
      )
      void message.success(`连接成功，发现 ${result.tools.length} 个工具`)
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '外部工具服务连接失败')
    } finally {
      setTestingMcpId(null)
    }
  }

  const handleResetWorkspace = async () => {
    for (const provider of providers) {
      await window.emphant.deleteCredential({ scope: 'provider', id: provider.id })
    }
    for (const server of mcpServers) {
      await window.emphant.deleteCredential({ scope: 'mcp', id: server.id })
    }
    await clearWorkbenchSnapshot()
    dispatch(resetWorkbench())
    void message.success('本地数据已重置为初始状态')
  }

  const handleSaveWorkspaceData = async () => {
    if (!settings.defaultWorkingDirectory) {
      void message.warning('请先选择工作目录')
      return
    }
    await window.emphant.saveWorkspaceContent(settings.defaultWorkingDirectory, {
      systemNotes,
      knowledgeBases,
      files,
      topics,
      messages,
      todoGroups,
      todoItems
    })
    void message.success('当前用户数据已保存到工作目录')
  }

  const handleClearRestoreSnapshot = async () => {
    await clearWorkbenchSnapshot()
    dispatch(updateSettings({ restoreWorkspaceOnLaunch: false }))
    void message.success('已清除启动恢复快照')
  }

  const renderProviderCard = (provider: ProviderConfig) => {
    const accessType = getProviderAccessType(provider)
    const preset = getProviderPreset(accessType)
    const usesCustomEndpoint = customEndpointAccessTypes.includes(accessType)
    const needsCredential = accessType !== 'ollama'

    return (
      <div key={provider.id} className="provider-card">
        <div className="settings-card-header">
          <div>
            <strong>{provider.name}</strong>
            <span>
              {provider.kind === 'local' ? '本地模型' : '云模型'} · 接入类型：{preset.label}
            </span>
          </div>
          <Space>
            {provider.custom && (
              <Popconfirm
                title="删除这个模型服务？"
                okText="删除"
                cancelText="取消"
                onConfirm={() => void handleDeleteProvider(provider)}
              >
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            )}
            <Switch
              checked={provider.enabled}
              onChange={(checked) => void handleProviderEnabledChange(provider.id, checked)}
            />
          </Space>
        </div>
        {usesCustomEndpoint ? (
          <>
            <Input
              size="small"
              value={provider.name}
              placeholder="服务名称"
              onChange={(event) =>
                dispatch(
                  updateProviderConfig({
                    providerId: provider.id,
                    patch: { name: event.target.value }
                  })
                )
              }
              onBlur={() => void message.success(`${provider.name} 名称已保存`)}
            />
            <Input
              size="small"
              value={provider.baseUrl}
              placeholder="Base URL"
              onChange={(event) =>
                dispatch(
                  updateProviderConfig({
                    providerId: provider.id,
                    patch: { baseUrl: event.target.value }
                  })
                )
              }
              onBlur={() => void message.success(`${provider.name} Base URL 已保存`)}
            />
          </>
        ) : null}
        {needsCredential && (
          <Input.Password
            size="small"
            value={providerSecrets[provider.id] ?? ''}
            placeholder={
              provider.credentialConfigured
                ? '已安全保存；输入新值可替换'
                : provider.apiKeyHint
            }
            onChange={(event) =>
              setProviderSecrets((current) => ({
                ...current,
                [provider.id]: event.target.value
              }))
            }
          />
        )}
        {needsCredential && (
          <Space>
            <Button
              size="small"
              type="primary"
              disabled={!providerSecrets[provider.id]?.trim()}
              loading={savingCredentialId === provider.id}
              onClick={() => void handleSaveProviderCredential(provider.id)}
            >
              保存到安全存储
            </Button>
            <Tag color={provider.credentialConfigured ? 'green' : 'default'}>
              {provider.credentialConfigured ? '已配置' : '未配置'}
            </Tag>
          </Space>
        )}
        <div className="provider-card__models">
          <div className="provider-card__models-header">
            <span>支持模型</span>
            <Button
              size="small"
              loading={syncingProviderId === provider.id}
              onClick={() => void handleSyncProviderModels(provider.id)}
            >
              同步模型
            </Button>
          </div>
          {provider.models.length > 0 ? (
            <Space wrap size={[4, 4]}>
              {provider.models.slice(0, 8).map((model) => (
                <Tag key={model}>{model}</Tag>
              ))}
              {provider.models.length > 8 && (
                <Tag bordered={false}>+{provider.models.length - 8}</Tag>
              )}
            </Space>
          ) : (
            <Typography.Text type="secondary">还没有同步到模型</Typography.Text>
          )}
        </div>
        <Space wrap>
          {provider.capabilities.map((capability) => (
            <Tag key={capability}>{capability}</Tag>
          ))}
        </Space>
      </div>
    )
  }

  const renderModelDefaultField = (field: ModelDefaultField) => {
    const provider = providers.find((item) => item.id === field.providerId)
    const providerOptions = enabledProviders.map((item) => ({
      label: item.name,
      value: item.id
    }))
    const filteredModels = filterModelsByType(provider?.models ?? [], field.modelType)
    const modelOptions = filteredModels.map((model) => ({
      label: model,
      value: model
    }))
    const canSync = Boolean(field.providerId && field.model)

    return (
      <div className="model-default-card" key={field.title}>
        <div className="model-default-card__header">
          <div>
            <Typography.Text strong>{field.title}</Typography.Text>
            <Typography.Paragraph type="secondary">{field.description}</Typography.Paragraph>
          </div>
          <Button
            size="small"
            disabled={!canSync}
            onClick={() => {
              dispatch(
                syncDefaultModelToAgents({
                  modelType: field.modelType,
                  providerId: field.providerId,
                  model: field.model
                })
              )
              void message.success(`${field.title} 已同步到所有智能体`)
            }}
          >
            同步到所有智能体
          </Button>
        </div>
        <Form.Item label="模型服务">
          <Select
            value={field.providerId || undefined}
            options={providerOptions}
            placeholder="先启用至少一个模型服务"
            onChange={(providerId) => {
              const nextProvider = providers.find((item) => item.id === providerId)
              const nextModels = filterModelsByType(nextProvider?.models ?? [], field.modelType)
              field.onChange(providerId, nextModels[0] ?? '')
            }}
          />
        </Form.Item>
        <Form.Item label="模型">
          <Select
            showSearch
            optionFilterProp="label"
            value={field.model || undefined}
            disabled={!provider || filteredModels.length === 0}
            options={modelOptions}
            placeholder={provider ? '没有匹配当前类型的模型' : '先选择模型供应商'}
            onChange={(model) => field.onChange(field.providerId, model)}
          />
        </Form.Item>
      </div>
    )
  }

  return (
    <div className="settings-layout">
      <aside className="settings-layout__sidebar">
        <Card className="workspace-panel page-panel" bordered={false}>
          <Typography.Title level={4}>设置</Typography.Title>
          <Typography.Paragraph type="secondary">
            管理模型服务、默认能力、执行安全和外部工具。修改会立即保存在本机。
          </Typography.Paragraph>
          <div className="settings-nav">
            {(Object.keys(sectionLabels) as SettingsSection[]).map((section) => (
              <button
                key={section}
                className={
                  activeSection === section
                    ? 'settings-nav__item is-active'
                    : 'settings-nav__item'
                }
                onClick={() => setActiveSection(section)}
                type="button"
              >
                <span>{sectionLabels[section]}</span>
                {section === 'providers' && (
                  <Tag bordered={false}>
                    {enabledProviders.length}/{providers.length}
                  </Tag>
                )}
                {section === 'mcp' && (
                  <Tag bordered={false}>
                    {tools.filter((tool) => tool.enabled).length}/{tools.length}
                  </Tag>
                )}
                {section === 'runtime' && (
                  <Tag bordered={false}>
                    {settings.openClawCore?.enabled ? 'OpenClaw' : '内置'}
                  </Tag>
                )}
              </button>
            ))}
          </div>
        </Card>
      </aside>

      <section className="settings-layout__content">
        {setupWarnings.length > 0 && (
          <Alert
            type="warning"
            showIcon
            className="settings-readiness-alert"
            message="工作台还没准备好执行真实任务"
            description={setupWarnings.join(' ')}
          />
        )}
        {activeSection === 'model' && (
          <Card className="workspace-panel" bordered={false}>
            <Typography.Title level={4}>默认能力</Typography.Title>
            <Typography.Paragraph type="secondary">
              为对话、知识检索、语音输入和朗读选择默认模型。修改默认对话模型后，仍使用旧默认模型的智能体会自动同步。
            </Typography.Paragraph>
            <Form layout="vertical" className="settings-form settings-form--model-defaults">
              {renderModelDefaultField({
                modelType: 'llm',
                title: '默认对话模型',
                description: '用于新建智能体、日常对话、知识问答和任务编排。',
                providerId: selectedProvider?.id ?? settings.defaultProviderId,
                model: settings.defaultModel,
                onChange: (providerId, model) => {
                  dispatch(updateDefaultLlmModel({ providerId, model }))
                  void message.success('默认对话模型已更新')
                }
              })}
              {renderModelDefaultField({
                modelType: 'embedding',
                title: '默认检索模型',
                description: '用于知识索引、语义检索和相似内容召回。',
                providerId: settings.defaultEmbeddingProviderId ?? '',
                model: settings.defaultEmbeddingModel ?? '',
                onChange: (providerId, model) =>
                  providerId === settings.defaultEmbeddingProviderId
                    ? handleDefaultAuxModelChange(model, 'defaultEmbeddingModel')
                    : handleDefaultAuxProviderChange(
                        providerId,
                        'embedding',
                        'defaultEmbeddingProviderId',
                        'defaultEmbeddingModel'
                      )
              })}
              {renderModelDefaultField({
                modelType: 'asr',
                title: '默认语音识别模型',
                description: '用于语音转文字和音频内容识别。',
                providerId: settings.defaultAsrProviderId ?? '',
                model: settings.defaultAsrModel ?? '',
                onChange: (providerId, model) =>
                  providerId === settings.defaultAsrProviderId
                    ? handleDefaultAuxModelChange(model, 'defaultAsrModel')
                    : handleDefaultAuxProviderChange(
                        providerId,
                        'asr',
                        'defaultAsrProviderId',
                        'defaultAsrModel'
                      )
              })}
              {renderModelDefaultField({
                modelType: 'tts',
                title: '默认语音朗读模型',
                description: '用于文字转语音和语音播报。',
                providerId: settings.defaultTtsProviderId ?? '',
                model: settings.defaultTtsModel ?? '',
                onChange: (providerId, model) =>
                  providerId === settings.defaultTtsProviderId
                    ? handleDefaultAuxModelChange(model, 'defaultTtsModel')
                    : handleDefaultAuxProviderChange(
                        providerId,
                        'tts',
                        'defaultTtsProviderId',
                        'defaultTtsModel'
                      )
              })}
              {renderModelDefaultField({
                modelType: 'rerank',
                title: '默认重排模型',
                description: '用于把知识检索结果按相关性重新排序。',
                providerId: settings.defaultRerankProviderId ?? '',
                model: settings.defaultRerankModel ?? '',
                onChange: (providerId, model) =>
                  providerId === settings.defaultRerankProviderId
                    ? handleDefaultAuxModelChange(model, 'defaultRerankModel')
                    : handleDefaultAuxProviderChange(
                        providerId,
                        'rerank',
                        'defaultRerankProviderId',
                        'defaultRerankModel'
                      )
              })}
              <Form.Item label="模型失败时使用模拟回复">
                <Switch
                  checked={isDevMode && settings.useMockResponsesWhenProviderFails}
                  disabled={!isDevMode}
                  onChange={(checked) =>
                    dispatch(updateSettings({ useMockResponsesWhenProviderFails: checked }))
                  }
                />
                <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
                  {isDevMode
                    ? '仅用于界面调试。处理真实任务时保持关闭，避免把模拟内容误认为模型结果。'
                    : '仅开发调试模式可开启。正式运行时不会自动使用模拟回复。'}
                </Typography.Paragraph>
	              </Form.Item>
	            </Form>
            <div className="background-task-status">
              <div className="background-task-status__header">
                <strong>后台任务状态</strong>
                <span>查看轮询和定时任务的运行、失败、上次执行和下次执行时间。</span>
              </div>
              <div className="background-task-status__grid">
                {backgroundTaskStatuses.map((item) => (
                  <div key={item.title} className="background-task-status__item">
                    <div>
                      <strong>{item.title}</strong>
                      <Tag color={item.tone}>{item.status}</Tag>
                    </div>
                    <span>上次执行：{item.lastRun}</span>
                    <span>下次执行：{item.nextRun}</span>
                    {item.failure && <p>失败原因：{item.failure}</p>}
                    {item.title === '邮件轮询' && (
                      <Button
                        size="small"
                        onClick={() =>
                          dispatch(
                            updateMailAgentSettings({ enabled: !mailAgentSettings.enabled })
                          )
                        }
                      >
                        {mailAgentSettings.enabled ? '暂停轮询' : '恢复轮询'}
                      </Button>
                    )}
                    {item.title === '定时任务' && failedTodoItems[0] && (
                      <Button
                        size="small"
                        onClick={() => void dispatch(runTodoTask(failedTodoItems[0].id))}
                      >
                        重试失败任务
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="run-history-panel">
              <div className="background-task-status__header">
                <strong>运行历史分析</strong>
                <span>按会话、智能体、任务和日期筛选模型调用、工具调用、失败率和高风险动作。</span>
              </div>
              <div className="run-history-summary">
                <div>
                  <span>模型调用</span>
                  <strong>{runHistorySummary.runs}</strong>
                </div>
                <div>
                  <span>工具调用</span>
                  <strong>{runHistorySummary.toolCalls}</strong>
                </div>
                <div>
                  <span>失败率</span>
                  <strong>{runHistorySummary.failureRate}%</strong>
                </div>
                <div>
                  <span>高风险动作</span>
                  <strong>{runHistorySummary.highRiskActions}</strong>
                </div>
              </div>
              <div className="run-history-filters">
                <Select
                  value={runHistoryTopicFilter}
                  options={[
                    { label: '全部会话', value: 'all' },
                    ...topics.map((topic) => ({ label: topic.title, value: topic.id }))
                  ]}
                  onChange={setRunHistoryTopicFilter}
                />
                <Select
                  value={runHistoryAssistantFilter}
                  options={[
                    { label: '全部智能体', value: 'all' },
                    ...runHistoryAssistantOptions.map((assistantName) => ({
                      label: assistantName,
                      value: assistantName
                    }))
                  ]}
                  onChange={setRunHistoryAssistantFilter}
                />
                <Select
                  value={runHistoryTaskFilter}
                  options={[
                    { label: '全部任务', value: 'all' },
                    ...todoItems
                      .filter((item) => item.workspaceTopicId)
                      .map((item) => ({ label: item.title, value: item.id }))
                  ]}
                  onChange={setRunHistoryTaskFilter}
                />
                <Input
                  type="date"
                  value={runHistoryDateFilter}
                  onChange={(event) => setRunHistoryDateFilter(event.target.value)}
                />
                <Button
                  disabled={filteredRunHistoryRecords.length === 0}
                  onClick={handleExportRunHistory}
                >
                  导出运行日志
                </Button>
              </div>
              <div className="run-history-list">
                {filteredRunHistoryRecords.slice(0, 8).map((record) => (
                  <div key={record.runId} className="run-history-item">
                    <div>
                      <strong>{record.assistantName}</strong>
                      <Tag color={record.status === 'error' ? 'red' : record.simulated ? 'gold' : 'blue'}>
                        {record.simulated ? '模拟' : record.status}
                      </Tag>
                    </div>
                    <span>{record.topicTitle}{record.taskTitle ? ` · ${record.taskTitle}` : ''}</span>
                    <span>
                      {record.model} · 工具 {record.toolCount} · 高风险 {record.highRiskCount} ·{' '}
                      {new Date(record.createdAt).toLocaleString()}
                    </span>
                  </div>
                ))}
                {filteredRunHistoryRecords.length === 0 && (
                  <Typography.Text type="secondary">暂无匹配的运行记录</Typography.Text>
                )}
              </div>
            </div>
	          </Card>
	        )}

        {activeSection === 'runtime' && (
          <Card className="workspace-panel" bordered={false}>
            <Typography.Title level={4}>执行安全</Typography.Title>
            <Typography.Paragraph type="secondary">
              控制智能体如何协作，以及写文件、发邮件、执行命令等动作是否需要先确认。
            </Typography.Paragraph>
            <Form layout="vertical" className="settings-form">
              <Form.Item label="协作方式">
                <Select
                  value={settings.openClawCore?.enabled ? 'openclaw-core' : 'builtin'}
                  options={[
                    { label: '多智能体协作', value: 'openclaw-core' },
                    { label: '单智能体执行', value: 'builtin' }
                  ]}
                  onChange={(value) =>
                    dispatch(
                      updateSettings({
                        openClawCore: {
                          enabled: value === 'openclaw-core',
                          sandboxEnabled: settings.openClawCore?.sandboxEnabled ?? false,
                          maxDelegatedAgents: settings.openClawCore?.maxDelegatedAgents ?? 3,
                          auditLogEnabled: settings.openClawCore?.auditLogEnabled ?? true,
                          requireToolApproval: settings.openClawCore?.requireToolApproval ?? false
                        }
                      })
                    )
                  }
                />
              </Form.Item>
              <Form.Item label="隔离执行">
                <Space wrap>
                  <Switch
                    checked={settings.openClawCore?.sandboxEnabled ?? false}
                    checkedChildren="开启"
                    unCheckedChildren="关闭"
                    onChange={(checked) =>
                      dispatch(
                        updateSettings({
                          openClawCore: {
                            enabled: settings.openClawCore?.enabled ?? true,
                            sandboxEnabled: checked,
                            maxDelegatedAgents: settings.openClawCore?.maxDelegatedAgents ?? 3,
                            auditLogEnabled: settings.openClawCore?.auditLogEnabled ?? true,
                            requireToolApproval: settings.openClawCore?.requireToolApproval ?? false
                          }
                        })
                      )
                    }
                  />
                  <Tag color={(settings.openClawCore?.sandboxEnabled ?? false) ? 'blue' : 'red'}>
                    {(settings.openClawCore?.sandboxEnabled ?? false)
                      ? '已限制工具边界'
                      : '可直接访问本机环境'}
                  </Tag>
                </Space>
              </Form.Item>
              <Form.Item label="最多协作智能体">
                <Select
                  value={settings.openClawCore?.maxDelegatedAgents ?? 3}
                  options={[1, 2, 3, 4, 5].map((value) => ({
                    label: `${value} 个`,
                    value
                  }))}
                  onChange={(value) =>
                    dispatch(
                      updateSettings({
                        openClawCore: {
                          enabled: settings.openClawCore?.enabled ?? true,
                          sandboxEnabled: settings.openClawCore?.sandboxEnabled ?? false,
                          maxDelegatedAgents: value,
                          auditLogEnabled: settings.openClawCore?.auditLogEnabled ?? true,
                          requireToolApproval: settings.openClawCore?.requireToolApproval ?? false
                        }
                      })
                    )
                  }
                />
              </Form.Item>
              <Form.Item label="记录执行日志">
                <Switch
                  checked={settings.openClawCore?.auditLogEnabled ?? true}
                  onChange={(checked) =>
                    dispatch(
                      updateSettings({
                        openClawCore: {
                          enabled: settings.openClawCore?.enabled ?? true,
                          sandboxEnabled: settings.openClawCore?.sandboxEnabled ?? false,
                          maxDelegatedAgents: settings.openClawCore?.maxDelegatedAgents ?? 3,
                          auditLogEnabled: checked,
                          requireToolApproval: settings.openClawCore?.requireToolApproval ?? false
                        }
                      })
                    )
                  }
                />
              </Form.Item>
              <Form.Item label="执行前确认">
                <Switch
                  checked={settings.openClawCore?.requireToolApproval ?? false}
                  onChange={(checked) =>
                    dispatch(
                      updateSettings({
                        openClawCore: {
                          enabled: settings.openClawCore?.enabled ?? true,
                          sandboxEnabled: settings.openClawCore?.sandboxEnabled ?? false,
                          maxDelegatedAgents: settings.openClawCore?.maxDelegatedAgents ?? 3,
                          auditLogEnabled: settings.openClawCore?.auditLogEnabled ?? true,
                          requireToolApproval: checked
                        }
                      })
                    )
                  }
                />
                <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
                  建议保持开启。写文件、发邮件、执行命令、访问数据库等动作，应先展示计划，再由你确认。
                </Typography.Paragraph>
              </Form.Item>
            </Form>
          </Card>
        )}

        {activeSection === 'workspace' && (
          <Card className="workspace-panel" bordered={false}>
            <Typography.Title level={4}>工作目录</Typography.Title>
            <Typography.Paragraph type="secondary">
              知识、笔记和任务记录会保存在这个目录下。新建会话会继承它，文件操作也会限制在当前会话目录内。
            </Typography.Paragraph>
            <Form layout="vertical" className="settings-form">
              <Form.Item label="目录路径">
                <Input
                  readOnly
                  value={settings.defaultWorkingDirectory}
                  placeholder="正在准备默认工作目录"
                  addonAfter={
                    <Button
                      type="text"
                      size="small"
                      icon={<FolderOpenOutlined />}
                      onClick={() => void handleSelectDefaultWorkingDirectory()}
                    >
                      选择
                    </Button>
                  }
                />
              </Form.Item>
              <Space wrap>
                <Button
                  type="primary"
                  icon={<FolderOpenOutlined />}
                  onClick={() => void handleSelectDefaultWorkingDirectory()}
                >
                  选择目录
                </Button>
                <Button
                  onClick={async () => {
                    const directory = await window.emphant.getDefaultWorkspaceDirectory()
                    await window.emphant.saveWorkspaceContent(directory, {
                      systemNotes,
                      knowledgeBases,
                      files,
                      topics,
                      messages,
                      todoGroups,
                      todoItems
                    })
                    dispatch(updateSettings({ defaultWorkingDirectory: directory }))
                    void message.success('已恢复系统推荐目录，知识和笔记已迁移')
                  }}
                >
                  使用推荐目录
                </Button>
              </Space>
            </Form>
          </Card>
        )}

        {activeSection === 'data' && (
          <Card className="workspace-panel" bordered={false}>
            <Typography.Title level={4}>数据管理</Typography.Title>
            <Typography.Paragraph type="secondary">
              查看不同数据的来源、保存位置和当前数量。清除或迁移前，请先确认它属于系统预设、用户资产、安全凭据、工作目录文件还是临时运行状态。
            </Typography.Paragraph>
            <Space wrap style={{ marginBottom: 18 }}>
              <Button
                type="primary"
                icon={<FolderOpenOutlined />}
                disabled={!settings.defaultWorkingDirectory}
                onClick={() => void handleSaveWorkspaceData()}
              >
                保存用户数据到工作目录
              </Button>
              <Popconfirm
                title="清除启动恢复快照？"
                description="只会清除本机用于下次启动恢复的快照，不会删除当前工作目录文件。"
                okText="清除"
                cancelText="取消"
                onConfirm={() => void handleClearRestoreSnapshot()}
              >
                <Button>清除恢复快照</Button>
              </Popconfirm>
            </Space>
            <div className="settings-card-grid">
              {dataInventory.map((item) => (
                <div key={item.title} className="provider-card">
                  <strong>{item.title}</strong>
                  <span>{item.description}</span>
                  <Space wrap>
                    <Tag>{item.location}</Tag>
                    <Tag color="blue">{item.status}</Tag>
                    <Tag color="green">导出：{item.exportStatus}</Tag>
                    <Tag color="orange">清除：{item.clearStatus}</Tag>
                  </Space>
                </div>
              ))}
            </div>
          </Card>
        )}

        {activeSection === 'providers' && (
          <Card className="workspace-panel" bordered={false}>
            <div className="settings-card-header">
              <div>
                <Typography.Title level={4}>模型服务</Typography.Title>
                <Typography.Paragraph type="secondary">
                  接入云端或本地模型。常见服务会自动填入接口地址，自定义服务仍可手动填写。
                </Typography.Paragraph>
              </div>
              <Button type="primary" icon={<PlusOutlined />} onClick={handleOpenAddProvider}>
                新增接入
              </Button>
            </div>
            <div className="provider-section">
              <div className="provider-section__header">
                <Typography.Text strong>已启用</Typography.Text>
                <Tag bordered={false}>{enabledProviders.length}</Tag>
              </div>
              {enabledProviders.length > 0 ? (
                <div className="settings-card-grid">
                  {enabledProviders.map(renderProviderCard)}
                </div>
              ) : (
                <Typography.Text type="secondary">还没有启用模型服务</Typography.Text>
              )}
            </div>
            <div className="provider-section__divider" />
            <div className="provider-section">
              <div className="provider-section__header">
                <Typography.Text strong>未启用</Typography.Text>
                <Tag bordered={false}>{disabledProviders.length}</Tag>
              </div>
              {disabledProviders.length > 0 ? (
                <div className="settings-card-grid">
                  {disabledProviders.map(renderProviderCard)}
                </div>
              ) : (
                <Typography.Text type="secondary">没有可添加的预置服务</Typography.Text>
              )}
            </div>
          </Card>
        )}

        <Modal
          title="新增模型服务"
          open={addingProvider}
          okText="添加"
          cancelText="取消"
          onCancel={() => setAddingProvider(false)}
          onOk={() => void handleAddProvider()}
          destroyOnHidden
        >
          <Form
            form={providerForm}
            layout="vertical"
            initialValues={{
              accessType: 'chatgpt',
              name: 'ChatGPT',
              baseUrl: 'https://api.openai.com/v1'
            }}
          >
            <Form.Item label="接入类型" name="accessType" rules={[{ required: true }]}>
              <Select
                options={providerPresets.map((preset) => ({
                  label: preset.label,
                  value: preset.accessType
                }))}
                onChange={(accessType: ProviderAccessType) => {
                  const preset = getProviderPreset(accessType)
                  providerForm.setFieldsValue({
                    name: preset.label,
                    baseUrl: preset.baseUrl
                  })
                }}
              />
            </Form.Item>
            <Form.Item
              label={addingProviderUsesCustomEndpoint ? '服务名称' : '模型服务'}
              name="name"
              rules={[{ required: true, message: '请输入服务名称' }]}
            >
              <Input placeholder={addingProviderPreset.label} />
            </Form.Item>
            {addingProviderUsesCustomEndpoint ? (
              <Form.Item
                label="Base URL"
                name="baseUrl"
                rules={[{ required: true, message: '请输入 Base URL' }]}
              >
                <Input placeholder={addingProviderPreset.baseUrl} />
              </Form.Item>
            ) : (
              <Typography.Text type="secondary">
                {addingProviderPreset.label} 会使用内置接口地址，添加后只需要保存 API Key。
              </Typography.Text>
            )}
          </Form>
        </Modal>

        {activeSection === 'persistence' && (
          <Card className="workspace-panel" bordered={false}>
            <Typography.Title level={4}>数据恢复</Typography.Title>
            <Typography.Paragraph type="secondary">
              控制下次启动时是否恢复会话、智能体和任务上下文。模型服务和工具开关始终保留。
            </Typography.Paragraph>
            <Form layout="vertical" className="settings-form">
              <Form.Item label="启动时恢复上次工作区">
                <Switch
                  checked={settings.restoreWorkspaceOnLaunch}
                  onChange={(checked) =>
                    dispatch(updateSettings({ restoreWorkspaceOnLaunch: checked }))
                  }
                />
              </Form.Item>
              <Form.Item label="重置本地工作区数据">
                <Popconfirm
                  title="重置本地工作区数据？"
                  description="会清空当前聊天、智能体、知识、任务和设置，恢复到初始状态。"
                  onConfirm={() => void handleResetWorkspace()}
                >
                  <Button danger>重置为初始状态</Button>
                </Popconfirm>
              </Form.Item>
            </Form>
          </Card>
        )}

        {activeSection === 'mcp' && (
          <Card className="workspace-panel page-panel" bordered={false}>
            <div className="settings-card-header">
              <div>
                <Typography.Title level={4}>外部工具服务</Typography.Title>
                <Typography.Paragraph type="secondary">
                  接入外部工具服务，连接测试后选择哪些工具允许智能体使用。数据库、容器运维、知识管理和协作工具都在这里控制。
                </Typography.Paragraph>
              </div>
              <Button type="primary" onClick={() => openMcpEditor()}>
                添加工具服务
              </Button>
            </div>
            {mcpServers.length > 0 ? (
              <div className="settings-card-grid">
                {mcpServers.map((server) => (
                  <div key={server.id} className="provider-card">
                    <div className="settings-card-header">
                      <div>
                        <strong>{server.name}</strong>
                        <span>{server.url}</span>
                      </div>
                      <Switch
                        checked={server.enabled}
                        onChange={(enabled) => dispatch(upsertMcpServer({ ...server, enabled }))}
                      />
                    </div>
                    <Space wrap>
                      <Tag>{server.transport.toUpperCase()}</Tag>
                      {server.preset && <Tag color="blue">推荐预置</Tag>}
                      <Tag>{server.authMode ?? 'header'}</Tag>
                      <Tag color={server.credentialConfigured ? 'green' : 'default'}>
                        {server.credentialConfigured ? '已配置凭据' : '无凭据'}
                      </Tag>
                      <Tag>
                        {server.enabledToolNames?.length ?? 0}/
                        {server.discoveredTools?.length ?? 0} 工具
                      </Tag>
                    </Space>
                    <Space wrap>
                      <Button size="small" onClick={() => openMcpEditor(server)}>
                        编辑
                      </Button>
                      {server.docsUrl && (
                        <Button size="small" href={server.docsUrl} target="_blank">
                          文档
                        </Button>
                      )}
                      <Button
                        size="small"
                        loading={testingMcpId === server.id}
                        onClick={() => void handleTestMcpServer(server)}
                      >
                        测试并发现工具
                      </Button>
                      <Popconfirm
                        title={`删除 ${server.name}？`}
                        onConfirm={async () => {
                          await window.emphant.deleteCredential({ scope: 'mcp', id: server.id })
                          dispatch(deleteMcpServer(server.id))
                        }}
                      >
                        <Button size="small" danger>
                          删除
                        </Button>
                      </Popconfirm>
                    </Space>
                  </div>
                ))}
              </div>
            ) : (
              <Empty description="还没有配置外部工具服务" />
            )}

            <Typography.Title level={5}>内置工具开关</Typography.Title>
            <Typography.Paragraph type="secondary">
              关闭工具后，即使智能体绑定了它，也不会在对话中调用。能改动文件或系统的工具默认关闭，建议按任务临时开启。
              当前已启用 {enabledHighRiskToolCount}/{highRiskToolCount} 个敏感工具。
            </Typography.Paragraph>
            {tools.length > 0 ? (
              <div className="settings-card-grid">
                {tools.map((tool) => (
                  <div key={tool.id} className="provider-card">
                    <div className="settings-card-header">
                      <div>
                        <strong>{tool.name}</strong>
                        <span>{tool.description}</span>
                      </div>
                      <Switch
                        checked={tool.enabled}
                        onChange={(checked) =>
                          dispatch(
                            updateMcpToolConfig({
                              toolId: tool.id,
                              patch: { enabled: checked }
                            })
                          )
                        }
                      />
                    </div>
                    <Space wrap>
                      <Tag color={tool.enabled ? 'blue' : 'default'}>{tool.serverName}</Tag>
                      <Tag>{tool.category}</Tag>
                    </Space>
                  </div>
                ))}
              </div>
            ) : (
              <Empty description="还没有可用工具" />
            )}
          </Card>
        )}
      </section>

      <Modal
        open={Boolean(editingMcpServer)}
        title={editingMcpServer?.name ? `编辑 ${editingMcpServer.name}` : '添加外部工具服务'}
        onCancel={() => {
          setEditingMcpServer(null)
          mcpForm.resetFields()
        }}
        onOk={() => void handleSaveMcpServer()}
        destroyOnHidden
      >
        <Form form={mcpForm} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input placeholder="例如 Company Search" />
          </Form.Item>
          <Form.Item name="transport" label="Transport" rules={[{ required: true }]}>
            <Select
              options={[
                { label: 'Streamable HTTP', value: 'http' },
                { label: 'SSE', value: 'sse' }
              ]}
            />
          </Form.Item>
          <Form.Item name="service" label="服务类型">
            <Select
              options={mcpServiceOptions}
              onChange={(service: McpService) => {
                const profile = mcpServiceProfiles[service]
                mcpForm.setFieldsValue({
                  name: profile.defaultName,
                  transport: profile.transport,
                  url: profile.defaultUrl,
                  authMode: profile.authMode,
                  authHeaderName: profile.authHeaderName
                })
              }}
            />
          </Form.Item>
          <Typography.Paragraph type="secondary">
            {selectedMcpServiceProfile.description}
          </Typography.Paragraph>
          <Form.Item
            name="url"
            label={`Server URL（${selectedMcpServiceProfile.label}）`}
            rules={[
              { required: true },
              { type: 'url', message: '请输入有效的 HTTP(S) URL' }
            ]}
          >
            <Input placeholder={selectedMcpServiceProfile.defaultUrl} />
          </Form.Item>
          <Form.Item name="authMode" label="认证方式">
            <Select
              options={[
                { label: '无需认证', value: 'none' },
                { label: 'Header Token', value: 'header' },
                { label: 'OAuth Access Token（过渡）', value: 'oauth' }
              ]}
            />
          </Form.Item>
          {selectedMcpAuthMode !== 'none' && (
            <>
              <Form.Item name="authHeaderName" label="认证 Header">
                <Input placeholder={selectedMcpServiceProfile.authHeaderName ?? 'Authorization'} />
              </Form.Item>
              <Form.Item label="认证值">
                <Input.Password
                  value={mcpCredential}
                  placeholder={
                    editingMcpServer?.credentialConfigured
                      ? '已安全保存；输入新值可替换'
                      : selectedMcpServiceProfile.credentialPlaceholder
                  }
                  onChange={(event) => setMcpCredential(event.target.value)}
                />
              </Form.Item>
            </>
          )}
          {(editingMcpServer?.discoveredTools?.length ?? 0) > 0 && (
            <Form.Item name="enabledToolNames" label="启用工具">
              <Select
                mode="multiple"
                options={editingMcpServer?.discoveredTools?.map((tool) => ({
                  label: tool.description ? `${tool.name} — ${tool.description}` : tool.name,
                  value: tool.name
                }))}
              />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  )
}
