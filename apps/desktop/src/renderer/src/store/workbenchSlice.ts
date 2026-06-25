import { createAsyncThunk, createSlice, nanoid } from '@reduxjs/toolkit'
import type { PayloadAction } from '@reduxjs/toolkit'
import { composeAssistantBlocks } from '@/lib/mockAi'
import {
  buildKnowledgeChunks,
  buildKnowledgeContent,
  searchKnowledgeBases
} from '@/lib/knowledge'
import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  Assistant,
  FileRecord,
  KnowledgeBase,
  KnowledgeExtractionEvent,
  KnowledgeGraph,
  KnowledgeIndexResult,
  McpServerConfig,
  McpTool,
  MailAgentSettings,
  MailCheckResult,
  MailNotification,
  Message,
  MessageBlock,
  MessageRole,
  ProviderConfig,
  Skill,
  SystemNote,
  TodoItem,
  TodoNotification,
  Topic,
  TodoStatus,
  WorkbenchState,
  WorkspaceContentSnapshot,
  WorkspaceSettings
} from '@emphant/shared/types'
import type { AppDispatch, RootState } from './index'

const now = () => new Date().toISOString()

const shouldCreateMailCheckErrorNotification = (message: string) =>
  !/缺少完整的 IMAP\/SMTP 安全凭据/.test(message)

const upsertMailCheckErrorNotification = (
  state: WorkbenchState,
  error: { accountAddress?: string; message: string },
  checkedAt = now()
) => {
  if (!shouldCreateMailCheckErrorNotification(error.message)) return

  const accountAddress = error.accountAddress?.trim() || '全部邮箱'
  const isTimeout = /(timeout|timed out|超时|ETIMEDOUT|ESOCKETTIMEDOUT)/i.test(
    error.message
  )
  const id = `mail-check-error:${accountAddress.toLowerCase()}`
  const existing = state.todoNotifications.find((notification) => notification.id === id)
  const patch: TodoNotification = {
    id,
    todoId: '',
    title: isTimeout ? '邮箱检查超时' : '邮箱检查失败',
    message: `${accountAddress}：${error.message}`,
    createdAt: checkedAt,
    read: false
  }

  if (existing) {
    Object.assign(existing, patch)
  } else {
    state.todoNotifications.unshift(patch)
  }
}

const mailTypeLabel = (type: MailNotification['accountType']) =>
  type === 'work' ? '公司邮件' : type === 'personal' ? '个人邮件' : '其他邮件'

const buildUnreadMailContext = (notifications: MailNotification[]) => {
  const unread = notifications
    .filter((mail) => mail.unread && !mail.processed)
    .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
    .slice(0, 30)

  if (unread.length === 0) {
    return '实时邮箱检查完成，目前没有未读邮件。'
  }

  let remainingLength = 30_000
  const entries: string[] = []
  for (const [index, mail] of unread.entries()) {
    const entry = [
      `### 未读邮件 ${index + 1}`,
      `类型：${mailTypeLabel(mail.accountType)}`,
      `收件邮箱：${mail.accountAddress}`,
      `发件人：${mail.sender} <${mail.senderEmail}>`,
      `主题：${mail.subject}`,
      `时间：${new Date(mail.receivedAt).toLocaleString()}`,
      '正文：',
      mail.content || mail.preview
    ].join('\n')
    if (entry.length > remainingLength) break
    entries.push(entry)
    remainingLength -= entry.length
  }

  return [
    `以下是长期记忆中全部已配置邮箱的实时未读邮件，共 ${unread.length} 封。`,
    '请基于邮件正文整理，不要声称看不到邮箱；输出时按邮箱类型和账号分组，并提取重要事项、截止时间、需要回复的邮件与可归档邮件。',
    '',
    ...entries
  ].join('\n\n')
}

const createTextBlock = (
  content: string,
  title?: string,
  meta?: Record<string, string>,
  status: MessageBlock['status'] = 'done'
): MessageBlock => ({
  id: nanoid(),
  type: 'text',
  content,
  title,
  meta,
  status
})

const makeMessage = ({
  id,
  role,
  topicId,
  blocks,
  assistantName
}: {
  id?: string
  role: MessageRole
  topicId: string
  blocks: MessageBlock[]
  assistantName?: string
}): Message => ({
  id: id ?? nanoid(),
  topicId,
  role,
  createdAt: now(),
  assistantName,
  status: 'done',
  blocks
})

const initialProviders: ProviderConfig[] = [
  {
    id: 'provider-openai-compatible',
    name: 'OpenAI Compatible',
    kind: 'cloud',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyHint: 'sk-...',
    models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o-mini'],
    capabilities: ['chat', 'vision', 'tools', 'knowledge'],
    enabled: true
  },
  {
    id: 'provider-anthropic',
    name: 'Anthropic',
    kind: 'cloud',
    baseUrl: 'https://api.anthropic.com',
    apiKeyHint: 'sk-ant-...',
    models: ['claude-sonnet-4', 'claude-haiku-3.5'],
    capabilities: ['chat', 'vision', 'tools'],
    enabled: true
  },
  {
    id: 'provider-ollama',
    name: 'Ollama',
    kind: 'local',
    baseUrl: 'http://127.0.0.1:11434',
    apiKeyHint: '无须 API Key',
    models: ['qwen3:8b', 'llama3.1:8b'],
    capabilities: ['chat', 'knowledge'],
    enabled: true
  }
]

const initialKnowledgeBases: KnowledgeBase[] = [
  {
    id: 'kb-prd',
    name: '产品需求库',
    description: '收录 PRD、路线图和需求分析资料。',
    sourceFileIds: [],
    chunkCount: 128,
    status: 'ready',
    tags: ['prd', 'planning'],
    indexedContent: '产品目标包括多模型统一接入、助手与任务组织、结构化消息、知识库问答、MCP 工具调用和桌面端效率能力。'
  },
  {
    id: 'kb-design',
    name: '设计规范库',
    description: '收录页面设计、设计系统和视觉规范。',
    sourceFileIds: [],
    chunkCount: 84,
    status: 'ready',
    tags: ['design', 'ui'],
    indexedContent: '前端整体是桌面工作台形态，聊天页是视觉基准，页面应统一双栏或三段式布局以及工具型视觉语言。'
  }
]

const initialMcpTools: McpTool[] = [
  {
    id: 'tool-search',
    name: 'Web Search',
    description: '用于补充实时信息和网页检索。',
    serverName: 'mcp-search',
    enabled: true,
    category: 'search'
  },
  {
    id: 'tool-filesystem',
    name: 'File System',
    description: '用于检索和引用本地文件。',
    serverName: 'mcp-filesystem',
    enabled: true,
    category: 'filesystem'
  },
  {
    id: 'tool-file-write',
    name: 'Write File',
    description: '在当前会话工作目录内创建文件或覆盖已有文件。',
    serverName: 'mcp-filesystem',
    enabled: true,
    category: 'filesystem-write'
  },
  {
    id: 'tool-file-edit',
    name: 'Edit File',
    description: '在当前会话工作目录内精确修改已有文本文件。',
    serverName: 'mcp-filesystem',
    enabled: true,
    category: 'filesystem-write'
  },
  {
    id: 'tool-document-extract',
    name: 'Document Extract',
    description: '使用 MarkItDown 提取 PDF、Word、PowerPoint、Excel 和 EPUB 正文。',
    serverName: 'microsoft-markitdown',
    enabled: true,
    category: 'filesystem'
  },
  {
    id: 'tool-automation',
    name: 'Workflow Automation',
    description: '用于整理任务步骤、生成待办和追踪执行状态。',
    serverName: 'mcp-automation',
    enabled: true,
    category: 'automation'
  },
  {
    id: 'tool-shell-command',
    name: 'System Command',
    description: '在当前工作区内执行低风险终端命令，返回 stdout、stderr 和退出码。',
    serverName: 'mcp-system-command',
    enabled: true,
    category: 'command'
  },
  {
    id: 'tool-system-automation',
    name: 'System Automation',
    description: '用于打开应用、剪贴板、截图、通知等桌面系统操作的受控扩展位。',
    serverName: 'mcp-system-automation',
    enabled: true,
    category: 'system'
  }
]

const initialFiles: FileRecord[] = [
  {
    id: 'file-prd',
    name: 'emphant-studio-prd.md',
    mimeType: 'text/markdown',
    size: 18600,
    uploadedAt: now(),
    contentText: 'Emphant Studio 是一款面向桌面端的 AI 工作台产品，支持多模型、知识库、工具和文件能力。'
  }
]

const initialTodoItems: TodoItem[] = [
  {
    id: 'todo-chat-workbench',
    title: '完善聊天工作台主链路',
    description: '补齐真实 Provider 调用、错误态、流式输出和上下文裁剪。',
    taskGroup: '工作台任务组',
    status: 'pending',
    createdAt: now(),
    updatedAt: now(),
    createdBy: 'system'
  },
  {
    id: 'todo-knowledge',
    title: '打通知识库导入与检索',
    description: '支持更多文件类型、切片预览、索引状态和引用回溯。',
    taskGroup: '知识库任务组',
    status: 'pending',
    createdAt: now(),
    updatedAt: now(),
    createdBy: 'system'
  },
  {
    id: 'todo-agent-workflow',
    title: '扩展 Agent 工作流',
    description: '加入 Agent Session、任务状态跟踪和结果回写。',
    taskGroup: 'Agent 工作流任务组',
    status: 'pending',
    createdAt: now(),
    updatedAt: now(),
    createdBy: 'system'
  },
  {
    id: 'todo-notes',
    title: '增强笔记与 AI 联动',
    description: '接入自动保存、内容块、选区解释和写作辅助。',
    taskGroup: '笔记任务组',
    status: 'pending',
    createdAt: now(),
    updatedAt: now(),
    createdBy: 'system'
  },
  {
    id: 'todo-desktop',
    title: '沉淀桌面端能力',
    description: '完善托盘、快捷键、协议唤起、备份恢复和多窗口行为。',
    taskGroup: '桌面能力任务组',
    status: 'completed',
    createdAt: now(),
    updatedAt: now(),
    completedAt: now(),
    createdBy: 'system'
  }
]

const initialTodoNotifications: TodoNotification[] = []
const initialTodoGroups: string[] = []

const initialMcpServers: McpServerConfig[] = [
  {
    id: 'preset-firecrawl',
    name: 'Firecrawl（本地）',
    enabled: false,
    transport: 'http',
    url: 'http://127.0.0.1:3000/mcp',
    service: 'firecrawl',
    preset: true,
    docsUrl: 'https://github.com/firecrawl/firecrawl-mcp-server',
    authMode: 'header',
    authHeaderName: 'Authorization',
    credentialConfigured: false,
    enabledToolNames: [],
    discoveredTools: []
  },
  {
    id: 'preset-todoist',
    name: 'Todoist（官方）',
    enabled: false,
    transport: 'http',
    url: 'https://ai.todoist.net/mcp',
    service: 'todoist',
    preset: true,
    docsUrl: 'https://github.com/Doist/todoist-mcp',
    authMode: 'oauth',
    credentialConfigured: false,
    enabledToolNames: [],
    discoveredTools: []
  },
  {
    id: 'preset-notion',
    name: 'Notion（本地）',
    enabled: false,
    transport: 'http',
    url: 'http://127.0.0.1:3000/mcp',
    service: 'notion',
    preset: true,
    docsUrl: 'https://github.com/makenotion/notion-mcp-server',
    authMode: 'header',
    authHeaderName: 'Authorization',
    credentialConfigured: false,
    enabledToolNames: [],
    discoveredTools: []
  }
]

const initialAssistants: Assistant[] = [
  {
    id: 'assistant-main',
    name: '意图识别',
    description: '默认入口，负责识别用户意图并调度一个或多个专业 Agent。',
    providerId: 'provider-openai-compatible',
    model: 'gpt-4.1',
    systemPrompt:
      '你是 Emphant Studio 的意图识别 Agent。先理解用户目标，再决定直接回答或委派给一个或多个专业 Agent，最后汇总为统一答复。',
    contextLimit: 12,
    capabilities: ['意图识别', '自动路由', '多 Agent 协作', '工具调用'],
    knowledgeBaseIds: ['kb-prd', 'kb-design'],
    enabledToolIds: [
      'tool-search',
      'tool-filesystem',
      'tool-document-extract',
      'tool-file-write',
      'tool-file-edit'
    ]
  },
  {
    id: 'assistant-mail',
    name: '邮件助手',
    description: '定时检查邮箱，将新邮件转为工作台任务，并根据处理意见回复或发送邮件。',
    providerId: 'provider-openai-compatible',
    model: 'gpt-4.1-mini',
    systemPrompt:
      '你是 Emphant Studio 的邮件助手。负责检查新邮件、提取发件人和主题、创建处理任务，并根据用户在任务中的意见回复邮件。用户明确要求向某个邮箱发信时，可直接生成并发送邮件；删除或批量发送仍需确认。',
    contextLimit: 12,
    capabilities: ['邮件检查', '新邮件通知', '邮件回复', '主动发信'],
    knowledgeBaseIds: [],
    enabledToolIds: []
  },
  {
    id: 'assistant-strategy',
    name: '策略助手',
    description: '适合梳理需求、规划方案和输出结构化结论。',
    providerId: 'provider-openai-compatible',
    model: 'gpt-4.1',
    systemPrompt: '你是一个偏产品与策略分析的 AI 助手，回答时优先结构化、简洁、可执行。',
    contextLimit: 8,
    capabilities: ['聊天', '知识库', '工具调用'],
    knowledgeBaseIds: ['kb-prd', 'kb-design'],
    enabledToolIds: ['tool-search', 'tool-document-extract']
  },
  {
    id: 'assistant-builder',
    name: '开发助手',
    description: '偏向代码生成、技术决策和任务拆解。',
    providerId: 'provider-anthropic',
    model: 'claude-sonnet-4',
    systemPrompt: '你是一个偏工程实现的 AI 助手，回答时优先明确方案、边界和可落地代码方向。',
    contextLimit: 8,
    capabilities: ['聊天', '代码', '文件'],
    knowledgeBaseIds: ['kb-prd'],
    enabledToolIds: ['tool-filesystem', 'tool-file-write', 'tool-file-edit']
  },
  {
    id: 'assistant-research',
    name: '研究助手',
    description: '适合资料检索、竞品调研和多来源信息归纳。',
    providerId: 'provider-openai-compatible',
    model: 'gpt-4.1-mini',
    systemPrompt: '你是一个研究型 AI 助手，回答时先界定问题，再给出来源线索、关键发现和待验证假设。',
    contextLimit: 10,
    capabilities: ['聊天', '检索', '知识库'],
    knowledgeBaseIds: ['kb-prd'],
    enabledToolIds: ['tool-search']
  },
  {
    id: 'assistant-writing',
    name: '写作助手',
    description: '适合润色文案、生成长短内容和统一表达风格。',
    providerId: 'provider-anthropic',
    model: 'claude-haiku-3.5',
    systemPrompt: '你是一个写作与编辑助手，输出要清晰、有节奏，并根据目标读者调整语气。',
    contextLimit: 8,
    capabilities: ['聊天', '写作', '改写'],
    knowledgeBaseIds: ['kb-design'],
    enabledToolIds: []
  },
  {
    id: 'assistant-data',
    name: '数据分析助手',
    description: '适合拆解指标、解释数据变化和产出分析结论。',
    providerId: 'provider-openai-compatible',
    model: 'gpt-4.1',
    systemPrompt: '你是一个数据分析助手，回答时优先说明口径、指标关系、异常点和下一步验证方式。',
    contextLimit: 10,
    capabilities: ['聊天', '分析', '报告'],
    knowledgeBaseIds: ['kb-prd'],
    enabledToolIds: ['tool-filesystem', 'tool-document-extract']
  },
  {
    id: 'assistant-meeting',
    name: '会议纪要助手',
    description: '适合整理会议记录、提炼决策和生成行动项。',
    providerId: 'provider-ollama',
    model: 'qwen3:8b',
    systemPrompt: '你是一个会议纪要助手，输出应包含议题、结论、待办、负责人和风险提醒。',
    contextLimit: 12,
    capabilities: ['聊天', '总结', 'TODO'],
    knowledgeBaseIds: [],
    enabledToolIds: ['tool-automation', 'tool-document-extract']
  },
  {
    id: 'assistant-todo',
    name: 'TODO助手',
    description: '在工作台中拆分、整理任务，并添加到系统 TODO。',
    providerId: 'provider-openai-compatible',
    model: 'gpt-4.1-mini',
    systemPrompt:
      '你是 Emphant Studio 的 TODO 助手。你的核心职责是根据用户输入详细分析任务信息，把每次调用拆成一组适合 AI 执行的系统 TODO，并自动生成简洁任务组名。每个任务需要包含任务组、任务标题、执行说明、建议时间和完成标准。不要只输出泛泛建议，应优先形成可直接写入 TODO 的结构化行动项。',
    contextLimit: 10,
    capabilities: ['TODO 拆分', '任务整理', '任务入库'],
    knowledgeBaseIds: ['kb-prd'],
    enabledToolIds: ['tool-automation']
  },
  {
    id: 'assistant-automation',
    name: '自动化助手',
    description: '适合把复杂目标拆成流程、检查清单和可执行任务。',
    providerId: 'provider-openai-compatible',
    model: 'gpt-4.1-mini',
    systemPrompt: '你是一个自动化与任务编排助手，回答时把目标拆成步骤、依赖、触发条件和完成标准。',
    contextLimit: 10,
    capabilities: ['聊天', '任务编排', '工具调用'],
    knowledgeBaseIds: ['kb-prd'],
    enabledToolIds: ['tool-automation', 'tool-filesystem']
  },
  {
    id: 'assistant-system-operator',
    name: '系统操作助手',
    description: '适合执行工作区内命令、检查项目状态和辅助桌面自动化操作。',
    providerId: 'provider-openai-compatible',
    model: 'gpt-4.1-mini',
    systemPrompt:
      '你是一个系统操作助手。执行命令前先判断风险，只执行工作区内的低风险命令；涉及删除、sudo、系统目录、安装依赖、提交或推送代码等中高风险操作时，必须先说明影响并要求用户确认。命令结果要总结退出码、关键输出和下一步建议。',
    contextLimit: 10,
    capabilities: ['聊天', '命令执行', '文件', '系统操作'],
    knowledgeBaseIds: ['kb-prd'],
    enabledToolIds: [
      'tool-shell-command',
      'tool-filesystem',
      'tool-file-write',
      'tool-file-edit',
      'tool-system-automation'
    ]
  }
]

const initialSkills: Skill[] = [
  {
    id: 'skill-research',
    name: '资料调研',
    description: '围绕主题整理背景、竞品、关键结论和待验证问题。',
    kind: 'prompt',
    instructions: '先界定调研范围，再整理来源线索、关键发现、竞品差异和待验证假设。',
    tags: ['检索', '归纳', '竞品'],
    enabled: true,
    version: '1.0.0',
    source: 'builtin',
    requiredToolIds: ['tool-search'],
    permissions: ['network.fetch'],
    triggers: ['调研', '竞品', '查资料', '研究']
  },
  {
    id: 'skill-writing',
    name: '内容写作',
    description: '生成、润色、压缩和改写面向不同读者的内容。',
    kind: 'prompt',
    instructions: '先确认目标读者与表达目的，再调整结构、语气、长度和信息密度。',
    tags: ['写作', '润色', '风格'],
    enabled: true
  },
  {
    id: 'skill-coding',
    name: '代码实现',
    description: '拆解工程任务、解释技术方案并辅助生成实现代码。',
    kind: 'prompt',
    instructions: '明确技术边界和依赖，优先给出可验证、可维护的实现，并说明测试方式。',
    tags: ['代码', '架构', '调试'],
    enabled: true
  },
  {
    id: 'skill-analysis',
    name: '数据分析',
    description: '梳理指标口径、解释变化原因并产出分析报告骨架。',
    kind: 'prompt',
    instructions: '先校准指标口径，再区分事实、推断与待验证因素，最后给出下一步分析动作。',
    tags: ['指标', '分析', '报告'],
    enabled: true
  },
  {
    id: 'skill-meeting',
    name: '会议纪要',
    description: '把会议记录整理成议题、结论、行动项和风险提醒。',
    kind: 'prompt',
    instructions: '按议题、结论、行动项、负责人和风险组织内容，不补写会议中没有的信息。',
    tags: ['总结', 'TODO', '协作'],
    enabled: true,
    version: '1.1.0',
    source: 'builtin',
    requiredToolIds: ['tool-document-extract', 'tool-automation'],
    permissions: ['workspace.read', 'task.write'],
    triggers: ['会议纪要', '行动项', '会议记录']
  },
  {
    id: 'skill-orchestration',
    name: '任务编排',
    description: '把复杂目标拆成步骤、依赖、触发条件和完成标准。',
    kind: 'prompt',
    instructions: '把目标拆成可执行步骤，标明依赖、触发条件、负责人建议与完成标准。',
    tags: ['流程', '清单', '自动化'],
    enabled: true
  },
  {
    id: 'skill-todo-assistant',
    name: 'TODO 拆分入库',
    description: '把工作台目标拆成同一任务组下的系统 TODO。',
    kind: 'prompt',
    instructions:
      '将用户目标拆成 2-6 个适合 AI 执行的任务，自动生成本次调用的任务组名；每个任务包含标题、说明、建议执行时间或触发条件，并写入系统 TODO。',
    tags: ['TODO', '任务拆分', '计划'],
    enabled: true,
    version: '1.0.0',
    source: 'builtin',
    requiredToolIds: ['tool-automation'],
    permissions: ['task.write'],
    triggers: ['拆分任务', '加入TODO', '整理TODO', '待办']
  },
  {
    id: 'skill-command',
    name: '系统命令',
    description: '在当前工作区内执行低风险终端命令并汇总输出结果。',
    kind: 'prompt',
    instructions: '执行前判断风险，限制在当前工作区；清楚汇总退出码、关键输出和下一步建议。',
    tags: ['命令', '终端', '工作区'],
    enabled: true
  },
  {
    id: 'skill-desktop',
    name: '系统操作',
    description: '处理应用、剪贴板、截图和通知等桌面自动化任务。',
    kind: 'prompt',
    instructions: '桌面操作必须遵守权限边界，在产生外部影响前明确说明目标与影响。',
    tags: ['桌面', '自动化', '权限'],
    enabled: false
  },
  {
    id: 'skill-daily-plan',
    name: '每日计划',
    description: '把目标、日历和待办整理为可执行的今日计划。',
    kind: 'prompt',
    instructions:
      '先收集今日固定日程、待办、截止时间和可用精力，再按必须完成、推进事项和可选事项排序；明确时间块、缓冲时间和完成标准。',
    tags: ['效率', '计划', '任务'],
    enabled: true,
    version: '1.0.0',
    source: 'anthropics/knowledge-work-plugins:productivity-inspired',
    requiredToolIds: ['tool-automation'],
    permissions: ['task.read', 'calendar.read'],
    triggers: ['安排今天', '每日计划', '今天做什么']
  },
  {
    id: 'skill-weekly-review',
    name: '每周回顾',
    description: '汇总完成项、阻塞、经验和下周重点。',
    kind: 'prompt',
    instructions:
      '按本周完成、未完成与原因、重要决策、风险、经验和下周三项重点组织回顾；事实不足时列出待补信息，不猜测。',
    tags: ['回顾', '周报', '复盘'],
    enabled: true,
    version: '1.0.0',
    source: 'anthropics/knowledge-work-plugins:productivity-inspired',
    requiredToolIds: ['tool-automation'],
    permissions: ['task.read', 'calendar.read'],
    triggers: ['每周回顾', '周报', '本周复盘']
  },
  {
    id: 'skill-meeting-prep',
    name: '会前准备',
    description: '根据议程和背景资料生成会议目标、问题清单与决策点。',
    kind: 'prompt',
    instructions:
      '先明确会议目标、参会人和已知背景，再输出议程建议、需要确认的事实、关键问题、预期决策和会后动作模板。',
    tags: ['会议', '准备', '议程'],
    enabled: true,
    version: '1.0.0',
    source: 'builtin',
    requiredToolIds: ['tool-document-extract'],
    permissions: ['workspace.read', 'calendar.read', 'mail.read'],
    triggers: ['会前准备', '准备会议', '会议议程']
  },
  {
    id: 'skill-inbox-triage',
    name: '收件箱整理',
    description: '对邮件分类、摘要、提取任务并草拟回复。',
    kind: 'prompt',
    instructions:
      '将邮件分为立即处理、等待他人、仅供知悉和可归档；提取截止时间与行动项。默认只生成回复草稿，未经明确批准不得发送或删除邮件。',
    tags: ['邮件', '收件箱', '回复'],
    enabled: true,
    version: '1.0.0',
    source: 'anthropics/knowledge-work-plugins:productivity-inspired',
    permissions: ['mail.read', 'mail.draft'],
    triggers: ['整理邮箱', '邮件摘要', '草拟回复']
  },
  {
    id: 'skill-office-document',
    name: 'Office 文档助手',
    description: '提取和分析 PDF、Word、PowerPoint 与 Excel 内容。',
    kind: 'prompt',
    instructions:
      '优先使用文档提取工具读取正文，保留标题、列表、表格和来源位置；区分原文事实与推断，再按用户要求总结、改写或生成交付物。',
    tags: ['PDF', 'Word', 'PPT', 'Excel'],
    enabled: true,
    version: '1.0.0',
    source: 'microsoft/markitdown',
    requiredToolIds: ['tool-document-extract'],
    permissions: ['workspace.read'],
    triggers: ['分析文档', '读取PDF', '总结PPT', '分析Excel']
  },
  {
    id: 'skill-personal-knowledge',
    name: '个人知识整理',
    description: '把聊天、网页和文件整理为可检索的结构化笔记。',
    kind: 'prompt',
    instructions:
      '提炼主题、关键结论、证据、关联概念、待办和标签；避免重复保存，明确来源与更新时间，并提出适合写入知识库的标题。',
    tags: ['知识库', '笔记', '整理'],
    enabled: true,
    version: '1.0.0',
    source: 'builtin',
    requiredToolIds: ['tool-document-extract'],
    permissions: ['workspace.read', 'knowledge.write'],
    triggers: ['整理知识', '沉淀笔记', '加入知识库']
  }
]

const defaultAssistantSkillIds: Record<string, string[]> = {
  'assistant-research': ['skill-research', 'skill-personal-knowledge'],
  'assistant-writing': ['skill-writing', 'skill-office-document'],
  'assistant-builder': ['skill-coding'],
  'assistant-data': ['skill-analysis'],
  'assistant-meeting': ['skill-meeting', 'skill-meeting-prep'],
  'assistant-automation': [
    'skill-orchestration',
    'skill-daily-plan',
    'skill-weekly-review'
  ],
  'assistant-todo': ['skill-todo-assistant'],
  'assistant-system-operator': ['skill-command', 'skill-desktop'],
  'assistant-mail': ['skill-inbox-triage']
}

const initialTopics: Topic[] = [
  {
    id: 'topic-roadmap',
    title: '产品路线梳理',
    updatedAt: now()
  },
  {
    id: 'topic-shell',
    title: '桌面工作台骨架',
    updatedAt: now()
  },
  {
    id: 'topic-research',
    title: '行业资料调研',
    updatedAt: now()
  },
  {
    id: 'topic-writing',
    title: '内容草稿润色',
    updatedAt: now()
  },
  {
    id: 'topic-data',
    title: '指标变化分析',
    updatedAt: now()
  },
  {
    id: 'topic-meeting',
    title: '会议纪要整理',
    updatedAt: now()
  },
  {
    id: 'topic-automation',
    title: '任务流程编排',
    updatedAt: now()
  },
  {
    id: 'topic-system-operator',
    title: '系统命令执行',
    updatedAt: now()
  }
]

const initialMessages: Message[] = [
  makeMessage({
    id: 'message-roadmap-welcome',
    role: 'assistant',
    topicId: 'topic-roadmap',
    assistantName: '策略助手',
    blocks: [createTextBlock('欢迎来到 Emphant Studio。这里会逐步接入多模型、知识库、MCP 与文件工作流。')]
  }),
  makeMessage({
    id: 'message-shell-welcome',
    role: 'assistant',
    topicId: 'topic-shell',
    assistantName: '开发助手',
    blocks: [createTextBlock('当前版本先完成桌面壳层、聊天工作台和结构化消息主链路。')]
  }),
  makeMessage({
    id: 'message-research-welcome',
    role: 'assistant',
    topicId: 'topic-research',
    assistantName: '研究助手',
    blocks: [createTextBlock('把你要调研的问题、行业或竞品发给我，我会整理关键发现、证据线索和待验证假设。')]
  }),
  makeMessage({
    id: 'message-writing-welcome',
    role: 'assistant',
    topicId: 'topic-writing',
    assistantName: '写作助手',
    blocks: [createTextBlock('给我一段草稿或目标读者，我可以帮你改写、扩写、压缩或统一表达风格。')]
  }),
  makeMessage({
    id: 'message-data-welcome',
    role: 'assistant',
    topicId: 'topic-data',
    assistantName: '数据分析助手',
    blocks: [createTextBlock('提供指标、口径或原始结论，我会先校准分析框架，再输出变化原因和下一步验证建议。')]
  }),
  makeMessage({
    id: 'message-meeting-welcome',
    role: 'assistant',
    topicId: 'topic-meeting',
    assistantName: '会议纪要助手',
    blocks: [createTextBlock('粘贴会议记录后，我会整理议题、结论、待办、负责人和风险提醒。')]
  }),
  makeMessage({
    id: 'message-automation-welcome',
    role: 'assistant',
    topicId: 'topic-automation',
    assistantName: '自动化助手',
    blocks: [createTextBlock('告诉我一个目标或重复流程，我会拆成步骤、触发条件、依赖项和完成标准。')]
  }),
  makeMessage({
    id: 'message-system-operator-welcome',
    role: 'assistant',
    topicId: 'topic-system-operator',
    assistantName: '系统操作助手',
    blocks: [
      createTextBlock(
        '我可以在当前工作区内执行低风险命令。请用“执行：pwd”或反引号写明命令，例如 `git status --short`。高风险命令会被拦截或要求确认。'
      )
    ]
  })
]

const defaultOpenClawCore = {
  enabled: true,
  sandboxEnabled: false,
  maxDelegatedAgents: 3,
  auditLogEnabled: true,
  requireToolApproval: false
}

const initialSettings: WorkspaceSettings = {
  defaultProviderId: 'provider-openai-compatible',
  defaultModel: 'gpt-4.1',
  defaultWorkingDirectory: '',
  restoreWorkspaceOnLaunch: true,
  useMockResponsesWhenProviderFails: true,
  openClawCore: defaultOpenClawCore
}

const initialMailAgentSettings: MailAgentSettings = {
  enabled: true,
  checkIntervalMinutes: 5,
  accountEmail: ''
}

const initialMailNotifications: MailNotification[] = []

const initialState: WorkbenchState = {
  assistants: initialAssistants,
  skills: initialSkills,
  topics: initialTopics,
  messages: initialMessages,
  systemNotes: [],
  providers: initialProviders,
  knowledgeBases: initialKnowledgeBases,
  mcpTools: initialMcpTools,
  mcpServers: initialMcpServers,
  files: initialFiles,
  mailAgentSettings: initialMailAgentSettings,
  mailNotifications: initialMailNotifications,
  todoGroups: initialTodoGroups,
  todoItems: initialTodoItems,
  todoNotifications: initialTodoNotifications,
  activeTodoTaskId: null,
  settings: initialSettings,
  activeAssistantId: initialAssistants[0].id,
  activeTopicId: initialTopics[0].id,
  activeSystemNoteId: null
}

const cloneWorkbenchState = (state: WorkbenchState): WorkbenchState =>
  JSON.parse(JSON.stringify(state)) as WorkbenchState

const mergeById = <T extends { id: string }>(current: T[], presets: T[]) => {
  const currentIds = new Set(current.map((item) => item.id))
  const missingPresets = presets
    .filter((item) => !currentIds.has(item.id))
    .map((item) => JSON.parse(JSON.stringify(item)) as T)
  return [...current, ...missingPresets]
}

const matchesSkillIntent = (skill: Skill, prompt: string) => {
  const normalizedPrompt = prompt.toLowerCase()
  const signals = [
    skill.name,
    skill.description,
    ...skill.tags,
    ...(skill.triggers ?? [])
  ]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)

  return signals.some((signal) => normalizedPrompt.includes(signal))
}

const selectMountedSkillsForPrompt = (
  assistant: Assistant,
  skills: Skill[],
  prompt: string
) => {
  const mountedIds = new Set(assistant.enabledSkillIds ?? [])
  const mountedSkills = skills.filter((skill) => skill.enabled && mountedIds.has(skill.id))
  const matchedSkills = mountedSkills.filter((skill) => matchesSkillIntent(skill, prompt))

  if (matchedSkills.length > 0) {
    return matchedSkills.slice(0, 5)
  }

  return mountedSkills
    .filter((skill) => (skill.triggers?.length ?? 0) === 0)
    .slice(0, 3)
}

const normalizeTodoItem = (
  item: TodoItem & { priority?: string; businessCategory?: string }
): TodoItem => {
  const createdAt = item.createdAt ?? now()
  const status: TodoStatus =
    item.status === 'running'
      ? 'pending'
      : item.status === 'scheduled' ||
          item.status === 'completed' ||
          item.status === 'failed' ||
          item.status === 'pending'
        ? item.status
        : 'pending'

  return {
    id: item.id,
    title: item.title,
    description: item.description ?? '',
    taskGroup:
      item.taskGroup ||
      item.businessCategory ||
      (item.priority ? `原 ${item.priority}` : '默认任务组'),
    status,
    scheduledAt: item.scheduledAt,
    createdAt,
    updatedAt: item.updatedAt ?? createdAt,
    completedAt: item.completedAt,
    lastRunAt: item.lastRunAt,
    workspaceTopicId: item.workspaceTopicId,
    workspaceMessageId: item.workspaceMessageId,
    resultSummary: item.resultSummary,
    errorMessage: item.errorMessage,
    createdBy: item.createdBy ?? 'user'
  }
}

const mergePresetWorkbenchContent = (state: WorkbenchState): WorkbenchState => {
  const mergedState = cloneWorkbenchState(state)
  const hadFileWriteTools = mergedState.mcpTools?.some(
    (tool) => tool.id === 'tool-file-write' || tool.id === 'tool-file-edit'
  )
  mergedState.systemNotes = mergedState.systemNotes ?? []
  mergedState.activeSystemNoteId = mergedState.activeSystemNoteId ?? null
  mergedState.assistants = mergeById(mergedState.assistants, initialAssistants)
  mergedState.skills = mergeById(mergedState.skills ?? [], initialSkills)
  mergedState.skills = mergedState.skills.map((skill) => ({
    ...skill,
    kind: skill.kind ?? (skill.code ? 'code' : 'prompt'),
    version: skill.version ?? '1.0.0',
    source: skill.source ?? 'user',
    requiredToolIds: skill.requiredToolIds ?? [],
    permissions: skill.permissions ?? [],
    triggers: skill.triggers ?? []
  }))
  mergedState.assistants.forEach((assistant) => {
    const legacySkillIds = mergedState.skills
      .filter((skill) => skill.assistantId === assistant.id)
      .map((skill) => skill.id)
    const defaultSkillIds =
      assistant.enabledSkillIds === undefined
        ? (defaultAssistantSkillIds[assistant.id] ?? [])
        : []
    assistant.enabledSkillIds = Array.from(
      new Set([...(assistant.enabledSkillIds ?? []), ...defaultSkillIds, ...legacySkillIds])
    )
  })
  const inboxSkill = mergedState.skills.find((skill) => skill.id === 'skill-inbox-triage')
  if (inboxSkill) {
    inboxSkill.enabled = true
    const mailAssistant = mergedState.assistants.find((assistant) => assistant.id === 'assistant-mail')
    if (mailAssistant && !(mailAssistant.enabledSkillIds ?? []).includes(inboxSkill.id)) {
      mailAssistant.enabledSkillIds = [...(mailAssistant.enabledSkillIds ?? []), inboxSkill.id]
    }
  }
  mergedState.assistants.sort((left, right) => {
    if (left.id === 'assistant-main') return -1
    if (right.id === 'assistant-main') return 1
    return 0
  })
  // Topics and messages are user-owned data. Re-merging presets here would resurrect
  // intentionally deleted sample tasks every time the persisted snapshot is hydrated.
  mergedState.topics = mergedState.topics ?? []
  mergedState.topics.forEach((topic) => {
    topic.titleMode =
      topic.titleMode ?? (/^新任务\s*\d*$/.test(topic.title) ? 'placeholder' : 'manual')
  })
  mergedState.messages = mergedState.messages ?? []
  mergedState.settings.defaultWorkingDirectory =
    mergedState.settings.defaultWorkingDirectory ?? ''
  mergedState.settings.openClawCore = {
    ...defaultOpenClawCore,
    ...(mergedState.settings.openClawCore ?? {})
  }
  mergedState.knowledgeBases = mergeById(mergedState.knowledgeBases, initialKnowledgeBases)
  mergedState.mcpTools = mergeById(mergedState.mcpTools, initialMcpTools)
  const documentAssistantIds = new Set([
    'assistant-main',
    'assistant-research',
    'assistant-writing',
    'assistant-data',
    'assistant-meeting'
  ])
  mergedState.assistants.forEach((assistant) => {
    if (documentAssistantIds.has(assistant.id)) {
      assistant.enabledToolIds = Array.from(
        new Set([...assistant.enabledToolIds, 'tool-document-extract'])
      )
    }
  })
  if (!hadFileWriteTools) {
    const defaultWriteAssistantIds = new Set([
      'assistant-main',
      'assistant-builder',
      'assistant-system-operator'
    ])
    mergedState.assistants.forEach((assistant) => {
      if (defaultWriteAssistantIds.has(assistant.id)) {
        assistant.enabledToolIds = Array.from(
          new Set([...assistant.enabledToolIds, 'tool-file-write', 'tool-file-edit'])
        )
      }
    })
  }
  mergedState.mcpServers = mergeById(mergedState.mcpServers ?? [], initialMcpServers)
  mergedState.files = mergeById(mergedState.files, initialFiles)
  mergedState.mailAgentSettings = {
    ...initialMailAgentSettings,
    ...(mergedState.mailAgentSettings ?? {})
  }
  mergedState.mailNotifications = (
    mergedState.mailNotifications ?? initialMailNotifications
  ).filter((mail) => Boolean(mail.accountAddress))
  mergedState.todoItems = (mergedState.todoItems ?? initialTodoItems).map(normalizeTodoItem)
  mergedState.todoGroups = Array.from(
    new Set([
      ...(mergedState.todoGroups ?? initialTodoGroups),
      ...mergedState.todoItems.map((item) => item.taskGroup)
    ].filter(Boolean))
  )
  mergedState.todoNotifications = mergedState.todoNotifications ?? initialTodoNotifications
  mergedState.activeTodoTaskId = mergedState.todoItems.some(
    (item) => item.id === mergedState.activeTodoTaskId && item.status === 'running'
  )
    ? mergedState.activeTodoTaskId
    : null

  if (!mergedState.activeAssistantId && mergedState.assistants[0]) {
    mergedState.activeAssistantId = mergedState.assistants[0].id
  }

  if (!mergedState.activeTopicId && mergedState.topics[0]) {
    mergedState.activeTopicId = mergedState.topics[0].id
  }

  if (
    mergedState.activeSystemNoteId &&
    !mergedState.systemNotes.some((note) => note.id === mergedState.activeSystemNoteId)
  ) {
    mergedState.activeSystemNoteId = mergedState.systemNotes[0]?.id ?? null
  }

  return mergedState
}

const createStreamingAssistantMessage = ({
  topicId,
  assistantName
}: {
  topicId: string
  assistantName: string
}) => {
  const block = createTextBlock('', undefined, undefined, 'streaming')
  const message = makeMessage({
    role: 'assistant',
    topicId,
    assistantName,
    blocks: [block]
  })

  return {
    message,
    blockId: block.id
  }
}

const chunkText = (text: string) => text.match(/[\s\S]{1,4}/g) ?? []

const applySkillsToAssistant = (
  assistant: Assistant,
  skills: Skill[],
  prompt: string
): Assistant => {
  const enabledSkills = selectMountedSkillsForPrompt(assistant, skills, prompt)
  if (enabledSkills.length === 0) {
    return assistant
  }

  return {
    ...assistant,
    systemPrompt: [
      assistant.systemPrompt,
      `\n\n根据当前任务选择使用的 Skills：\n${enabledSkills
        .map((skill) => {
          const codeHint =
            skill.kind === 'code'
              ? `\n  类型：代码型 Skill；运行时：${skill.code?.runtime ?? 'unknown'}；入口：${skill.code?.entrypoint ?? skill.code?.command ?? '未声明'}。当前版本仅将其作为受控能力说明，不直接执行本地代码。`
              : ''
          return `- ${skill.name}（${skill.kind === 'code' ? '代码型' : 'Prompt'}）：${skill.instructions}${codeHint}`
        })
        .join('\n')}`
    ]
      .join('')
      .trim()
  }
}

type ActiveAssistantRun = {
  topicId: string
  controller: AbortController
  backendStarted: boolean
}

const activeAssistantRuns = new Map<string, ActiveAssistantRun>()

const streamLocalText = async (
  text: string,
  onToken: (token: string) => void,
  signal?: AbortSignal
) => {
  for (const token of chunkText(text)) {
    if (signal?.aborted) {
      return
    }
    onToken(token)
    await new Promise((resolve) => setTimeout(resolve, 16))
  }
}

const serializeToolPayload = (value: unknown) => {
  if (typeof value === 'string') {
    return value
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const createFallbackTopicTitle = (prompt: string, answer: string) => {
  const normalize = (value: string) =>
    value
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[#>*_`[\]()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  const question = normalize(prompt)
    .replace(/^(请|帮我|麻烦|能否|可以|如何|怎么|怎样)/, '')
    .split(/[。！？!?；;\n]/)[0]
    .trim()
  const response = normalize(answer)
    .replace(/^(可以|好的|当然|已完成|已经)/, '')
    .split(/[。！？!?；;\n]/)[0]
    .trim()
  const source = question.length >= 4 ? question : response || question || '未命名任务'

  return Array.from(source).slice(0, 18).join('')
}

const cleanTodoPrompt = (prompt: string) =>
  prompt
    .replace(/^(请|帮我|麻烦)?(把|将)?/u, '')
    .replace(/(加入|添加|写入|生成|整理).*(TODO|待办|任务清单).*$/iu, '')
    .trim()

const shouldAnalyzeBeforeTodo = (prompt: string) =>
  /(我想|准备|计划|需要|希望|打算).{0,24}(做|建设|搭建|开发|设计|规划|落地)|智能问数|系统|平台|产品|方案|分哪些步骤|怎么做|如何做|路线图/u.test(
    prompt
  )

const buildTodoAnalysisPrompt = (prompt: string) =>
  [
    '用户希望最终生成系统 TODO，但这个目标需要先做需求分析和步骤规划。',
    '请先作为意图识别/分析 Agent 梳理需求，再给 TODO 助手可使用的拆分依据。',
    '',
    `用户原始需求：${prompt}`,
    '',
    '输出要求：',
    '1. 先说明目标、关键模块、依赖顺序和主要风险。',
    '2. 最后必须给出“建议 TODO：”小节。',
    '3. “建议 TODO：”下输出 3-6 条编号任务，每条使用“任务标题：执行说明”的格式。'
  ].join('\n')

const getLatestAssistantText = (state: WorkbenchState, topicId: string) =>
  state.messages
    .filter((message) => message.topicId === topicId && message.role === 'assistant')
    .at(-1)
    ?.blocks.filter((block) => block.type === 'text')
    .map((block) => block.content)
    .join('\n\n')
    .trim() ?? ''

const extractTodoSection = (text: string) => {
  const match = text.match(/建议\s*TODO[：:]\s*([\s\S]*)/u)
  return match?.[1]?.trim() || text
}

const normalizeTodoCandidate = (item: string) =>
  item
    .replace(/^\s*(?:[-*+]|[（(]?\d+[).、）]|\[[ xX]\])\s*/u, '')
    .replace(/[*_`#>]/g, '')
    .replace(/^任务标题[：:]/u, '')
    .trim()

const extractTodoCandidates = (prompt: string) => {
  const cleaned = cleanTodoPrompt(extractTodoSection(prompt))
  const lineCandidates = cleaned
    .split(/\n+/)
    .map(normalizeTodoCandidate)
    .filter((item) => item.length >= 4)
    .filter((item) => !/^(输出要求|用户原始需求|建议TODO|建议 TODO|目标|关键模块|依赖顺序|主要风险)[：:：]?/u.test(item))

  if (lineCandidates.length >= 2) {
    return lineCandidates
  }

  return cleaned
    .split(/\n+|[；;。]/)
    .map(normalizeTodoCandidate)
    .filter((item) => item.length >= 4)
}

const buildFallbackTodoPlan = (prompt: string) => {
  if (/智能问数|问数|BI|数据分析系统|数据问答/u.test(prompt)) {
    return [
      '建议 TODO：',
      '1. 明确智能问数业务场景：梳理目标用户、核心问题类型、数据范围、权限边界和成功指标。',
      '2. 设计数据接入与语义层：盘点数据源、指标口径、维度层级、数据字典和权限过滤规则。',
      '3. 规划问数 Agent 流程：定义意图识别、指标召回、SQL 生成、结果校验、图表推荐和追问澄清链路。',
      '4. 搭建原型与评测集：准备典型问法、标准 SQL、期望答案和失败样例，用于验证准确率。',
      '5. 实现工作台交互闭环：设计提问、澄清、图表展示、结果解释、收藏复用和人工反馈入口。',
      '6. 制定上线与运营计划：安排灰度发布、日志审计、质量监控、知识更新和权限合规检查。'
    ].join('\n')
  }

  return [
    '建议 TODO：',
    '1. 明确目标与验收标准：补充用户对象、业务边界、关键成功指标和不可做范围。',
    '2. 拆解核心模块与依赖：梳理功能模块、数据或系统依赖、优先级和先后顺序。',
    '3. 形成方案与原型：输出流程设计、交互草图、技术或执行方案，并标注关键风险。',
    '4. 制定实施计划：拆分里程碑、负责人建议、交付物和验证方式。',
    '5. 建立复盘与迭代机制：收集反馈、跟踪问题、更新任务清单并安排下一轮优化。'
  ].join('\n')
}

const inferTaskGroup = (prompt: string) => {
  const cleaned = cleanTodoPrompt(prompt)
  const firstMeaningfulLine =
    cleaned
      .split(/\n+|[；;。]/)
      .map((item) => item.replace(/^[-*、\d.\s]+/, '').trim())
      .find((item) => item.length >= 2) ||
    cleaned ||
    prompt
  const title = firstMeaningfulLine
    .replace(/[，,：:].*$/u, '')
    .replace(/^(关于|围绕|针对|处理|完成|执行|规划|拆分)/u, '')
    .trim()
  const shortTitle = Array.from(title || '默认').slice(0, 14).join('')
  return shortTitle.endsWith('任务组') ? shortTitle : `${shortTitle}任务组`
}

const splitPromptIntoTodoItems = (prompt: string): TodoItem[] => {
  const cleaned = cleanTodoPrompt(prompt)
  const parts = extractTodoCandidates(prompt)
  const candidates = parts.length > 0 ? parts : [cleaned || prompt]
  const taskGroup = inferTaskGroup(prompt)
  return candidates.slice(0, 6).map((item) => ({
    id: nanoid(),
    title: Array.from(item.split(/[，,：:]/)[0] || item).slice(0, 32).join(''),
    description: item,
    taskGroup,
    status: 'pending',
    createdAt: now(),
    updatedAt: now(),
    createdBy: 'todo-assistant'
  }))
}

const consumeAgentEvents = async ({
  request,
  messageId,
  blockId,
  dispatch,
  signal
}: {
  request: AgentRunRequest
  messageId: string
  blockId: string
  dispatch: AppDispatch
  signal: AbortSignal
}) => {
  const toolNames = new Map<string, string>()
  let receivedText = false
  let runtimeError = ''

  const handleEvent = (event: AgentRuntimeEvent) => {
    if (signal.aborted || event.runId !== request.runId) {
      return
    }

    if (event.type === 'text-delta') {
      receivedText = true
      dispatch(
        appendAssistantMessageBlockContent({
          messageId,
          blockId,
          content: event.delta
        })
      )
    } else if (event.type === 'reasoning-delta') {
      // Reasoning is intentionally not persisted verbatim. The runtime still exposes
      // the event so a future ephemeral inspector can render it without polluting chat history.
    } else if (event.type === 'tool-input') {
      toolNames.set(event.toolCallId, event.toolName)
    } else if (event.type === 'tool-output' && !event.preliminary) {
      dispatch(
        appendAssistantMessageBlock({
          messageId,
          block: {
            ...createTextBlock(
              serializeToolPayload(event.output),
              `工具调用：${toolNames.get(event.toolCallId) ?? 'Tool'}`,
              {
                toolCallId: event.toolCallId,
                toolName: toolNames.get(event.toolCallId) ?? 'Tool'
              }
            ),
            type: 'tool'
          }
        })
      )
    } else if (event.type === 'approval-request') {
      dispatch(
        appendAssistantMessageBlock({
          messageId,
          block: {
            ...createTextBlock(
              [
                event.evaluation.reason,
                '',
                '参数：',
                '```json',
                serializeToolPayload(event.input),
                '```'
              ].join('\n'),
              `等待授权：${event.toolName}`,
              {
                runId: event.runId,
                approvalId: event.approvalId,
                toolCallId: event.toolCallId,
                risk: event.evaluation.risk,
                approvalState: 'pending'
              }
            ),
            type: 'tool'
          }
        })
      )
    } else if (event.type === 'error') {
      runtimeError = event.message
    }
  }

  const unsubscribe = window.emphant.onAgentEvent(handleEvent)
  try {
    const result = await window.emphant.runAgent(request)
    return { ...result, receivedText, runtimeError }
  } finally {
    unsubscribe()
  }
}

const refreshMailNotifications = async (dispatch: AppDispatch) => {
  try {
    const result = await window.emphant.checkAllEmailAccounts()
    dispatch(applyMailCheckResult(result))
  } catch (error) {
    console.error('Failed to refresh mail notifications', error)
    dispatch(
      addMailCheckErrorNotification({
        message: error instanceof Error ? error.message : '邮件检查失败'
      })
    )
  }
}

export const sendAssistantReply = createAsyncThunk(
  'workbench/sendAssistantReply',
  async (
    {
      topicId,
      assistantId,
      prompt
    }: {
      topicId: string
      assistantId?: string
      prompt: string
    },
    thunkApi
  ) => {
    const dispatch = thunkApi.dispatch as AppDispatch
    const runId = nanoid()
    const controller = new AbortController()
    activeAssistantRuns.set(runId, { topicId, controller, backendStarted: false })
    if (controller.signal.aborted) {
      activeAssistantRuns.delete(runId)
      return
    }
    const state = (thunkApi.getState() as RootState).workbench
    const intentAssistant = state.assistants.find((item) => item.id === 'assistant-main')
    const baseAssistant =
      state.assistants.find((item) => item.id === assistantId) ?? intentAssistant
    const assistant = baseAssistant
      ? applySkillsToAssistant(baseAssistant, state.skills, prompt)
      : undefined
    const isIntentRouting = assistant?.id === 'assistant-main'
    const provider = state.providers.find(
      (item) => item.id === assistant?.providerId && item.enabled
    )
    const knowledgeBases = state.knowledgeBases.filter((base) =>
      assistant?.knowledgeBaseIds.includes(base.id)
    )
    const tools = state.mcpTools.filter(
      (tool) => tool.enabled && assistant?.enabledToolIds.includes(tool.id)
    )
    const history = state.messages.filter((message) => message.topicId === topicId)
    const unreadMailContext = buildUnreadMailContext(state.mailNotifications)
    const isMailAssistant = assistant?.id === 'assistant-mail'

    if (!assistant) {
      const { message, blockId } = createStreamingAssistantMessage({
        topicId,
        assistantName: '助手'
      })
      dispatch(startAssistantMessage(message))
      await streamLocalText(
        `未找到可用助手，已收到输入：“${prompt}”。`,
        (token) =>
          dispatch(
            appendAssistantMessageBlockContent({
              messageId: message.id,
              blockId,
              content: token
            })
          ),
        controller.signal
      )
      dispatch(finishAssistantMessageBlock({ messageId: message.id, blockId }))
      activeAssistantRuns.delete(runId)
      return
    }

    const matchedKnowledge = searchKnowledgeBases({
      prompt,
      bases: knowledgeBases,
      files: state.files
    })
    const candidateKnowledgeContexts = isIntentRouting
      ? Object.fromEntries(
          state.assistants
            .filter((candidate) => candidate.id !== assistant.id)
            .map((candidate) => {
              const candidateBases = state.knowledgeBases.filter((base) =>
                candidate.knowledgeBaseIds.includes(base.id)
              )
              const matches = searchKnowledgeBases({
                prompt,
                bases: candidateBases,
                files: state.files
              })

              const candidateMailContext =
                candidate.id === 'assistant-mail' ? unreadMailContext : ''
              return [
                candidate.id,
                [
                  matches
                    .map(
                      (item) =>
                        `[${item.base.name}・${item.file?.name ?? '知识库内容'}] ${item.excerpt}`
                        + (item.graphEvidence.length
                          ? `\n图谱线索：${item.graphEvidence.join('；')}`
                          : '')
                    )
                    .join('\n\n'),
                  candidateMailContext
                ].filter(Boolean).join('\n\n')
              ]
            })
            .filter(([, context]) => Boolean(context))
        )
      : undefined

    const { message, blockId } = createStreamingAssistantMessage({
      topicId,
      assistantName: assistant.name
    })
    dispatch(startAssistantMessage(message))

    let agentResult: Awaited<ReturnType<typeof consumeAgentEvents>> | null = null
    let providerError = ''

    if (provider) {
      try {
        const activeRun = activeAssistantRuns.get(runId)
        if (activeRun) {
          activeRun.backendStarted = true
        }
        agentResult = await consumeAgentEvents({
          request: {
            runId,
            topicId,
            assistant,
            routingMode: isIntentRouting ? 'main' : 'direct',
            candidateAssistants: isIntentRouting
              ? state.assistants.map((candidate) =>
                  applySkillsToAssistant(candidate, state.skills, prompt)
                )
              : undefined,
            availableProviders: isIntentRouting ? state.providers : undefined,
            provider,
            history,
            prompt,
            workspaceDirectory:
              state.topics.find((topic) => topic.id === topicId)?.workspaceDirectory || undefined,
            knowledgeContext:
              [
                matchedKnowledge
                  .map(
                    (item) =>
                      `[${item.base.name}・${item.file?.name ?? '知识库内容'}] ${item.excerpt}`
                      + (item.graphEvidence.length
                        ? `\n图谱线索：${item.graphEvidence.join('；')}`
                        : '')
                  )
                  .join('\n\n'),
                isMailAssistant ? unreadMailContext : ''
              ].filter(Boolean).join('\n\n') || undefined,
            candidateKnowledgeContexts,
            enabledTools: tools,
            mcpServers: state.mcpServers,
            openClawCore: state.settings.openClawCore
          },
          messageId: message.id,
          blockId,
          dispatch,
          signal: controller.signal
        })
        providerError = agentResult.runtimeError
      } catch (error) {
        providerError = error instanceof Error ? error.message : 'Agent Runtime 调用失败'
      }
    } else {
      providerError = '未找到 Provider 配置'
    }

    if (controller.signal.aborted || agentResult?.status === 'cancelled') {
      dispatch(finishAssistantMessageBlock({ messageId: message.id, blockId }))
      activeAssistantRuns.delete(runId)
      return
    }

    if (
      !agentResult?.receivedText &&
      agentResult?.status !== 'awaiting-approval' &&
      (!providerError || state.settings.useMockResponsesWhenProviderFails)
    ) {
      const mockBlocks = composeAssistantBlocks({
        prompt,
        assistant,
        provider,
        knowledgeBases,
        tools,
        files: state.files
      })
      const [mainBlock, ...extraBlocks] = mockBlocks

      if (mainBlock) {
        await streamLocalText(
          mainBlock.content,
          (token) =>
            dispatch(
              appendAssistantMessageBlockContent({
                messageId: message.id,
                blockId,
                content: token
              })
            ),
          controller.signal
        )
      }

      if (!controller.signal.aborted) {
        extraBlocks.forEach((block) =>
          dispatch(appendAssistantMessageBlock({ messageId: message.id, block }))
        )
      }
    } else if (!agentResult?.receivedText && providerError) {
      await streamLocalText(
        'Agent Runtime 调用失败，且当前已关闭本地模拟回复。',
        (token) =>
          dispatch(
            appendAssistantMessageBlockContent({
              messageId: message.id,
              blockId,
              content: token
            })
          ),
        controller.signal
      )
    }

    dispatch(finishAssistantMessageBlock({ messageId: message.id, blockId }))

    if (controller.signal.aborted) {
      activeAssistantRuns.delete(runId)
      return
    }

    if (isMailAssistant && agentResult?.status !== 'awaiting-approval') {
      await refreshMailNotifications(dispatch)
    }

    matchedKnowledge.forEach((item) => {
      const sourceFileName = item.file?.name ?? '知识库内容'

      dispatch(
        appendAssistantMessageBlock({
          messageId: message.id,
          block: {
            ...createTextBlock(item.excerpt, `引用：${item.base.name}・${sourceFileName}`, {
              chunks: String(item.base.chunkCount),
              status: item.base.status,
              chunkTokens: String(item.chunk.tokenCount),
              knowledgeBaseName: item.base.name,
              fileName: sourceFileName
            }),
            type: 'reference'
          }
        })
      )
    })

    if (providerError) {
      dispatch(
        appendAssistantMessageBlock({
          messageId: message.id,
          block: {
            id: nanoid(),
            type: 'error',
            title: 'Provider 状态',
            content: `${providerError}${state.settings.useMockResponsesWhenProviderFails ? '，已回退到本地模拟回复。' : ''}`,
            status: 'done'
          }
        })
      )
    }

    const latestState = (thunkApi.getState() as RootState).workbench
    const topic = latestState.topics.find((item) => item.id === topicId)
    const completedMessage = latestState.messages.find((item) => item.id === message.id)
    const answer = completedMessage?.blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.content)
      .join('\n\n')
      .trim()

    if (topic?.titleMode === 'placeholder' && answer) {
      let generatedTitle = ''
      if (provider) {
        try {
          generatedTitle = await window.emphant.generateTopicTitle({
            provider,
            model: assistant.model,
            prompt,
            answer
          })
        } catch {
          // A deterministic fallback still keeps task naming functional when the
          // provider cannot afford or complete the secondary title request.
        }
      }

      dispatch(
        applyGeneratedTopicTitle({
          topicId,
          title: generatedTitle || createFallbackTopicTitle(prompt, answer)
        })
      )
    }

    activeAssistantRuns.delete(runId)
  }
)

export const createTodoItemsFromWorkbench = createAsyncThunk(
  'workbench/createTodoItemsFromWorkbench',
  async (
    {
      topicId,
      prompt,
      analyzeFirst = shouldAnalyzeBeforeTodo(prompt)
    }: {
      topicId: string
      prompt: string
      analyzeFirst?: boolean
    },
    thunkApi
  ) => {
    const dispatch = thunkApi.dispatch as AppDispatch
    let sourcePrompt = prompt

    if (analyzeFirst) {
      const state = (thunkApi.getState() as RootState).workbench
      const analysisAssistantId = state.assistants.some((assistant) => assistant.id === 'assistant-main')
        ? 'assistant-main'
        : state.assistants.find((assistant) => assistant.id === 'assistant-strategy')?.id

      if (analysisAssistantId) {
        await dispatch(
          sendAssistantReply({
            topicId,
            assistantId: analysisAssistantId,
            prompt: buildTodoAnalysisPrompt(prompt)
          })
        ).unwrap()

        const latestState = (thunkApi.getState() as RootState).workbench
        const analysis = getLatestAssistantText(latestState, topicId)
        if (analysis) {
          const todoPlan =
            extractTodoCandidates(analysis).length >= 2
              ? analysis
              : [analysis, '', buildFallbackTodoPlan(prompt)].join('\n')
          sourcePrompt = [
            prompt,
            '',
            '意图识别/分析 Agent 的规划结论：',
            todoPlan
          ].join('\n')
        } else {
          sourcePrompt = [prompt, '', buildFallbackTodoPlan(prompt)].join('\n')
        }
      } else {
        sourcePrompt = [prompt, '', buildFallbackTodoPlan(prompt)].join('\n')
      }
    }

    const items = splitPromptIntoTodoItems(sourcePrompt)
    dispatch(addTodoItems(items))
    dispatch(
      addTodoAssistantSummary({
        topicId,
        items,
        sourcePrompt,
        analysisApplied: analyzeFirst
      })
    )
  }
)

export const runTodoTask = createAsyncThunk(
  'workbench/runTodoTask',
  async (todoId: string, thunkApi) => {
    const dispatch = thunkApi.dispatch as AppDispatch
    const state = (thunkApi.getState() as RootState).workbench
    const todo = state.todoItems.find((item) => item.id === todoId)
    if (!todo) {
      throw new Error('未找到 TODO 任务。')
    }
    if (state.activeTodoTaskId && state.activeTodoTaskId !== todoId) {
      throw new Error('工作台当前已有 TODO 任务正在执行，请等待完成后再启动。')
    }

    const topicId = todo.workspaceTopicId ?? nanoid()
    const assistantId = state.assistants.some((assistant) => assistant.id === 'assistant-main')
      ? 'assistant-main'
      : state.assistants[0]?.id
    if (!assistantId) {
      throw new Error('没有可用 Agent 执行 TODO。')
    }

    const prompt = [
      `请执行这个系统 TODO：${todo.title}`,
      `任务组：${todo.taskGroup}`,
      todo.description ? `任务说明：${todo.description}` : '',
      '执行完成后，请总结已完成内容、产出结果和后续建议。'
    ].filter(Boolean).join('\n')

    dispatch(
      startTodoExecution({
        todoId,
        topicId,
        assistantId
      })
    )
    dispatch(sendUserMessage({ topicId, content: prompt }))
    try {
      await dispatch(
        sendAssistantReply({
          topicId,
          assistantId,
          prompt
        })
      ).unwrap()
      const latestState = (thunkApi.getState() as RootState).workbench
      const topicMessages = latestState.messages.filter(
        (message) => message.topicId === topicId && message.role === 'assistant'
      )
      const latestAssistantMessage = topicMessages.at(-1)
      const resultSummary =
        latestAssistantMessage?.blocks
          .filter((block) => block.type === 'text')
          .map((block) => block.content)
          .join('\n\n')
          .trim()
          .slice(0, 280) || '工作台任务已执行完成。'
      dispatch(
        completeTodoExecution({
          todoId,
          topicId,
          messageId: latestAssistantMessage?.id,
          resultSummary
        })
      )
    } catch (error) {
      dispatch(
        failTodoExecution({
          todoId,
          errorMessage: error instanceof Error ? error.message : 'TODO 执行失败'
        })
      )
      throw error
    }
  }
)

export const stopAssistantReplies = createAsyncThunk(
  'workbench/stopAssistantReplies',
  async (topicId: string, thunkApi) => {
    const dispatch = thunkApi.dispatch as AppDispatch
    const runs = [...activeAssistantRuns.entries()].filter(
      ([, activeRun]) => activeRun.topicId === topicId
    )

    runs.forEach(([, activeRun]) => activeRun.controller.abort())
    dispatch(finishStreamingAssistantMessages({ topicId }))
    await Promise.allSettled(
      runs
        .filter(([, activeRun]) => activeRun.backendStarted)
        .map(([runId]) => window.emphant.cancelAgent(runId))
    )
    runs.forEach(([runId]) => activeAssistantRuns.delete(runId))
  }
)

export const respondToAgentApproval = createAsyncThunk(
  'workbench/respondToAgentApproval',
  async (
    {
      messageId,
      approvalBlockId,
      runId,
      approvalId,
      approved
    }: {
      messageId: string
      approvalBlockId: string
      runId: string
      approvalId: string
      approved: boolean
    },
    thunkApi
  ) => {
    const dispatch = thunkApi.dispatch as AppDispatch
    const state = (thunkApi.getState() as RootState).workbench
    const message = state.messages.find((item) => item.id === messageId)
    const textBlock = message?.blocks.find((block) => block.type === 'text')
    const toolNames = new Map<string, string>()

    dispatch(
      resolveAgentApprovalBlock({
        messageId,
        blockId: approvalBlockId,
        approved
      })
    )

    const unsubscribe = window.emphant.onAgentEvent((event) => {
      if (event.runId !== runId) {
        return
      }

      if (event.type === 'text-delta' && textBlock) {
        dispatch(
          appendAssistantMessageBlockContent({
            messageId,
            blockId: textBlock.id,
            content: event.delta
          })
        )
      } else if (event.type === 'tool-input') {
        toolNames.set(event.toolCallId, event.toolName)
      } else if (event.type === 'tool-output' && !event.preliminary) {
        dispatch(
          appendAssistantMessageBlock({
            messageId,
            block: {
              ...createTextBlock(
                serializeToolPayload(event.output),
                `工具调用：${toolNames.get(event.toolCallId) ?? 'Tool'}`,
                {
                  toolCallId: event.toolCallId,
                  toolName: toolNames.get(event.toolCallId) ?? 'Tool'
                }
              ),
              type: 'tool'
            }
          })
        )
      } else if (event.type === 'error') {
        dispatch(
          appendAssistantMessageBlock({
            messageId,
            block: {
              id: nanoid(),
              type: 'error',
              title: 'Agent Runtime',
              content: event.message,
              status: 'done'
            }
          })
        )
      }
    })

    try {
      await window.emphant.approveAgent({
        runId,
        approvalId,
        approved,
        reason: approved ? '用户在 Emphant Studio 中批准执行。' : '用户拒绝执行。'
      })
    } finally {
      unsubscribe()
    }
  }
)

const workbenchSlice = createSlice({
  name: 'workbench',
  initialState,
  reducers: {
    hydrateWorkbench(_state, action: PayloadAction<WorkbenchState>) {
      return mergePresetWorkbenchContent(action.payload)
    },
    hydrateWorkspacePreferences(
      state,
      action: PayloadAction<
        Pick<WorkbenchState, 'settings'> &
          Partial<Pick<WorkbenchState, 'providers' | 'mcpTools' | 'mcpServers'>>
      >
    ) {
      state.settings = {
        ...initialSettings,
        ...action.payload.settings,
        defaultWorkingDirectory: action.payload.settings.defaultWorkingDirectory ?? '',
        openClawCore: {
          ...defaultOpenClawCore,
          ...(action.payload.settings.openClawCore ?? {})
        }
      }
      if (action.payload.providers) {
        state.providers = action.payload.providers
      }
      if (action.payload.mcpTools) {
        state.mcpTools = action.payload.mcpTools
      }
      if (action.payload.mcpServers) {
        state.mcpServers = action.payload.mcpServers
      }
    },
    hydrateWorkspaceContent(
      state,
      action: PayloadAction<WorkspaceContentSnapshot>
    ) {
      const contentFileIds = new Set(
        action.payload.knowledgeBases.flatMap((base) => base.sourceFileIds)
      )
      state.systemNotes = action.payload.systemNotes
      state.knowledgeBases = action.payload.knowledgeBases
      if (action.payload.todoGroups) {
        state.todoGroups = action.payload.todoGroups
      }
      if (action.payload.todoItems) {
        state.todoItems = action.payload.todoItems.map(normalizeTodoItem)
        state.todoGroups = Array.from(
          new Set([
            ...state.todoGroups,
            ...state.todoItems.map((item) => item.taskGroup)
          ].filter(Boolean))
        )
      }
      state.files = [
        ...action.payload.files,
        ...state.files.filter((file) => !contentFileIds.has(file.id))
      ]
      if (
        state.activeSystemNoteId &&
        !state.systemNotes.some((note) => note.id === state.activeSystemNoteId)
      ) {
        state.activeSystemNoteId = state.systemNotes[0]?.id ?? null
      }
    },
    resetWorkbench() {
      return cloneWorkbenchState(initialState)
    },
    setActiveAssistant(state, action: PayloadAction<string>) {
      state.activeAssistantId = action.payload
    },
    setActiveTopic(state, action: PayloadAction<string>) {
      state.activeTopicId = action.payload
    },
    createTopic(state) {
      const topic: Topic = {
        id: nanoid(),
        title: `新任务 ${state.topics.length + 1}`,
        updatedAt: now(),
        titleMode: 'placeholder'
      }
      state.topics.unshift(topic)
      state.activeTopicId = topic.id
    },
    updateMailAgentSettings(
      state,
      action: PayloadAction<Partial<MailAgentSettings>>
    ) {
      state.mailAgentSettings = {
        ...state.mailAgentSettings,
        ...action.payload
      }
    },
    applyMailCheckResult(state, action: PayloadAction<MailCheckResult>) {
      state.mailAgentSettings.lastCheckedAt = action.payload.checkedAt
      state.mailAgentSettings.checkedAccountAddresses = action.payload.checkedAccounts
      state.mailAgentSettings.checkErrors = action.payload.errors
      action.payload.errors.forEach((error) =>
        upsertMailCheckErrorNotification(state, error, action.payload.checkedAt)
      )

      const existingById = new Map(
        state.mailNotifications.map((mail) => [mail.id, mail])
      )
      const checkedAccounts = new Set(
        action.payload.checkedAccounts.map((account) => account.toLowerCase())
      )
      const syncedMailIds = new Set(action.payload.messages.map((mail) => mail.id))
      action.payload.messages.forEach((mail) => {
        const existing = existingById.get(mail.id)
        if (existing) {
          Object.assign(existing, {
            ...mail,
            unread: existing.unread && mail.unread,
            processed: existing.processed,
            taskTopicId: existing.taskTopicId
          })
        } else {
          state.mailNotifications.unshift(mail)
        }
      })
      state.mailNotifications.forEach((mail) => {
        if (
          checkedAccounts.has(mail.accountAddress.toLowerCase()) &&
          !syncedMailIds.has(mail.id)
        ) {
          mail.unread = false
        }
      })
      state.mailNotifications.sort((left, right) =>
        right.receivedAt.localeCompare(left.receivedAt)
      )
    },
    addMailCheckErrorNotification(
      state,
      action: PayloadAction<{ accountAddress?: string; message: string }>
    ) {
      upsertMailCheckErrorNotification(state, action.payload)
    },
    createMailTask(state, action: PayloadAction<string>) {
      const mail = state.mailNotifications.find((item) => item.id === action.payload)
      if (!mail) return

      mail.unread = false
      if (mail.taskTopicId) {
        state.activeTopicId = mail.taskTopicId
        return
      }

      const topicId = nanoid()
      const topic: Topic = {
        id: topicId,
        title: `处理邮件：${mail.subject}`,
        updatedAt: now(),
        titleMode: 'generated',
        assistantIds: ['assistant-mail'],
        sourceMailId: mail.id
      }
      state.topics.unshift(topic)
      state.messages.push(
        makeMessage({
          role: 'assistant',
          topicId,
          assistantName: '邮件助手',
          blocks: [
            createTextBlock(
              [
                `**发件人：** ${mail.sender} <${mail.senderEmail}>`,
                `**邮箱类型：** ${
                  mail.accountType === 'work'
                    ? '公司邮件'
                    : mail.accountType === 'personal'
                      ? '个人邮件'
                      : '其他邮件'
                }（${mail.accountAddress}）`,
                `**主题：** ${mail.subject}`,
                `**接收时间：** ${new Date(mail.receivedAt).toLocaleString()}`,
                '',
                mail.preview,
                '',
                '请直接回复你的处理意见，例如“回复对方周四下午三点可以，并归档原邮件”。我会自动处理这封邮件。'
              ].join('\n')
            )
          ]
        })
      )
      mail.taskTopicId = topicId
      state.activeTopicId = topicId
    },
    processMailTask(
      state,
      action: PayloadAction<{ topicId: string; instruction: string }>
    ) {
      const topic = state.topics.find((item) => item.id === action.payload.topicId)
      const mail = state.mailNotifications.find((item) => item.id === topic?.sourceMailId)
      if (!topic || !mail) return

      mail.unread = false
      mail.processed = true
      topic.updatedAt = now()
      topic.sourceMailId = undefined
      state.messages.push(
        makeMessage({
          role: 'assistant',
          topicId: topic.id,
          assistantName: '邮件助手',
          blocks: [
            createTextBlock(
              [
                `已处理来自 **${mail.sender}** 的邮件《${mail.subject}》。`,
                '',
                `处理意见：${action.payload.instruction}`,
                '',
                `回复已通过 ${mail.accountAddress} 发送，原邮件已标记为已处理。`
              ].join('\n')
            )
          ]
        })
      )
    },
    sendMailFromWorkbench(
      state,
      action: PayloadAction<{ topicId: string; recipient: string; instruction: string }>
    ) {
      const topic = state.topics.find((item) => item.id === action.payload.topicId)
      if (topic) {
        topic.updatedAt = now()
        if (topic.titleMode === 'placeholder') {
          topic.title = `发送邮件给 ${action.payload.recipient}`
          topic.titleMode = 'generated'
        }
      }
      state.messages.push(
        makeMessage({
          role: 'assistant',
          topicId: action.payload.topicId,
          assistantName: '邮件助手',
          blocks: [
            createTextBlock(
              [
                `邮件已发送至 **${action.payload.recipient}**。`,
                '',
                `发件邮箱：${state.mailAgentSettings.accountEmail || '默认邮箱'}`,
                `发送要求：${action.payload.instruction}`
              ].join('\n')
            )
          ]
        })
      )
    },
    addTodoItems(state, action: PayloadAction<TodoItem[]>) {
      const normalizedItems = action.payload.map((item) => ({
        ...item,
        taskGroup: item.taskGroup || item.businessCategory || '默认任务组',
        status: item.scheduledAt ? 'scheduled' : item.status,
        createdAt: item.createdAt || now(),
        updatedAt: now()
      }))
      state.todoItems.unshift(
        ...normalizedItems
      )
      state.todoGroups = Array.from(
        new Set([...state.todoGroups, ...normalizedItems.map((item) => item.taskGroup)])
      )
    },
    createTodoGroup(state, action: PayloadAction<{ sourceText: string }>) {
      const taskGroup = inferTaskGroup(action.payload.sourceText)
      if (!state.todoGroups.includes(taskGroup)) {
        state.todoGroups.unshift(taskGroup)
      }
    },
    createTodoItem(
      state,
      action: PayloadAction<{
        title: string
        description?: string
        taskGroup?: string
        scheduledAt?: string
      }>
    ) {
      const scheduledAt = action.payload.scheduledAt || undefined
      const description = action.payload.description?.trim() ?? ''
      const taskGroup =
        action.payload.taskGroup?.trim() ||
        inferTaskGroup([action.payload.title, description].filter(Boolean).join('\n'))
      state.todoItems.unshift({
        id: nanoid(),
        title: action.payload.title.trim(),
        description,
        taskGroup,
        status: scheduledAt ? 'scheduled' : 'pending',
        scheduledAt,
        createdAt: now(),
        updatedAt: now(),
        createdBy: 'user'
      })
      if (!state.todoGroups.includes(taskGroup)) {
        state.todoGroups.unshift(taskGroup)
      }
    },
    updateTodoItem(
      state,
      action: PayloadAction<{
        todoId: string
        patch: Partial<Pick<TodoItem, 'title' | 'description' | 'taskGroup' | 'scheduledAt' | 'status'>>
      }>
    ) {
      const todo = state.todoItems.find((item) => item.id === action.payload.todoId)
      if (!todo || todo.status === 'running') {
        return
      }
      Object.assign(todo, action.payload.patch)
      if (action.payload.patch.scheduledAt !== undefined) {
        todo.status =
          action.payload.patch.scheduledAt && todo.status !== 'completed'
            ? 'scheduled'
            : todo.status === 'scheduled'
              ? 'pending'
              : todo.status
      }
      todo.updatedAt = now()
    },
    deleteTodoItem(state, action: PayloadAction<string>) {
      const todo = state.todoItems.find((item) => item.id === action.payload)
      if (!todo || todo.status === 'running') {
        return
      }
      state.todoItems = state.todoItems.filter((item) => item.id !== action.payload)
      state.todoNotifications = state.todoNotifications.filter(
        (notification) => notification.todoId !== action.payload
      )
    },
    deleteTodoGroup(state, action: PayloadAction<string>) {
      const taskGroup = action.payload
      const removableTodoIds = new Set(
        state.todoItems
          .filter((item) => item.taskGroup === taskGroup && item.status !== 'running')
          .map((item) => item.id)
      )
      state.todoItems = state.todoItems.filter((item) => !removableTodoIds.has(item.id))
      state.todoNotifications = state.todoNotifications.filter(
        (notification) => !removableTodoIds.has(notification.todoId)
      )
      state.todoGroups = state.todoGroups.filter((group) => group !== taskGroup)
    },
    addTodoAssistantSummary(
      state,
      action: PayloadAction<{
        topicId: string
        items: TodoItem[]
        sourcePrompt: string
        analysisApplied?: boolean
      }>
    ) {
      const taskGroup = action.payload.items[0]?.taskGroup || '默认任务组'
      state.messages.push(
        makeMessage({
          role: 'assistant',
          topicId: action.payload.topicId,
          assistantName: 'TODO助手',
          blocks: [
            createTextBlock(
              [
                action.payload.analysisApplied
                  ? '已先交给意图识别/分析 Agent 梳理需求，再由 TODO 助手生成系统 TODO。'
                  : '已由 TODO 助手生成系统 TODO。',
                `已生成任务组「${taskGroup}」，并添加 ${action.payload.items.length} 个系统 TODO：`,
                '',
                ...action.payload.items.map(
                  (item, index) =>
                    `${index + 1}. **${item.title}**\n   ${item.description}`
                )
              ].join('\n')
            )
          ]
        })
      )
      const topic = state.topics.find((item) => item.id === action.payload.topicId)
      if (topic) {
        topic.updatedAt = now()
      }
    },
    startTodoExecution(
      state,
      action: PayloadAction<{ todoId: string; topicId: string; assistantId: string }>
    ) {
      const todo = state.todoItems.find((item) => item.id === action.payload.todoId)
      const assistant = state.assistants.find((item) => item.id === action.payload.assistantId)
      if (!todo) return

      if (!state.topics.some((topic) => topic.id === action.payload.topicId)) {
        state.topics.unshift({
          id: action.payload.topicId,
          title: `TODO：${todo.title}`,
          updatedAt: now(),
          titleMode: 'generated',
          assistantIds: [action.payload.assistantId],
          sourceTodoId: todo.id
        })
      }
      todo.status = 'running'
      todo.lastRunAt = now()
      todo.workspaceTopicId = action.payload.topicId
      todo.errorMessage = undefined
      todo.updatedAt = now()
      state.activeTodoTaskId = todo.id
      state.activeTopicId = action.payload.topicId
      if (assistant) {
        const topic = state.topics.find((item) => item.id === action.payload.topicId)
        if (topic) {
          topic.assistantIds = [assistant.id]
        }
      }
    },
    completeTodoExecution(
      state,
      action: PayloadAction<{
        todoId: string
        topicId: string
        messageId?: string
        resultSummary: string
      }>
    ) {
      const todo = state.todoItems.find((item) => item.id === action.payload.todoId)
      if (!todo) return

      todo.status = 'completed'
      todo.completedAt = now()
      todo.updatedAt = now()
      todo.workspaceTopicId = action.payload.topicId
      todo.workspaceMessageId = action.payload.messageId
      todo.resultSummary = action.payload.resultSummary
      todo.errorMessage = undefined
      if (state.activeTodoTaskId === todo.id) {
        state.activeTodoTaskId = null
      }
      state.todoNotifications.unshift({
        id: nanoid(),
        todoId: todo.id,
        title: `TODO 已完成：${todo.title}`,
        message: action.payload.resultSummary,
        createdAt: now(),
        read: false,
        topicId: action.payload.topicId
      })
    },
    failTodoExecution(
      state,
      action: PayloadAction<{ todoId: string; errorMessage: string }>
    ) {
      const todo = state.todoItems.find((item) => item.id === action.payload.todoId)
      if (!todo) return

      todo.status = 'failed'
      todo.errorMessage = action.payload.errorMessage
      todo.updatedAt = now()
      if (state.activeTodoTaskId === todo.id) {
        state.activeTodoTaskId = null
      }
    },
    markTodoNotificationRead(state, action: PayloadAction<string>) {
      const notification = state.todoNotifications.find(
        (item) => item.id === action.payload
      )
      if (notification) {
        notification.read = true
      }
    },
    renameTopic(state, action: PayloadAction<{ topicId: string; title: string }>) {
      const topic = state.topics.find((item) => item.id === action.payload.topicId)
      if (topic) {
        topic.title = action.payload.title
        topic.updatedAt = now()
        topic.titleMode = 'manual'
      }
    },
    updateTopicWorkspaceDirectory(
      state,
      action: PayloadAction<{ topicId: string; workspaceDirectory?: string }>
    ) {
      const topic = state.topics.find((item) => item.id === action.payload.topicId)
      if (topic) {
        topic.workspaceDirectory = action.payload.workspaceDirectory
        topic.updatedAt = now()
      }
    },
    updateTopicAssistantIds(
      state,
      action: PayloadAction<{ topicId: string; assistantIds: string[] }>
    ) {
      const topic = state.topics.find((item) => item.id === action.payload.topicId)
      if (topic) {
        topic.assistantIds = action.payload.assistantIds
        topic.updatedAt = now()
      }
    },
    applyGeneratedTopicTitle(
      state,
      action: PayloadAction<{ topicId: string; title: string }>
    ) {
      const topic = state.topics.find((item) => item.id === action.payload.topicId)
      const title = action.payload.title.trim()
      if (topic?.titleMode === 'placeholder' && title) {
        topic.title = title
        topic.titleMode = 'generated'
        topic.updatedAt = now()
      }
    },
    deleteTopic(state, action: PayloadAction<string>) {
      state.topics = state.topics.filter((topic) => topic.id !== action.payload)
      state.messages = state.messages.filter((message) => message.topicId !== action.payload)
      if (state.activeTopicId === action.payload) {
        state.activeTopicId = state.topics[0]?.id ?? null
      }
    },
    clearTopicMessages(state, action: PayloadAction<string>) {
      state.messages = state.messages.filter((message) => message.topicId !== action.payload)
      const topic = state.topics.find((item) => item.id === action.payload)
      if (topic) {
        topic.updatedAt = now()
      }
    },
    addMessageToSystemNotes(state, action: PayloadAction<{ messageId: string }>) {
      const message = state.messages.find((item) => item.id === action.payload.messageId)
      if (!message || message.role !== 'assistant') {
        return
      }

      const existingNote = state.systemNotes.find(
        (note) => note.sourceMessageId === action.payload.messageId
      )
      if (existingNote) {
        state.activeSystemNoteId = existingNote.id
        return
      }

      const topic = state.topics.find((item) => item.id === message.topicId)
      const content = message.blocks
        .map((block) => (block.title ? `## ${block.title}\n\n${block.content}` : block.content))
        .filter(Boolean)
        .join('\n\n')
        .trim()
      const note: SystemNote = {
        id: nanoid(),
        title: topic?.title ?? `${message.assistantName ?? '系统'}回答`,
        content,
        sourceMessageId: message.id,
        sourceTopicId: message.topicId,
        assistantName: message.assistantName,
        createdAt: now(),
        updatedAt: now()
      }

      state.systemNotes.unshift(note)
      state.activeSystemNoteId = note.id
    },
    createSystemNote(state) {
      const note: SystemNote = {
        id: nanoid(),
        title: '未命名笔记',
        content: '',
        sourceMessageId: '',
        sourceTopicId: '',
        createdAt: now(),
        updatedAt: now()
      }

      state.systemNotes.unshift(note)
      state.activeSystemNoteId = note.id
    },
    deleteSystemNote(state, action: PayloadAction<string>) {
      const noteIndex = state.systemNotes.findIndex((note) => note.id === action.payload)
      if (noteIndex === -1) {
        return
      }

      state.systemNotes.splice(noteIndex, 1)
      if (state.activeSystemNoteId === action.payload) {
        state.activeSystemNoteId =
          state.systemNotes[noteIndex]?.id ??
          state.systemNotes[noteIndex - 1]?.id ??
          null
      }
    },
    setActiveSystemNote(state, action: PayloadAction<string>) {
      state.activeSystemNoteId = action.payload
    },
    updateSystemNote(
      state,
      action: PayloadAction<{ noteId: string; patch: Partial<Pick<SystemNote, 'title' | 'content'>> }>
    ) {
      const note = state.systemNotes.find((item) => item.id === action.payload.noteId)
      if (note) {
        Object.assign(note, action.payload.patch)
        note.updatedAt = now()
      }
    },
    sendUserMessage(
      state,
      action: PayloadAction<{
        topicId: string
        content: string
      }>
    ) {
      state.messages.push(
        makeMessage({
          role: 'user',
          topicId: action.payload.topicId,
          blocks: [createTextBlock(action.payload.content)]
        })
      )
      const topic = state.topics.find((item) => item.id === action.payload.topicId)
      if (topic) {
        topic.updatedAt = now()
      }
    },
    startAssistantMessage(state, action: PayloadAction<Message>) {
      state.messages.push(action.payload)
      const topic = state.topics.find((item) => item.id === action.payload.topicId)
      if (topic) {
        topic.updatedAt = now()
      }
    },
    appendAssistantMessageBlockContent(
      state,
      action: PayloadAction<{
        messageId: string
        blockId: string
        content: string
      }>
    ) {
      const message = state.messages.find((item) => item.id === action.payload.messageId)
      const block = message?.blocks.find((item) => item.id === action.payload.blockId)
      if (block) {
        block.content += action.payload.content
      }
    },
    finishAssistantMessageBlock(
      state,
      action: PayloadAction<{
        messageId: string
        blockId: string
      }>
    ) {
      const message = state.messages.find((item) => item.id === action.payload.messageId)
      const block = message?.blocks.find((item) => item.id === action.payload.blockId)
      if (block) {
        block.status = 'done'
      }
    },
    finishStreamingAssistantMessages(
      state,
      action: PayloadAction<{ topicId: string }>
    ) {
      state.messages
        .filter(
          (message) =>
            message.topicId === action.payload.topicId &&
            message.role === 'assistant'
        )
        .forEach((message) => {
          message.blocks.forEach((block) => {
            if (block.status === 'streaming') {
              block.status = 'done'
            }
          })
        })
    },
    appendAssistantMessageBlock(
      state,
      action: PayloadAction<{
        messageId: string
        block: MessageBlock
      }>
    ) {
      const message = state.messages.find((item) => item.id === action.payload.messageId)
      if (message) {
        message.blocks.push(action.payload.block)
        const topic = state.topics.find((item) => item.id === message.topicId)
        if (topic) {
          topic.updatedAt = now()
        }
      }
    },
    resolveAgentApprovalBlock(
      state,
      action: PayloadAction<{
        messageId: string
        blockId: string
        approved: boolean
      }>
    ) {
      const message = state.messages.find((item) => item.id === action.payload.messageId)
      const block = message?.blocks.find((item) => item.id === action.payload.blockId)
      if (block) {
        block.meta = {
          ...block.meta,
          approvalState: action.payload.approved ? 'approved' : 'denied'
        }
        block.title = action.payload.approved ? '已授权执行' : '已拒绝执行'
      }
    },
    updateSettings(state, action: PayloadAction<Partial<WorkspaceSettings>>) {
      state.settings = { ...state.settings, ...action.payload }
    },
    updateAssistantModel(
      state,
      action: PayloadAction<{ assistantId: string; providerId: string; model: string }>
    ) {
      const assistant = state.assistants.find((item) => item.id === action.payload.assistantId)
      if (assistant) {
        assistant.providerId = action.payload.providerId
        assistant.model = action.payload.model
      }
    },
    createAssistant(
      state,
      action: PayloadAction<{
        name: string
        description: string
        providerId: string
        model: string
        systemPrompt: string
        contextLimit: number
      }>
    ) {
      const assistant: Assistant = {
        id: nanoid(),
        name: action.payload.name,
        description: action.payload.description,
        providerId: action.payload.providerId,
        model: action.payload.model,
        systemPrompt: action.payload.systemPrompt,
        contextLimit: action.payload.contextLimit,
        capabilities: ['聊天'],
        knowledgeBaseIds: [],
        enabledToolIds: []
      }
      state.assistants.unshift(assistant)
    },
    updateAssistant(
      state,
      action: PayloadAction<{
        assistantId: string
        patch: Partial<
          Pick<
            Assistant,
            'name' | 'description' | 'providerId' | 'model' | 'systemPrompt' | 'contextLimit'
          >
        >
      }>
    ) {
      const assistant = state.assistants.find((item) => item.id === action.payload.assistantId)
      if (assistant) {
        Object.assign(assistant, action.payload.patch)
      }
    },
    deleteAssistant(state, action: PayloadAction<string>) {
      if (action.payload === 'assistant-main') {
        return
      }
      state.assistants = state.assistants.filter((assistant) => assistant.id !== action.payload)
      if (state.activeAssistantId === action.payload) {
        const fallbackAssistant = state.assistants[0]
        state.activeAssistantId = fallbackAssistant?.id ?? null
      }
    },
    toggleAssistantSkill(
      state,
      action: PayloadAction<{ assistantId: string; skillId: string }>
    ) {
      const assistant = state.assistants.find((item) => item.id === action.payload.assistantId)
      if (!assistant) {
        return
      }
      const skillIds = new Set(assistant.enabledSkillIds ?? [])
      if (skillIds.has(action.payload.skillId)) {
        skillIds.delete(action.payload.skillId)
      } else {
        skillIds.add(action.payload.skillId)
      }
      assistant.enabledSkillIds = Array.from(skillIds)
    },
    createSkill(
      state,
      action: PayloadAction<Omit<Skill, 'enabled'> & { enabled?: boolean }>
    ) {
      state.skills.unshift({
        enabled: action.payload.enabled ?? true,
        ...action.payload
      })
    },
    updateSkill(
      state,
      action: PayloadAction<{
        skillId: string
        patch: Partial<Omit<Skill, 'id'>>
      }>
    ) {
      const skill = state.skills.find((item) => item.id === action.payload.skillId)
      if (skill) {
        Object.assign(skill, action.payload.patch)
      }
    },
    deleteSkill(state, action: PayloadAction<string>) {
      state.skills = state.skills.filter((skill) => skill.id !== action.payload)
    },
    toggleSkill(state, action: PayloadAction<string>) {
      const skill = state.skills.find((item) => item.id === action.payload)
      if (skill) {
        skill.enabled = !skill.enabled
      }
    },
    updateProviderConfig(
      state,
      action: PayloadAction<{
        providerId: string
        patch: Partial<ProviderConfig>
      }>
    ) {
      const provider = state.providers.find((item) => item.id === action.payload.providerId)
      if (provider) {
        Object.assign(provider, action.payload.patch)
      }
    },
    updateMcpToolConfig(
      state,
      action: PayloadAction<{
        toolId: string
        patch: Partial<McpTool>
      }>
    ) {
      const tool = state.mcpTools.find((item) => item.id === action.payload.toolId)
      if (tool) {
        Object.assign(tool, action.payload.patch)
      }
    },
    upsertMcpServer(state, action: PayloadAction<McpServerConfig>) {
      const existing = state.mcpServers.find((item) => item.id === action.payload.id)
      if (existing) {
        Object.assign(existing, action.payload)
      } else {
        state.mcpServers.push(action.payload)
      }
    },
    deleteMcpServer(state, action: PayloadAction<string>) {
      state.mcpServers = state.mcpServers.filter((server) => server.id !== action.payload)
    },
    toggleAssistantKnowledgeBase(
      state,
      action: PayloadAction<{ assistantId: string; knowledgeBaseId: string }>
    ) {
      const assistant = state.assistants.find((item) => item.id === action.payload.assistantId)
      if (!assistant) {
        return
      }

      assistant.knowledgeBaseIds = assistant.knowledgeBaseIds.includes(action.payload.knowledgeBaseId)
        ? assistant.knowledgeBaseIds.filter((id) => id !== action.payload.knowledgeBaseId)
        : [...assistant.knowledgeBaseIds, action.payload.knowledgeBaseId]
    },
    toggleAssistantTool(
      state,
      action: PayloadAction<{ assistantId: string; toolId: string }>
    ) {
      const assistant = state.assistants.find((item) => item.id === action.payload.assistantId)
      if (!assistant) {
        return
      }

      assistant.enabledToolIds = assistant.enabledToolIds.includes(action.payload.toolId)
        ? assistant.enabledToolIds.filter((id) => id !== action.payload.toolId)
        : [...assistant.enabledToolIds, action.payload.toolId]
    },
    createKnowledgeBase(
      state,
      action: PayloadAction<{
        id?: string
        name: string
        description: string
        sourceFileIds: string[]
      }>
    ) {
      state.knowledgeBases.unshift({
        id: action.payload.id ?? nanoid(),
        name: action.payload.name,
        description: action.payload.description,
        sourceFileIds: action.payload.sourceFileIds,
        chunkCount: 0,
        status: 'ready',
        tags: ['custom'],
        chunks: buildKnowledgeChunks({
          sourceFileIds: action.payload.sourceFileIds,
          files: state.files,
          fallbackDescription: action.payload.description
        }),
        indexedContent: buildKnowledgeContent(
          action.payload.sourceFileIds,
          state.files,
          action.payload.description
        ),
        graph: { nodes: [], edges: [], facts: [] }
      })
    },
    deleteKnowledgeBase(state, action: PayloadAction<string>) {
      state.knowledgeBases = state.knowledgeBases.filter((base) => base.id !== action.payload)
      state.assistants.forEach((assistant) => {
        assistant.knowledgeBaseIds = assistant.knowledgeBaseIds.filter(
          (knowledgeBaseId) => knowledgeBaseId !== action.payload
        )
      })
    },
    addFileToKnowledgeBase(
      state,
      action: PayloadAction<{
        knowledgeBaseId: string
        file: FileRecord
        indexResult?: KnowledgeIndexResult
      }>
    ) {
      const base = state.knowledgeBases.find(
        (item) => item.id === action.payload.knowledgeBaseId
      )
      if (!base) {
        return
      }

      const existingFile = state.files.find((file) => file.id === action.payload.file.id)
      if (!existingFile) {
        state.files.unshift(action.payload.file)
      } else {
        Object.assign(existingFile, action.payload.file)
      }
      if (!base.sourceFileIds.includes(action.payload.file.id)) {
        base.sourceFileIds.unshift(action.payload.file.id)
      }
      base.chunks = action.payload.indexResult
        ? [
            ...(base.chunks ?? []).filter(
              (chunk) => chunk.sourceFileId !== action.payload.file.id
            ),
            ...action.payload.indexResult.chunks
          ]
        : base.chunks ?? []
      base.graph = action.payload.indexResult?.graph ?? base.graph
      base.chunkCount = base.chunks.length
      base.indexedContent = buildKnowledgeContent(
        base.sourceFileIds,
        state.files,
        base.description
      )
      base.status = state.files.some(
        (file) =>
          base.sourceFileIds.includes(file.id) &&
          ['queued', 'extracting', 'indexing'].includes(file.knowledgeStatus ?? '')
      )
        ? 'indexing'
        : 'ready'
    },
    applyKnowledgeExtractionEvent(
      state,
      action: PayloadAction<KnowledgeExtractionEvent>
    ) {
      const file = state.files.find((item) => item.id === action.payload.fileId)
      const base = state.knowledgeBases.find(
        (item) => item.id === action.payload.knowledgeBaseId
      )
      if (!file || !base) {
        return
      }

      file.knowledgeStatus = action.payload.status
      file.knowledgeProgress = action.payload.progress
      file.knowledgeError = action.payload.error
      file.knowledgeStartedAt =
        action.payload.startedAt ?? file.knowledgeStartedAt
      file.knowledgeCompletedAt = action.payload.completedAt
      if (action.payload.contentText !== undefined) {
        file.contentText = action.payload.contentText
      }
      if (action.payload.extractedBy !== undefined) {
        file.extractedBy = action.payload.extractedBy
      }
      if (action.payload.extractionWarning !== undefined) {
        file.extractionWarning = action.payload.extractionWarning
      }
      if (action.payload.indexResult) {
        base.chunks = [
          ...(base.chunks ?? []).filter(
            (chunk) => chunk.sourceFileId !== action.payload.fileId
          ),
          ...action.payload.indexResult.chunks
        ]
        base.graph = action.payload.indexResult.graph
        base.chunkCount = base.chunks.length
      }
      base.indexedContent = buildKnowledgeContent(
        base.sourceFileIds,
        state.files,
        base.description
      )
      base.status = state.files.some(
        (candidate) =>
          base.sourceFileIds.includes(candidate.id) &&
          ['queued', 'extracting', 'indexing'].includes(
            candidate.knowledgeStatus ?? ''
          )
      )
        ? 'indexing'
        : 'ready'
    },
    removeFileFromKnowledgeBase(
      state,
      action: PayloadAction<{ knowledgeBaseId: string; fileId: string }>
    ) {
      const base = state.knowledgeBases.find(
        (item) => item.id === action.payload.knowledgeBaseId
      )
      if (!base) {
        return
      }

      base.sourceFileIds = base.sourceFileIds.filter(
        (fileId) => fileId !== action.payload.fileId
      )
      base.chunks = (base.chunks ?? []).filter(
        (chunk) => chunk.sourceFileId !== action.payload.fileId
      )
      if (base.graph) {
        const graph: KnowledgeGraph = {
          nodes: base.graph.nodes
            .map((node) => ({
              ...node,
              sourceFileIds: node.sourceFileIds.filter(
                (fileId) => fileId !== action.payload.fileId
              ),
              sourceChunkIds: node.sourceChunkIds.filter((chunkId) =>
                base.chunks?.some((chunk) => chunk.id === chunkId)
              )
            }))
            .filter((node) => node.sourceFileIds.length > 0),
          edges: base.graph.edges
            .map((edge) => ({
              ...edge,
              sourceFileIds: edge.sourceFileIds.filter(
                (fileId) => fileId !== action.payload.fileId
              ),
              sourceChunkIds: edge.sourceChunkIds.filter((chunkId) =>
                base.chunks?.some((chunk) => chunk.id === chunkId)
              )
            }))
            .filter((edge) => edge.sourceFileIds.length > 0),
          facts: base.graph.facts
            .map((fact) => ({
              ...fact,
              sourceFileIds: fact.sourceFileIds.filter(
                (fileId) => fileId !== action.payload.fileId
              ),
              sourceChunkIds: fact.sourceChunkIds.filter((chunkId) =>
                base.chunks?.some((chunk) => chunk.id === chunkId)
              )
            }))
            .filter((fact) => fact.sourceFileIds.length > 0)
        }
        const nodeIds = new Set(graph.nodes.map((node) => node.id))
        graph.edges = graph.edges.filter(
          (edge) => nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId)
        )
        graph.facts = graph.facts.filter(
          (fact) => !fact.subjectNodeId || nodeIds.has(fact.subjectNodeId)
        )
        base.graph = graph
      }
      base.chunkCount = base.chunks.length
      base.indexedContent = buildKnowledgeContent(
        base.sourceFileIds,
        state.files,
        base.description
      )
    },
    uploadFile(state, action: PayloadAction<FileRecord>) {
      state.files.unshift(action.payload)
    }
  },
  extraReducers: () => {}
})

export const {
  addFileToKnowledgeBase,
  addMailCheckErrorNotification,
  applyMailCheckResult,
  applyKnowledgeExtractionEvent,
  addMessageToSystemNotes,
  appendAssistantMessageBlock,
  appendAssistantMessageBlockContent,
  applyGeneratedTopicTitle,
  createKnowledgeBase,
  addTodoAssistantSummary,
  addTodoItems,
  completeTodoExecution,
  createAssistant,
  createSkill,
  createSystemNote,
  createTopic,
  createTodoGroup,
  createTodoItem,
  createMailTask,
  clearTopicMessages,
  deleteAssistant,
  deleteSystemNote,
  deleteSkill,
  deleteKnowledgeBase,
  deleteTopic,
  deleteTodoGroup,
  deleteTodoItem,
  hydrateWorkbench,
  hydrateWorkspaceContent,
  hydrateWorkspacePreferences,
  finishAssistantMessageBlock,
  finishStreamingAssistantMessages,
  failTodoExecution,
  markTodoNotificationRead,
  renameTopic,
  removeFileFromKnowledgeBase,
  resetWorkbench,
  resolveAgentApprovalBlock,
  sendUserMessage,
  sendMailFromWorkbench,
  setActiveAssistant,
  setActiveSystemNote,
  setActiveTopic,
  startAssistantMessage,
  startTodoExecution,
  toggleAssistantKnowledgeBase,
  toggleAssistantSkill,
  toggleAssistantTool,
  toggleSkill,
  updateAssistant,
  updateMailAgentSettings,
  updateAssistantModel,
  updateTodoItem,
  updateTopicAssistantIds,
  updateSkill,
  updateMcpToolConfig,
  upsertMcpServer,
  deleteMcpServer,
  updateProviderConfig,
  updateSettings,
  updateSystemNote,
  updateTopicWorkspaceDirectory,
  processMailTask,
  uploadFile
} = workbenchSlice.actions

export const workbenchReducer = workbenchSlice.reducer

export const selectProviders = (state: RootState) => state.workbench.providers
export const selectKnowledgeBases = (state: RootState) => state.workbench.knowledgeBases
export const selectMcpTools = (state: RootState) => state.workbench.mcpTools
export const selectMcpServers = (state: RootState) => state.workbench.mcpServers
export const selectFiles = (state: RootState) => state.workbench.files
export const selectSettings = (state: RootState) => state.workbench.settings
export const selectAssistants = (state: RootState) => state.workbench.assistants
export const selectSkills = (state: RootState) => state.workbench.skills
export const selectMailAgentSettings = (state: RootState) =>
  state.workbench.mailAgentSettings
export const selectMailNotifications = (state: RootState) =>
  state.workbench.mailNotifications
export const selectUnreadMailNotifications = (state: RootState) =>
  state.workbench.mailNotifications.filter((mail) => mail.unread)
export const selectTodoItems = (state: RootState) => state.workbench.todoItems
export const selectTodoGroups = (state: RootState) => state.workbench.todoGroups
export const selectTodoNotifications = (state: RootState) =>
  state.workbench.todoNotifications
export const selectUnreadTodoNotifications = (state: RootState) =>
  state.workbench.todoNotifications.filter((notification) => !notification.read)
export const selectActiveTodoTaskId = (state: RootState) =>
  state.workbench.activeTodoTaskId

export const selectActiveAssistant = (state: RootState) =>
  state.workbench.assistants.find(
    (assistant) => assistant.id === state.workbench.activeAssistantId
  )

export const selectTopics = (state: RootState) => state.workbench.topics

export const selectMessages = (state: RootState) => state.workbench.messages

export const selectActiveTopic = (state: RootState) =>
  state.workbench.topics.find((topic) => topic.id === state.workbench.activeTopicId)

export const selectMessagesForActiveTopic = (state: RootState) =>
  state.workbench.messages.filter(
    (message) => message.topicId === state.workbench.activeTopicId
  )

export const selectSystemNotes = (state: RootState) => state.workbench.systemNotes

export const selectActiveSystemNote = (state: RootState) =>
  state.workbench.systemNotes.find(
    (note) => note.id === state.workbench.activeSystemNoteId
  ) ?? state.workbench.systemNotes[0]

export const selectAssistantProvider = (state: RootState) => {
  const assistant = selectActiveAssistant(state)
  return state.workbench.providers.find((provider) => provider.id === assistant?.providerId)
}
