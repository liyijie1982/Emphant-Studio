import {
  ArrowUpOutlined,
  AudioOutlined,
  BorderOutlined,
  CheckOutlined,
  CopyOutlined,
  DownOutlined,
  FileAddOutlined,
  FolderOpenOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  SoundOutlined,
  ToolOutlined
} from '@ant-design/icons'
import {
  App,
  Alert,
  Button,
  Card,
  Dropdown,
  Form,
  Input,
  Modal,
  Popover,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import type { MenuProps } from 'antd'
import { Fragment, isValidElement, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import type { MailSendRequest, MemoryGreeting, MemoryProfile, MessageBlock } from '@emphant/shared/types'
import { planWorkbenchIntent } from '@/lib/intentPlanner'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  addMailCheckErrorNotification,
  addMessageToSystemNotes,
  applyMailCheckResult,
  createTopic,
  createTodoItemsFromWorkbench,
  deleteTopic,
  renameTopic,
  processMailTask,
  respondToAgentApproval,
  selectActiveTopic,
  selectAssistants,
  selectKnowledgeBases,
  selectMailAgentSettings,
  selectMailNotifications,
  selectMcpTools,
  selectMessagesForActiveTopic,
  selectSettings,
  selectSystemNotes,
  selectTopics,
  sendAssistantReply,
  sendMailFromWorkbench,
  sendUserMessage,
  stopAssistantReplies,
  setActiveTopic,
  updateTopicAssistantIds,
  updateTopicWorkspaceDirectory
} from '@/store/workbenchSlice'

const formatToolResult = (content: string) => {
  try {
    return {
      type: 'json' as const,
      content: JSON.stringify(JSON.parse(content), null, 2)
    }
  } catch {
    return {
      type: 'markdown' as const,
      content
    }
  }
}

const getCodeText = (node: ReactNode): string => {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(getCodeText).join('')
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return getCodeText(node.props.children)
  }
  return ''
}

const getCodeLanguage = (node: ReactNode) => {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(node)) {
    return ''
  }
  return node.props.className?.match(/language-([\w-]+)/)?.[1]?.toLowerCase() ?? ''
}

const serializeErrorForLog = (error: unknown) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause
    }
  }
  return error
}

const logAudioError = (scope: string, error: unknown, context: Record<string, unknown> = {}) => {
  console.error(`[workbench-audio] ${scope}`, {
    error: serializeErrorForLog(error),
    context
  })
}

const isDashScopeAudioModel = (provider: { id?: string; baseUrl?: string } | undefined, model: string) => {
  const baseUrl = provider?.baseUrl?.toLowerCase() ?? ''
  const normalizedModel = model.toLowerCase()
  return (
    provider?.id === 'provider-qwen' ||
    baseUrl.includes('dashscope.aliyuncs.com') ||
    baseUrl.includes('maas.aliyuncs.com') ||
    normalizedModel.startsWith('fun-asr')
  )
}

const splitTextForSpeech = (text: string) => {
  const segments: string[] = []
  let current = ''
  let closingQuoteBuffer = ''
  const sentenceEndPattern = /[。！？!?；;，,、：:]+|(?<!\d)[.]+(?!\d)|[\n\r]+/
  const closingQuotePattern = /[”’"'）)]/

  for (const char of text.replace(/[^\S\r\n]+/g, ' ').trim()) {
    if (closingQuoteBuffer) {
      if (closingQuotePattern.test(char)) {
        closingQuoteBuffer += char
        continue
      }
      segments.push(closingQuoteBuffer.trim())
      closingQuoteBuffer = ''
    }

    current += char
    if (sentenceEndPattern.test(char)) {
      closingQuoteBuffer = current
      current = ''
    }
  }

  const remainingText = `${closingQuoteBuffer}${current}`.trim()
  if (remainingText) {
    segments.push(remainingText)
  }

  return segments.map((segment) => segment.trim()).filter(Boolean)
}

let mermaidRenderCounter = 0
let isMermaidInitialized = false

const MermaidDiagram = ({ chart }: { chart: string }) => {
  const { message: messageApi } = App.useApp()
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const renderId = `mermaid-diagram-${Date.now()}-${mermaidRenderCounter += 1}`

    setSvg('')
    setError('')
    void import('mermaid')
      .then(({ default: mermaid }) => {
        if (!isMermaidInitialized) {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: 'dark',
            fontFamily:
              'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            themeVariables: {
              background: 'transparent',
              primaryColor: '#1d2430',
              primaryTextColor: '#edf2ff',
              primaryBorderColor: '#5e78b7',
              lineColor: '#8ca9e8',
              secondaryColor: '#17202b',
              tertiaryColor: '#111820',
              textColor: '#edf2ff'
            }
          })
          isMermaidInitialized = true
        }
        return mermaid.render(renderId, chart)
      })
      .then((result) => {
        if (active) setSvg(result.svg)
      })
      .catch((renderError) => {
        if (active) {
          setError(renderError instanceof Error ? renderError.message : 'Mermaid 图表渲染失败')
        }
      })

    return () => {
      active = false
    }
  }, [chart])

  const handleCopy = async () => {
    try {
      await window.emphant.copyText(chart)
      void messageApi.success('Mermaid 源码已复制')
    } catch {
      void messageApi.error('复制失败，请稍后重试')
    }
  }

  return (
    <div className="mermaid-diagram">
      <div className="mermaid-diagram__toolbar">
        <span>Mermaid</span>
        <Button
          type="text"
          size="small"
          aria-label="复制 Mermaid 源码"
          icon={<CopyOutlined />}
          onClick={() => void handleCopy()}
        >
          复制
        </Button>
      </div>
      {error ? (
        <pre className="mermaid-diagram__error">
          <code>{error}</code>
        </pre>
      ) : svg ? (
        <div
          className="mermaid-diagram__canvas"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="mermaid-diagram__loading">正在渲染图表</div>
      )}
    </div>
  )
}

const MarkdownCodeBlock = ({
  children,
  ...props
}: ComponentPropsWithoutRef<'pre'>) => {
  const { message: messageApi } = App.useApp()
  const code = getCodeText(children).replace(/\n$/, '')
  const language = getCodeLanguage(Array.isArray(children) ? children[0] : children)

  if (language === 'mermaid') {
    return <MermaidDiagram chart={code} />
  }

  const handleCopy = async () => {
    if (!code) {
      return
    }

    try {
      await window.emphant.copyText(code)
      void messageApi.success('代码已复制')
    } catch {
      void messageApi.error('代码复制失败，请稍后重试')
    }
  }

  return (
    <div className="markdown-code-block">
      <Button
        type="text"
        size="small"
        className="markdown-code-block__copy"
        aria-label="复制代码"
        icon={<CopyOutlined />}
        onClick={() => void handleCopy()}
      >
        复制
      </Button>
      <pre {...props}>{children}</pre>
    </div>
  )
}

const markdownComponents = {
  pre: MarkdownCodeBlock
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

type MailDraft = MailSendRequest & {
  mode: 'new' | 'reply'
  sourceLabel?: string
  intent?: {
    confidence: number
    risk: 'low' | 'medium' | 'high'
    reason: string
  }
}

const highlightDelegationMentions = (
  children: ReactNode,
  assistantNames: string[]
): ReactNode => {
  if (assistantNames.length === 0) {
    return children
  }

  const pattern = new RegExp(
    `(我将委派给\\s*)(${assistantNames
      .slice()
      .sort((left, right) => right.length - left.length)
      .map(escapeRegExp)
      .join('|')})`,
    'g'
  )

  const highlightText = (text: string): ReactNode => {
    const parts: ReactNode[] = []
    let cursor = 0
    let match: RegExpExecArray | null

    while ((match = pattern.exec(text)) !== null) {
      if (match.index > cursor) {
        parts.push(text.slice(cursor, match.index))
      }
      parts.push(match[1])
      parts.push(
        <span className="delegated-agent-name" key={`${match.index}-${match[2]}`}>
          {match[2]}
        </span>
      )
      cursor = match.index + match[0].length
    }

    if (parts.length === 0) {
      return text
    }
    if (cursor < text.length) {
      parts.push(text.slice(cursor))
    }

    return <Fragment>{parts}</Fragment>
  }

  if (typeof children === 'string') {
    return highlightText(children)
  }
  if (Array.isArray(children)) {
    return children.map((child, index) => (
      <Fragment key={index}>
        {typeof child === 'string' ? highlightText(child) : child}
      </Fragment>
    ))
  }

  return children
}

const createMessageMarkdownComponents = (assistantNames: string[]): Components => ({
  ...markdownComponents,
  p: ({ children, node, ...props }) => {
    void node
    return <p {...props}>{highlightDelegationMentions(children, assistantNames)}</p>
  }
})

const encodeWav = (samples: Float32Array, sampleRate: number) => {
  const bytesPerSample = 2
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample)
  const view = new DataView(buffer)

  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * bytesPerSample, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true)
  view.setUint16(32, bytesPerSample, true)
  view.setUint16(34, 8 * bytesPerSample, true)
  writeString(36, 'data')
  view.setUint32(40, samples.length * bytesPerSample, true)

  let offset = 44
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += bytesPerSample
  }

  return buffer
}

const ToolResult = ({ block }: { block: MessageBlock }) => {
  const [expanded, setExpanded] = useState(false)
  const formattedResult = useMemo(() => formatToolResult(block.content), [block.content])

  return (
    <div className="tool-result">
      <button
        type="button"
        className="tool-result__summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="tool-result__title">
          {expanded ? <DownOutlined /> : <RightOutlined />}
          <ToolOutlined />
          <strong>{block.title ?? block.meta?.toolName ?? '工具调用结果'}</strong>
        </span>
        <span>{expanded ? '收起详情' : '查看详情'}</span>
      </button>
      {expanded && (
        <div className="tool-result__content">
          {formattedResult.type === 'json' ? (
            <pre className="tool-result__json">
              <code>{formattedResult.content}</code>
            </pre>
          ) : (
            <div className="message-markdown tool-result__markdown">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[[rehypeHighlight, { detect: true }]]}
                components={markdownComponents}
              >
                {formattedResult.content}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const parseApprovalContent = (content: string) => {
  const [reason, ...parameterParts] = content.split('\n\n参数：\n')
  const parameters = parameterParts
    .join('\n\n参数：\n')
    .replace(/^```json\n?/, '')
    .replace(/\n?```$/, '')
    .trim()

  return {
    reason: reason.trim(),
    parameters
  }
}

const ApprovalRequestCard = ({
  block,
  assistantName,
  onApprove,
  onDeny,
  onRevise
}: {
  block: MessageBlock
  assistantName: string
  onApprove: () => void
  onDeny: () => void
  onRevise: (instruction: string) => void
}) => {
  const { reason, parameters } = useMemo(
    () => parseApprovalContent(block.content),
    [block.content]
  )
  const [isRevisionOpen, setIsRevisionOpen] = useState(false)
  const [revisionInstruction, setRevisionInstruction] = useState('')
  const risk = block.meta?.risk ?? 'high'
  const toolName = block.meta?.toolName ?? block.title?.replace(/^等待授权：/, '') ?? '外部工具'
  const defaultRevisionInstruction = [
    `请修改后重新执行工具：${toolName}`,
    reason ? `原风险说明：${reason}` : '',
    parameters ? `原参数：\n${parameters}` : ''
  ].filter(Boolean).join('\n\n')

  return (
    <div className="approval-request-card">
      <div className="approval-request-card__header">
        <span>
          <ToolOutlined />
          <strong>等待执行前确认</strong>
        </span>
        <Tag color={risk === 'high' ? 'red' : 'orange'}>{risk === 'high' ? '高风险' : risk}</Tag>
      </div>
      <div className="approval-request-card__grid">
        <span>动作类型</span>
        <strong>外部工具调用</strong>
        <span>执行智能体</span>
        <strong>{assistantName}</strong>
        <span>目标资源</span>
        <strong>{toolName}</strong>
      </div>
      {reason && (
        <Typography.Paragraph className="approval-request-card__reason">
          {reason}
        </Typography.Paragraph>
      )}
      {parameters && (
        <details className="approval-request-card__details">
          <summary>查看执行参数</summary>
          <pre>
            <code>{parameters}</code>
          </pre>
        </details>
      )}
      <Space size={8} wrap>
        <Button size="small" onClick={onDeny}>
          拒绝
        </Button>
        <Button
          size="small"
          onClick={() => {
            setRevisionInstruction(defaultRevisionInstruction)
            setIsRevisionOpen(true)
          }}
        >
          修改后执行
        </Button>
        <Button
          size="small"
          type="primary"
          danger={risk === 'high'}
          onClick={onApprove}
        >
          允许一次
        </Button>
      </Space>
      <Modal
        open={isRevisionOpen}
        title="修改后执行"
        okText="提交修改"
        cancelText="取消"
        onCancel={() => setIsRevisionOpen(false)}
        onOk={() => {
          const instruction = revisionInstruction.trim()
          if (!instruction) {
            return
          }
          onRevise(instruction)
          setIsRevisionOpen(false)
        }}
      >
        <Space direction="vertical" size={10} className="approval-request-card__revision">
          <Typography.Text type="secondary">
            系统会拒绝原始动作并记录原因，然后按你的修改重新发起一轮 AI 执行。
          </Typography.Text>
          <Input.TextArea
            value={revisionInstruction}
            onChange={(event) => setRevisionInstruction(event.target.value)}
            autoSize={{ minRows: 6, maxRows: 12 }}
          />
        </Space>
      </Modal>
    </div>
  )
}

const MessageRunDetails = ({
  message
}: {
  message: { assistantName?: string; blocks: MessageBlock[] }
}) => {
  const runMeta: Record<string, string> =
    message.blocks.find((block) => block.meta?.runId)?.meta ??
    message.blocks.find((block) => block.meta?.providerName || block.meta?.model)?.meta ??
    {}
  const toolBlocks = message.blocks.filter((block) => block.type === 'tool')
  const referenceBlocks = message.blocks.filter((block) => block.type === 'reference')
  const approvalBlocks = message.blocks.filter((block) => block.meta?.approvalState)
  const simulated = message.blocks.some((block) => block.meta?.simulated === 'true')
  const errorBlock = message.blocks.find((block) => block.type === 'error')
  const approvedCount = approvalBlocks.filter(
    (block) => block.meta?.approvalState === 'approved'
  ).length
  const deniedCount = approvalBlocks.filter(
    (block) => block.meta?.approvalState === 'denied'
  ).length
  const revisedCount = approvalBlocks.filter(
    (block) => block.meta?.approvalState === 'revised'
  ).length
  const pendingCount = approvalBlocks.filter(
    (block) => block.meta?.approvalState === 'pending'
  ).length
  const durationMs = Number(runMeta.durationMs)
  const durationLabel = Number.isFinite(durationMs)
    ? durationMs < 1000
      ? `${Math.max(1, Math.round(durationMs))} ms`
      : `${(durationMs / 1000).toFixed(1)} s`
    : '未记录'
  const summarizeBlockContent = (content: string) => {
    const text = content
      .replace(/```(?:json)?/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    return text.length > 180 ? `${text.slice(0, 180)}...` : text || '无内容'
  }
  const formatApprovalState = (state?: string) => {
    if (state === 'approved') return '已允许'
    if (state === 'denied') return '已拒绝'
    if (state === 'revised') return '已修改后重试'
    if (state === 'pending') return '待处理'
    return '未记录'
  }

  return (
    <Popover
      trigger="click"
      placement="topRight"
      content={
        <div className="run-details-popover">
          <div className="run-details-popover__row">
            <span>智能体</span>
            <strong>{runMeta.assistantName || message.assistantName || 'AI 助理'}</strong>
          </div>
          <div className="run-details-popover__row">
            <span>模型</span>
            <strong>{[runMeta.providerName, runMeta.model].filter(Boolean).join(' · ') || '未记录'}</strong>
          </div>
          <div className="run-details-popover__row">
            <span>知识库</span>
            <strong>{runMeta.knowledgeBaseNames || `${referenceBlocks.length} 条引用`}</strong>
          </div>
          <div className="run-details-popover__row">
            <span>工具</span>
            <strong>{runMeta.enabledToolNames || `${toolBlocks.length} 次调用`}</strong>
          </div>
          <div className="run-details-popover__row">
            <span>联网</span>
            <strong>{runMeta.networkAccess || '未记录'}</strong>
          </div>
          <div className="run-details-popover__row">
            <span>状态</span>
            <strong>{runMeta.runStatus || 'done'}</strong>
          </div>
          <div className="run-details-popover__row">
            <span>耗时</span>
            <strong>{durationLabel}</strong>
          </div>
          <div className="run-details-popover__row">
            <span>审批</span>
            <strong>
              {approvalBlocks.length
                ? `允许 ${approvedCount} · 拒绝 ${deniedCount} · 修改 ${revisedCount} · 待处理 ${pendingCount}`
                : '无审批动作'}
            </strong>
          </div>
          <div className="run-details-popover__row">
            <span>模拟</span>
            <strong>{simulated ? '是' : '否'}</strong>
          </div>
          {errorBlock && (
            <div className="run-details-popover__error">
              {errorBlock.title ? `${errorBlock.title}：` : ''}
              {errorBlock.content}
            </div>
          )}
          {approvalBlocks.length > 0 && (
            <div className="run-details-popover__section">
              <strong>审批记录</strong>
              {approvalBlocks.map((block) => (
                <div key={block.id} className="run-details-popover__item">
                  <span>
                    {formatApprovalState(block.meta?.approvalState)}
                    {block.meta?.risk ? ` · ${block.meta.risk}` : ''}
                  </span>
                  <strong>{block.meta?.toolName ?? block.title ?? '外部工具'}</strong>
                  <p>{block.meta?.approvalReason || block.meta?.reason || summarizeBlockContent(block.content)}</p>
                </div>
              ))}
            </div>
          )}
          {toolBlocks.length > 0 && (
            <div className="run-details-popover__section">
              <strong>工具调用结果</strong>
              {toolBlocks.map((block) => (
                <div key={block.id} className="run-details-popover__item">
                  <span>{block.meta?.toolName ?? block.title ?? '工具调用'}</span>
                  <p>{summarizeBlockContent(block.content)}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      }
    >
      <Button type="text" size="small">
        运行详情
      </Button>
    </Popover>
  )
}

const summarizeNames = (names: string[], emptyLabel: string, limit = 3) => {
  if (names.length === 0) {
    return emptyLabel
  }

  const visibleNames = names.slice(0, limit).join('、')
  return names.length > limit ? `${visibleNames} 等 ${names.length} 项` : visibleNames
}

const getMessageVisualStatus = (blocks: MessageBlock[]) => {
  if (blocks.some((block) => block.type === 'error' || block.meta?.runStatus === 'error')) {
    return { label: '失败', color: 'red' as const }
  }
  if (blocks.some((block) => block.meta?.approvalState === 'pending')) {
    return { label: '等待审批', color: 'orange' as const }
  }
  if (blocks.some((block) => block.status === 'streaming')) {
    return { label: 'AI 思考中', color: 'processing' as const }
  }
  if (blocks.some((block) => block.type === 'tool')) {
    return { label: '已调用工具', color: 'blue' as const }
  }
  if (blocks.some((block) => block.meta?.simulated === 'true')) {
    return { label: '模拟内容', color: 'gold' as const }
  }
  return { label: '已完成', color: 'green' as const }
}

export const HomePage = () => {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const { message: messageApi, modal: modalApi } = App.useApp()
  const assistants = useAppSelector(selectAssistants)
  const knowledgeBases = useAppSelector(selectKnowledgeBases)
  const mcpTools = useAppSelector(selectMcpTools)
  const topics = useAppSelector(selectTopics)
  const activeTopic = useAppSelector(selectActiveTopic)
  const mailAgentSettings = useAppSelector(selectMailAgentSettings)
  const mailNotifications = useAppSelector(selectMailNotifications)
  const messages = useAppSelector(selectMessagesForActiveTopic)
  const settings = useAppSelector(selectSettings)
  const systemNotes = useAppSelector(selectSystemNotes)
  const providers = useAppSelector((state) => state.workbench.providers)
  const enabledProviders = useMemo(
    () => providers.filter((provider) => provider.enabled),
    [providers]
  )
  const activeHighRiskTools = useAppSelector((state) =>
    state.workbench.mcpTools.filter(
      (tool) =>
        tool.enabled &&
        ['filesystem-write', 'command', 'system', 'database', 'devops'].includes(tool.category)
    )
  )
  const workbenchWarnings = [
    enabledProviders.length === 0
      ? '还没有启用模型服务，当前只能准备内容，不能调用真实模型。'
      : '',
    settings.defaultWorkingDirectory
      ? ''
      : '还没有设置工作目录，知识、笔记和文件操作无法统一保存。',
    activeHighRiskTools.length > 0 && !settings.openClawCore?.requireToolApproval
      ? '已有可改动文件或系统的工具开启，但执行前确认已关闭。'
      : ''
  ].filter(Boolean)
  const subAgentNames = useMemo(
    () =>
      assistants
        .filter((assistant) => assistant.id !== 'assistant-main')
        .map((assistant) => assistant.name),
    [assistants]
  )
  const messageMarkdownComponents = useMemo(
    () => createMessageMarkdownComponents(subAgentNames),
    [subAgentNames]
  )
  const [draft, setDraft] = useState('')
  const [memoryGreeting, setMemoryGreeting] = useState<MemoryGreeting | null>(null)
  const [memoryProfile, setMemoryProfile] = useState<MemoryProfile | null>(null)
  const [isTopicListVisible, setIsTopicListVisible] = useState(true)
  const [isRecording, setIsRecording] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null)
  const selectedAssistantIds = activeTopic?.assistantIds ?? []
  const selectedAssistants = useMemo(
    () =>
      selectedAssistantIds.length === 0 || selectedAssistantIds.includes('assistant-main')
        ? assistants.filter((assistant) => assistant.id === 'assistant-main')
        : assistants.filter((assistant) => selectedAssistantIds.includes(assistant.id)),
    [assistants, selectedAssistantIds]
  )
  const isGenerating = messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.blocks.some((block) => block.status === 'streaming')
  )
  const [renameTopicId, setRenameTopicId] = useState<string | null>(null)
  const [renameForm] = Form.useForm<{ title: string }>()
  const messageListRef = useRef<HTMLDivElement | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordingStreamRef = useRef<MediaStream | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const audioSampleChunksRef = useRef<Float32Array[]>([])
  const audioSampleRateRef = useRef(44_100)
  const audioPlaybackRef = useRef<HTMLAudioElement | null>(null)
  const audioPlaybackUrlRef = useRef<string | null>(null)
  const audioPlaybackResolveRef = useRef<(() => void) | null>(null)
  const speechPlaybackRunRef = useRef(0)
  const messageScrollKey = useMemo(
    () =>
      messages
        .map((message) =>
          [
            message.id,
            message.status,
            message.blocks.map((block) => `${block.id}:${block.status}:${block.content}`).join('|')
          ].join(':')
        )
        .join(';'),
    [messages]
  )

  const topicMenuItems: MenuProps['items'] = [
    {
      key: 'rename',
      label: '重命名'
    },
    {
      key: 'delete',
      label: '删除',
      danger: true
    }
  ]

  const assistantOptions = useMemo(
    () =>
      assistants.map((assistant) => ({
        label:
          assistant.id === 'assistant-main'
            ? `${assistant.name}（自动调度）`
            : assistant.name,
        value: assistant.id
      })),
    [assistants]
  )
  const selectedAssistantNames = useMemo(
    () =>
      selectedAssistants.map((assistant) =>
        assistant.id === 'assistant-main' ? `${assistant.name}（自动调度）` : assistant.name
      ),
    [selectedAssistants]
  )
  const activeKnowledgeNames = useMemo(() => {
    const ids = new Set(selectedAssistants.flatMap((assistant) => assistant.knowledgeBaseIds))
    return knowledgeBases.filter((base) => ids.has(base.id)).map((base) => base.name)
  }, [knowledgeBases, selectedAssistants])
  const activeToolNames = useMemo(() => {
    const ids = new Set(selectedAssistants.flatMap((assistant) => assistant.enabledToolIds))
    return mcpTools.filter((tool) => tool.enabled && ids.has(tool.id)).map((tool) => tool.name)
  }, [mcpTools, selectedAssistants])
  const pendingApprovalCount = useMemo(
    () =>
      messages.reduce(
        (count, message) =>
          count + message.blocks.filter((block) => block.meta?.approvalState === 'pending').length,
        0
      ),
    [messages]
  )
  const activeMailSource = useMemo(
    () =>
      activeTopic?.sourceMailId
        ? mailNotifications.find((mail) => mail.id === activeTopic.sourceMailId)
        : undefined,
    [activeTopic?.sourceMailId, mailNotifications]
  )
  const activeWorkspaceDirectory = activeTopic?.workspaceDirectory || ''
  const activeWorkspaceName = activeWorkspaceDirectory
    ? activeWorkspaceDirectory.split(/[\\/]/).filter(Boolean).at(-1) || activeWorkspaceDirectory
    : '工作目录'
  const contextSummaryItems = [
    {
      label: '智能体',
      value: summarizeNames(selectedAssistantNames, '自动调度')
    },
    {
      label: '知识库',
      value: summarizeNames(activeKnowledgeNames, '无绑定知识库')
    },
    {
      label: '工具权限',
      value: summarizeNames(activeToolNames, '仅对话')
    },
    {
      label: '工作目录',
      value: activeWorkspaceName
    }
  ]
  const asrProvider = useMemo(
    () =>
      providers.find(
        (provider) => provider.id === settings.defaultAsrProviderId && provider.enabled
      ),
    [providers, settings.defaultAsrProviderId]
  )
  const ttsProvider = useMemo(
    () =>
      providers.find(
        (provider) => provider.id === settings.defaultTtsProviderId && provider.enabled
      ),
    [providers, settings.defaultTtsProviderId]
  )

  useEffect(
    () => () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop()
      }
      audioProcessorRef.current?.disconnect()
      audioSourceRef.current?.disconnect()
      void audioContextRef.current?.close()
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop())
      audioPlaybackResolveRef.current?.()
      audioPlaybackResolveRef.current = null
      audioPlaybackRef.current?.pause()
      if (audioPlaybackUrlRef.current) {
        URL.revokeObjectURL(audioPlaybackUrlRef.current)
      }
    },
    []
  )

  useEffect(() => {
    const scrollToLatestMessage = () => {
      const list = messageListRef.current
      if (list) {
        list.scrollTop = list.scrollHeight
      }
    }

    scrollToLatestMessage()
    const frameId = window.requestAnimationFrame(() => {
      scrollToLatestMessage()
      window.requestAnimationFrame(scrollToLatestMessage)
    })

    return () => window.cancelAnimationFrame(frameId)
  }, [messageScrollKey, activeTopic?.id])

  useEffect(() => {
    let active = true

    if (!activeTopic || messages.length > 0) {
      setMemoryGreeting(null)
      return () => {
        active = false
      }
    }

    setMemoryGreeting(null)
    void window.emphant
      .getMemoryGreeting()
      .then((greeting) => {
        if (active) setMemoryGreeting(greeting)
      })
      .catch(() => {
        if (active) {
          setMemoryGreeting({
            message:
              '你好！很高兴见到你。你可以告诉我你的姓名、职业、偏好或当前目标，完善个人信息后，我能为你提供更贴合的服务。'
          })
        }
      })

    return () => {
      active = false
    }
  }, [activeTopic, messages.length])

  useEffect(() => {
    let active = true
    const loadProfile = () => {
      void window.emphant
        .getMemoryProfile()
        .then((profile) => {
          if (active) setMemoryProfile(profile)
        })
        .catch(() => undefined)
    }

    loadProfile()
    window.addEventListener('emphant:profile-updated', loadProfile)
    return () => {
      active = false
      window.removeEventListener('emphant:profile-updated', loadProfile)
    }
  }, [])

  const handleSend = async () => {
    const content = draft.trim()
    if (!content || !activeTopic || isGenerating) {
      return
    }

    dispatch(sendUserMessage({ topicId: activeTopic.id, content }))

    const confirmMailDraft = (draft: MailDraft) =>
      new Promise<boolean>((resolve) => {
        modalApi.confirm({
          title: draft.mode === 'reply' ? '确认回复邮件' : '确认发送邮件',
          okText: '确认发送',
          cancelText: '继续编辑',
          width: 680,
          content: (
            <Space direction="vertical" size={12} className="mail-draft-confirm">
	              <Typography.Text type="secondary">
	                邮件会发往外部收件箱。发送前请确认收件人、主题和正文。
	              </Typography.Text>
              {draft.intent && (
                <Alert
                  type={draft.intent.risk === 'high' ? 'warning' : 'info'}
                  showIcon
                  message={`结构化意图：${draft.mode === 'reply' ? '回复邮件' : '发送邮件'} · 置信度 ${Math.round(
                    draft.intent.confidence * 100
                  )}%`}
                  description={draft.intent.reason}
                />
              )}
	              {draft.sourceLabel && (
                <Typography.Text>
                  <strong>来源：</strong>{draft.sourceLabel}
                </Typography.Text>
              )}
              <Typography.Text>
                <strong>发件邮箱：</strong>{draft.accountAddress}
              </Typography.Text>
              <Typography.Text>
                <strong>收件人：</strong>{draft.to}
              </Typography.Text>
              <Typography.Text>
                <strong>主题：</strong>{draft.subject}
              </Typography.Text>
              <Input.TextArea
                readOnly
                value={draft.text}
                autoSize={{ minRows: 6, maxRows: 12 }}
              />
            </Space>
          ),
          onOk: () => resolve(true),
          onCancel: () => resolve(false)
        })
      })

    const intentPlan = planWorkbenchIntent({
      content,
      selectedAssistantIds,
      hasSourceMail: Boolean(activeTopic.sourceMailId)
    })

    if (intentPlan.kind === 'todo.create') {
      await dispatch(
        createTodoItemsFromWorkbench({
          topicId: activeTopic.id,
          prompt: content
        })
      ).unwrap()
      setDraft('')
      return
    }

    if (intentPlan.kind === 'mail.reply' && activeTopic.sourceMailId) {
      const sourceMail = mailNotifications.find(
        (mail) => mail.id === activeTopic.sourceMailId
      )
      if (!sourceMail) {
        void messageApi.error('未找到这封邮件的来源信息')
        return
      }
      try {
        const draftMail: MailDraft = {
          mode: 'reply',
          accountAddress: sourceMail.accountAddress,
          to: sourceMail.senderEmail,
	          subject: sourceMail.subject.startsWith('Re:')
	            ? sourceMail.subject
	            : `Re: ${sourceMail.subject}`,
	          text: intentPlan.parameters.body ?? content,
	          inReplyTo: sourceMail.messageId,
	          sourceLabel: `${sourceMail.sender} · ${sourceMail.subject}`,
            intent: {
              confidence: intentPlan.confidence,
              risk: intentPlan.risk,
              reason: intentPlan.reason
            }
	        }
        if (!(await confirmMailDraft(draftMail))) {
          return
        }
        await window.emphant.sendEmail(draftMail)
        dispatch(
          processMailTask({
            topicId: activeTopic.id,
            instruction: content
          })
        )
      } catch (error) {
        void messageApi.error(error instanceof Error ? error.message : '邮件回复失败')
      }
      setDraft('')
      return
    }

    if (intentPlan.kind === 'mail.send' && intentPlan.parameters.recipient) {
      try {
	        const draftMail: MailDraft = {
	          mode: 'new',
	          accountAddress: mailAgentSettings.accountEmail || '',
	          to: intentPlan.parameters.recipient,
	          subject: intentPlan.parameters.subject ?? '来自 Emphant Studio 的邮件',
	          text: intentPlan.parameters.body ?? content,
            intent: {
              confidence: intentPlan.confidence,
              risk: intentPlan.risk,
              reason: intentPlan.reason
            }
	        }
        if (!(await confirmMailDraft(draftMail))) {
          return
        }
        await window.emphant.sendEmail(draftMail)
        dispatch(
	          sendMailFromWorkbench({
	            topicId: activeTopic.id,
	            recipient: intentPlan.parameters.recipient,
	            instruction: content
	          })
	        )
      } catch (error) {
        void messageApi.error(error instanceof Error ? error.message : '邮件发送失败')
      }
      setDraft('')
      return
    }

    if (intentPlan.kind === 'mail.summary') {
      try {
        const result = await window.emphant.checkAllEmailAccounts()
        dispatch(applyMailCheckResult(result))
        if (result.checkedAccounts.length === 0) {
          void messageApi.warning('请先在个人资料里添加邮箱，并完成收发信授权')
          setDraft('')
          return
        }
        if (result.errors.length > 0 && result.messages.length === 0) {
          void messageApi.error(result.errors[0]?.message || '未读邮件检查失败')
          setDraft('')
          return
        }
        dispatch(
          sendAssistantReply({
            topicId: activeTopic.id,
            assistantId: 'assistant-mail',
            prompt: content
          })
        )
      } catch (error) {
        dispatch(
          addMailCheckErrorNotification({
            message: error instanceof Error ? error.message : '未读邮件检查失败'
          })
        )
      }
      setDraft('')
      return
    }

    const targetAssistantIds =
      selectedAssistantIds.length === 0 || selectedAssistantIds.includes('assistant-main')
        ? [undefined]
        : selectedAssistantIds
    targetAssistantIds.forEach((assistantId) => {
      dispatch(
        sendAssistantReply({
          topicId: activeTopic.id,
          assistantId,
          prompt: content
        })
      )
    })
    setDraft('')
  }

  const handleStop = () => {
    if (!activeTopic || !isGenerating) {
      return
    }
    void dispatch(stopAssistantReplies(activeTopic.id))
  }

  const handleSelectWorkspaceDirectory = async () => {
    if (!activeTopic) {
      return
    }
    try {
      const directory = await window.emphant.selectWorkspaceDirectory(
        activeWorkspaceDirectory || undefined
      )
      if (!directory) {
        return
      }
      dispatch(
        updateTopicWorkspaceDirectory({
          topicId: activeTopic.id,
          workspaceDirectory: directory
        })
      )
      void messageApi.success('当前会话工作目录已更新')
    } catch (error) {
      void messageApi.error(
        error instanceof Error && error.message.includes('No handler registered')
          ? '主进程尚未加载目录选择功能，请重启应用后再试'
          : error instanceof Error
            ? error.message
            : '无法选择工作目录'
      )
    }
  }

  const getMessageContent = (messageId: string) => {
    const targetMessage = messages.find((item) => item.id === messageId)
    return (
      targetMessage?.blocks
        .map((block) => (block.title ? `${block.title}\n${block.content}` : block.content))
        .filter(Boolean)
        .join('\n\n')
        .trim() ?? ''
    )
  }

  const getRetryPrompt = (messageId: string) => {
    const messageIndex = messages.findIndex((item) => item.id === messageId)
    if (messageIndex <= 0) {
      return ''
    }

    for (let index = messageIndex - 1; index >= 0; index -= 1) {
      const previousMessage = messages[index]
      if (previousMessage.role === 'user') {
        return previousMessage.blocks
          .filter((block) => block.type === 'text')
          .map((block) => block.content)
          .join('\n\n')
          .trim()
      }
    }

    return ''
  }

  const handleRetryMessage = (messageId: string) => {
    const targetMessage = messages.find((item) => item.id === messageId)
    const prompt = getRetryPrompt(messageId)
    if (!activeTopic || !targetMessage || !prompt || isGenerating) {
      return
    }

    const assistantId = assistants.find(
      (assistant) => assistant.name === targetMessage.assistantName
    )?.id

    dispatch(
      sendAssistantReply({
        topicId: activeTopic.id,
        assistantId: assistantId === 'assistant-main' ? undefined : assistantId,
        prompt
      })
    )
  }

  const handleReviseApproval = ({
    messageId,
    approvalBlockId,
    runId,
    approvalId,
    instruction,
    assistantName
  }: {
    messageId: string
    approvalBlockId: string
    runId: string
    approvalId: string
    instruction: string
    assistantName?: string
  }) => {
    if (!activeTopic || isGenerating) {
      return
    }

    const assistantId = assistants.find((assistant) => assistant.name === assistantName)?.id
    const prompt = instruction.trim()
    if (!prompt) {
      return
    }

    dispatch(
      respondToAgentApproval({
        messageId,
        approvalBlockId,
        runId,
        approvalId,
        approved: false,
        approvalState: 'revised',
        reason: `用户选择修改后执行：${prompt}`
      })
    )
    dispatch(sendUserMessage({ topicId: activeTopic.id, content: prompt }))
    dispatch(
      sendAssistantReply({
        topicId: activeTopic.id,
        assistantId: assistantId === 'assistant-main' ? undefined : assistantId,
        prompt
      })
    )
  }

  const handleCopyMessage = async (messageId: string) => {
    const content = getMessageContent(messageId)
    if (!content) {
      return
    }

    try {
      if (window.emphant?.copyText) {
        await window.emphant.copyText(content)
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = content
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        const copied = document.execCommand('copy')
        textarea.remove()
        if (!copied) {
          throw new Error('Clipboard API unavailable')
        }
      }
      void messageApi.success('回答已复制')
    } catch {
      void messageApi.error('复制失败，请稍后重试')
    }
  }

  const handleAddToNotes = (messageId: string) => {
    const alreadyAdded = systemNotes.some((note) => note.sourceMessageId === messageId)
    dispatch(addMessageToSystemNotes({ messageId }))
    void messageApi.success(alreadyAdded ? '该回答已在系统笔记中' : '已添加到系统笔记')
  }

  const stopRecordingStream = () => {
    audioProcessorRef.current?.disconnect()
    audioSourceRef.current?.disconnect()
    void audioContextRef.current?.close()
    audioProcessorRef.current = null
    audioSourceRef.current = null
    audioContextRef.current = null
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop())
    recordingStreamRef.current = null
    mediaRecorderRef.current = null
  }

  const preferredRecordingMimeType = () =>
    typeof MediaRecorder === 'undefined'
      ? undefined
      : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((mimeType) =>
          MediaRecorder.isTypeSupported(mimeType)
    )

  const transcribeRecordedAudio = async (audioBlob: Blob, mimeType: string) => {
    setIsTranscribing(true)
    try {
      const buffer = await audioBlob.arrayBuffer()
      const text = await window.emphant.transcribeAudio({
        provider: asrProvider!,
        model: settings.defaultAsrModel || '',
        fileName: mimeType.includes('wav')
          ? 'voice-input.wav'
          : mimeType.includes('mp4')
            ? 'voice-input.mp4'
            : 'voice-input.webm',
        mimeType,
        sampleRate: mimeType.includes('wav') ? audioSampleRateRef.current : undefined,
        bytes: new Uint8Array(buffer)
      })
      const trimmed = text.trim()
      if (!trimmed) {
        void messageApi.warning('没有识别到有效语音')
        return
      }
      setDraft((current) => (current.trim() ? `${current.trim()}\n${trimmed}` : trimmed))
    } catch (error) {
      logAudioError('transcribe recorded audio failed', error, {
        providerId: asrProvider?.id,
        providerName: asrProvider?.name,
        model: settings.defaultAsrModel || '',
        mimeType,
        blobSize: audioBlob.size
      })
      void messageApi.error(error instanceof Error ? error.message : '语音识别失败')
    } finally {
      setIsTranscribing(false)
    }
  }

  const stopAudioContextRecording = () => {
    const chunks = audioSampleChunksRef.current
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const samples = new Float32Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      samples.set(chunk, offset)
      offset += chunk.length
    }
    stopRecordingStream()
    setIsRecording(false)
    audioSampleChunksRef.current = []
    if (samples.length === 0) {
      void messageApi.warning('没有录到有效音频')
      return
    }
    const wavBuffer = encodeWav(samples, audioSampleRateRef.current)
    void transcribeRecordedAudio(new Blob([wavBuffer], { type: 'audio/wav' }), 'audio/wav')
  }

  const handleToggleRecording = async () => {
    if (isRecording) {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop()
      } else {
        stopAudioContextRecording()
      }
      return
    }

    if (isTranscribing) {
      return
    }

    if (!asrProvider || !settings.defaultAsrModel) {
      logAudioError('recording blocked by missing ASR configuration', new Error('Missing ASR configuration'), {
        providerId: settings.defaultAsrProviderId,
        model: settings.defaultAsrModel || ''
      })
      void messageApi.error('请先在设置中启用语音识别模型')
      return
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      logAudioError('recording blocked by unsupported media devices', new Error('getUserMedia unavailable'), {
        hasNavigatorMediaDevices: Boolean(navigator.mediaDevices),
        hasGetUserMedia: Boolean(navigator.mediaDevices?.getUserMedia),
        hasMediaRecorder: typeof MediaRecorder !== 'undefined'
      })
      void messageApi.error('当前环境不支持麦克风录音')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = preferredRecordingMimeType()
      const useWavRecording = isDashScopeAudioModel(asrProvider, settings.defaultAsrModel || '')
      const recorder =
        useWavRecording || typeof MediaRecorder === 'undefined'
          ? null
          : mimeType
            ? new MediaRecorder(stream, { mimeType })
            : new MediaRecorder(stream)

      audioChunksRef.current = []
      recordingStreamRef.current = stream
      if (!recorder) {
        const AudioContextConstructor =
          window.AudioContext ||
          (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!AudioContextConstructor) {
          throw new Error('当前环境不支持音频采集')
        }
        const audioContext = new AudioContextConstructor()
        const source = audioContext.createMediaStreamSource(stream)
        const processor = audioContext.createScriptProcessor(4096, 1, 1)
        audioSampleChunksRef.current = []
        audioSampleRateRef.current = audioContext.sampleRate
        processor.onaudioprocess = (event) => {
          audioSampleChunksRef.current.push(
            new Float32Array(event.inputBuffer.getChannelData(0))
          )
        }
        source.connect(processor)
        processor.connect(audioContext.destination)
        audioContextRef.current = audioContext
        audioSourceRef.current = source
        audioProcessorRef.current = processor
        setIsRecording(true)
        return
      }
      mediaRecorderRef.current = recorder
      recorder.onerror = (event) => {
        logAudioError('media recorder emitted error', event, {
          mimeType: recorder.mimeType,
          state: recorder.state
        })
      }
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }
      recorder.onstop = () => {
        setIsRecording(false)
        const recordedType =
          recorder.mimeType || audioChunksRef.current[0]?.type || 'audio/webm'
        const audioBlob = new Blob(audioChunksRef.current, { type: recordedType })
        stopRecordingStream()
        void transcribeRecordedAudio(audioBlob, recordedType)
      }
      recorder.start()
      setIsRecording(true)
    } catch (error) {
      stopRecordingStream()
      setIsRecording(false)
      logAudioError('toggle recording failed', error, {
        providerId: asrProvider?.id,
        providerName: asrProvider?.name,
        model: settings.defaultAsrModel || '',
        hasNavigatorMediaDevices: Boolean(navigator.mediaDevices),
        hasGetUserMedia: Boolean(navigator.mediaDevices?.getUserMedia),
        hasMediaRecorder: typeof MediaRecorder !== 'undefined',
        preferredMimeType: preferredRecordingMimeType()
      })
      void messageApi.error(error instanceof Error ? error.message : '无法访问麦克风')
    }
  }

  const clearSpeechPlaybackAudio = (resolveCurrentPlayback = false) => {
    if (resolveCurrentPlayback) {
      audioPlaybackResolveRef.current?.()
      audioPlaybackResolveRef.current = null
    }
    audioPlaybackRef.current?.pause()
    audioPlaybackRef.current = null
    if (audioPlaybackUrlRef.current) {
      URL.revokeObjectURL(audioPlaybackUrlRef.current)
      audioPlaybackUrlRef.current = null
    }
  }

  const stopSpeechPlayback = () => {
    speechPlaybackRunRef.current += 1
    clearSpeechPlaybackAudio(true)
    setSpeakingMessageId(null)
  }

  const handleSpeakMessage = async (messageId: string) => {
    if (speakingMessageId === messageId) {
      stopSpeechPlayback()
      return
    }

    const text = getMessageContent(messageId)
    const speechSegments = splitTextForSpeech(text)
    if (!speechSegments.length) {
      return
    }

    if (!ttsProvider || !settings.defaultTtsModel) {
      logAudioError('speech playback blocked by missing TTS configuration', new Error('Missing TTS configuration'), {
        providerId: settings.defaultTtsProviderId,
        model: settings.defaultTtsModel || '',
        messageId
      })
      void messageApi.error('请先在设置中启用语音朗读模型')
      return
    }

    stopSpeechPlayback()
    const playbackRunId = speechPlaybackRunRef.current + 1
    speechPlaybackRunRef.current = playbackRunId
    setSpeakingMessageId(messageId)
    try {
      const audioMimeType = isDashScopeAudioModel(ttsProvider, settings.defaultTtsModel)
        ? 'audio/wav'
        : 'audio/mpeg'

      for (const speechSegment of speechSegments) {
        if (speechPlaybackRunRef.current !== playbackRunId) {
          return
        }

        const bytes = await window.emphant.synthesizeSpeech({
          provider: ttsProvider,
          model: settings.defaultTtsModel,
          text: speechSegment,
          voice: 'alloy',
          format: 'mp3'
        })

        if (speechPlaybackRunRef.current !== playbackRunId) {
          return
        }

        await new Promise<void>((resolve, reject) => {
          clearSpeechPlaybackAudio()
          const audioBuffer = new ArrayBuffer(bytes.byteLength)
          new Uint8Array(audioBuffer).set(bytes)
          const url = URL.createObjectURL(new Blob([audioBuffer], { type: audioMimeType }))
          const audio = new Audio(url)
          audioPlaybackRef.current = audio
          audioPlaybackUrlRef.current = url
          audioPlaybackResolveRef.current = resolve
          audio.onended = () => {
            audioPlaybackResolveRef.current = null
            clearSpeechPlaybackAudio()
            resolve()
          }
          audio.onerror = (event) => {
            logAudioError('audio element playback failed', event, {
              providerId: ttsProvider.id,
              providerName: ttsProvider.name,
              model: settings.defaultTtsModel,
              messageId,
              textLength: speechSegment.length,
              audioBytes: bytes.byteLength,
              mediaErrorCode: audio.error?.code,
              mediaErrorMessage: audio.error?.message
            })
            audioPlaybackResolveRef.current = null
            clearSpeechPlaybackAudio()
            reject(new Error('朗读播放失败'))
          }
          void audio.play().catch(reject)
        })
      }

      if (speechPlaybackRunRef.current === playbackRunId) {
        clearSpeechPlaybackAudio()
        setSpeakingMessageId(null)
      }
    } catch (error) {
      stopSpeechPlayback()
      logAudioError('speak message failed', error, {
        providerId: ttsProvider.id,
        providerName: ttsProvider.name,
        model: settings.defaultTtsModel,
        messageId,
        textLength: text.length
      })
      void messageApi.error(error instanceof Error ? error.message : '语音合成失败')
    }
  }

  const handleCreateTopic = () => {
    dispatch(createTopic())
  }

  const handleTopicMenu = (topic: { id: string; title: string }, key: string) => {
    if (key === 'rename') {
      setRenameTopicId(topic.id)
      renameForm.setFieldsValue({ title: topic.title })
      return
    }

    if (key === 'delete') {
      modalApi.confirm({
        title: `删除会话 ${topic.title}？`,
        content: '会话中的全部消息也会一并删除，且无法恢复。',
        okText: '删除',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: () => {
          dispatch(deleteTopic(topic.id))
          void messageApi.success('会话已删除')
        }
      })
    }
  }

  return (
    <section
      className={
        isTopicListVisible
          ? 'workspace-grid workspace-grid--chat'
          : 'workspace-grid workspace-grid--chat is-topic-list-hidden'
      }
    >
      {isTopicListVisible && (
        <Card className="workspace-panel workspace-panel--rail" bordered={false}>
          <div className="panel-header topic-panel-header">
            <div className="topic-panel-header__bar">
              <Typography.Title level={5}>会话</Typography.Title>
              <Button
                type="text"
                icon={<PlusOutlined />}
                onClick={handleCreateTopic}
              >
              </Button>
            </div>
          </div>
          <div className="topic-list">
            {topics.map((topic) => {
              const isActive = topic.id === activeTopic?.id

              return (
                <Dropdown
                  key={topic.id}
                  trigger={['contextMenu']}
                  menu={{
                    items: topicMenuItems,
                    onClick: ({ key }) => handleTopicMenu(topic, key)
                  }}
                >
                  <div className={isActive ? 'topic-list__item is-active' : 'topic-list__item'}>
                    <button
                      className="topic-list__main"
                      onClick={() => dispatch(setActiveTopic(topic.id))}
                      type="button"
                      aria-current={isActive ? 'true' : undefined}
                      aria-label={`${topic.title}，右键打开会话菜单`}
                    >
                      <strong>{topic.title}</strong>
                      <span>{new Date(topic.updatedAt).toLocaleString()}</span>
                    </button>
                    <Dropdown
                      trigger={['click']}
                      menu={{
                        items: topicMenuItems,
                        onClick: ({ key, domEvent }) => {
                          domEvent.stopPropagation()
                          handleTopicMenu(topic, key)
                        }
                      }}
                    >
                      <Button
                        type="text"
                        size="small"
                        className="topic-list__more"
                        aria-label={`管理会话 ${topic.title}`}
                        icon={<MoreOutlined />}
                        onClick={(event) => event.stopPropagation()}
                      />
                    </Dropdown>
                  </div>
                </Dropdown>
              )
            })}
          </div>
        </Card>
      )}

      <div className="chat-stage">
        <Card className="workspace-panel chat-panel" bordered={false}>
          {workbenchWarnings.length > 0 && (
            <Alert
              type="warning"
              showIcon
              className="workbench-readiness-alert"
              message="执行能力还没准备好"
              description={workbenchWarnings.join(' ')}
              action={
                <Button size="small" onClick={() => navigate('/settings')}>
                  打开设置
                </Button>
              }
            />
          )}
          <section className="conversation-context" aria-label="当前会话上下文">
            <div className="conversation-context__main">
              <div>
                <span className="conversation-context__eyebrow">会话上下文</span>
                <strong>{activeTopic?.title ?? '未选择会话'}</strong>
              </div>
              <Space size={8} wrap>
                {activeMailSource && <Tag color="blue">来自邮件</Tag>}
                <Tag color={settings.openClawCore?.requireToolApproval ? 'green' : 'orange'}>
                  {settings.openClawCore?.requireToolApproval ? '高风险需确认' : '执行确认关闭'}
                </Tag>
                {pendingApprovalCount > 0 && <Tag color="red">待确认 {pendingApprovalCount}</Tag>}
              </Space>
            </div>
            <div className="conversation-context__grid">
              {contextSummaryItems.map((item) => (
                <div key={item.label} className="conversation-context__item">
                  <span>{item.label}</span>
                  <strong title={item.value}>{item.value}</strong>
                </div>
              ))}
            </div>
          </section>
          <div className="message-list" ref={messageListRef}>
            {activeTopic && messages.length === 0 && memoryGreeting && (
              <section className="conversation-greeting" aria-live="polite">
                <span className="conversation-greeting__eyebrow">Emphant Studio</span>
                <Typography.Title level={2}>
                  {memoryGreeting.userName
                    ? `你好，${memoryGreeting.userName}`
                    : '你好，很高兴见到你'}
                </Typography.Title>
                <Typography.Paragraph>
                  {memoryGreeting.message.replace(
                    memoryGreeting.userName
                      ? `你好，${memoryGreeting.userName}！很高兴见到你。`
                      : '你好！很高兴见到你。',
                    ''
                  )}
                </Typography.Paragraph>
              </section>
            )}
	            {messages.map((message) => {
	              const assistantDisplayName =
	                memoryProfile?.assistantProfile?.name || message.assistantName || 'AI 助理'
              const visualStatus = getMessageVisualStatus(message.blocks)
	              return (
	                <article key={message.id} className={`message-bubble role-${message.role}`}>
	                  <div className="message-bubble__content">
	                    {message.role === 'assistant' && (
	                      <header>
	                        <strong>{assistantDisplayName}</strong>
                        <Tag color={visualStatus.color}>{visualStatus.label}</Tag>
	                        {memoryProfile?.assistantProfile?.name &&
                          message.assistantName &&
                          message.assistantName !== memoryProfile.assistantProfile.name && (
                            <span>{message.assistantName}</span>
                          )}
                      </header>
                    )}
                    {message.blocks.map((block) => {
                      const isToolResult =
                        block.type === 'tool' && block.meta?.approvalState !== 'pending'

                  if (
                    block.meta?.approvalState === 'pending' &&
                    block.meta.runId &&
                    block.meta.approvalId
                  ) {
                    return (
                      <ApprovalRequestCard
                        key={block.id}
                        block={block}
                        assistantName={message.assistantName ?? assistantDisplayName}
                        onDeny={() =>
                          dispatch(
                            respondToAgentApproval({
                              messageId: message.id,
                              approvalBlockId: block.id,
                              runId: block.meta!.runId,
                              approvalId: block.meta!.approvalId,
                              approved: false
                            })
                          )
                        }
                        onApprove={() =>
                          dispatch(
                            respondToAgentApproval({
                              messageId: message.id,
                              approvalBlockId: block.id,
                              runId: block.meta!.runId,
                              approvalId: block.meta!.approvalId,
                              approved: true
                            })
                          )
                        }
                        onRevise={(instruction) =>
                          handleReviseApproval({
                            messageId: message.id,
                            approvalBlockId: block.id,
                            runId: block.meta!.runId,
                            approvalId: block.meta!.approvalId,
                            instruction,
                            assistantName: message.assistantName
                          })
                        }
                      />
                    )
                  }

                  if (isToolResult) {
                    return <ToolResult key={block.id} block={block} />
                  }

                  if (block.type === 'reference') {
                    const referenceTitle = [
                      block.meta?.knowledgeBaseName,
                      block.meta?.fileName
                    ].filter(Boolean).join('・')

                    return (
                      <details key={block.id} className="message-block block-reference">
                        <summary className="reference-summary">
                          <RightOutlined className="reference-summary__icon" />
                          <strong className="message-block__title">
                            原文依据
                          </strong>
                          {referenceTitle && (
                            <span className="reference-summary__source">
                              {referenceTitle}
                            </span>
                          )}
                        </summary>
                        <div className="message-markdown reference-content">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            rehypePlugins={[[rehypeHighlight, { detect: true }]]}
                            components={messageMarkdownComponents}
                          >
                            {block.content}
                          </ReactMarkdown>
                        </div>
                      </details>
                    )
                  }

                  return (
                    <div key={block.id} className={`message-block block-${block.type}`}>
                      {block.title && (
                        <strong className="message-block__title">
                          {block.title}
                          {block.meta?.simulated === 'true' && (
                            <Tag color="orange">模拟内容</Tag>
                          )}
                        </strong>
                      )}
                      <div className="message-markdown">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          rehypePlugins={[[rehypeHighlight, { detect: true }]]}
                          components={messageMarkdownComponents}
                        >
                          {block.content}
                        </ReactMarkdown>
                        {block.status === 'streaming' && (
                          <span className="message-stream-cursor" aria-label="正在生成" />
                        )}
                      </div>
                    </div>
                  )
                  })}
                  {message.role === 'assistant' && (
                    <footer className="message-actions">
                    <Tooltip
                      title="重新生成"
                      classNames={{ root: 'message-action-tooltip' }}
                    >
                      <Button
                        type="text"
                        size="small"
                        aria-label="重新生成"
                        icon={<ReloadOutlined />}
                        disabled={
                          isGenerating ||
                          message.blocks.some((block) => block.status === 'streaming') ||
                          !getRetryPrompt(message.id)
                        }
                        onClick={() => handleRetryMessage(message.id)}
                      />
                    </Tooltip>
                    <Tooltip
                      title="复制回答"
                      classNames={{ root: 'message-action-tooltip' }}
                    >
                      <Button
                        type="text"
                        size="small"
                        aria-label="复制回答"
                        icon={<CopyOutlined />}
                        disabled={message.blocks.some((block) => block.status === 'streaming')}
                        onClick={() => void handleCopyMessage(message.id)}
                      />
                    </Tooltip>
                    <Tooltip
                      title={speakingMessageId === message.id ? '停止朗读' : '朗读回答'}
                      classNames={{ root: 'message-action-tooltip' }}
                    >
                      <Button
                        type="text"
                        size="small"
                        aria-label={speakingMessageId === message.id ? '停止朗读' : '朗读回答'}
                        className={speakingMessageId === message.id ? 'is-active' : undefined}
                        icon={<SoundOutlined />}
                        disabled={message.blocks.some((block) => block.status === 'streaming')}
                        onClick={() => void handleSpeakMessage(message.id)}
                      />
                    </Tooltip>
                    <Tooltip
                      classNames={{ root: 'message-action-tooltip' }}
                      title={
                        systemNotes.some((note) => note.sourceMessageId === message.id)
                          ? '已添加到系统笔记'
                          : '添加到系统笔记'
                      }
                    >
                      <Button
                        type="text"
                        size="small"
                        aria-label="添加到系统笔记"
                        className={
                          systemNotes.some((note) => note.sourceMessageId === message.id)
                            ? 'is-active'
                            : undefined
                        }
                        icon={
                          systemNotes.some((note) => note.sourceMessageId === message.id) ? (
                            <CheckOutlined />
                          ) : (
                            <FileAddOutlined />
                          )
                        }
                        disabled={message.blocks.some((block) => block.status === 'streaming')}
                        onClick={() => handleAddToNotes(message.id)}
                      />
                    </Tooltip>
                    <MessageRunDetails message={message} />
                    </footer>
                  )}
                </div>
              </article>
              )
            })}
          </div>
        </Card>

        <div className="message-composer">
          <Input.TextArea
            className="message-composer__input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void handleSend()
              }
            }}
            autoSize={false}
            placeholder="输入你的目标、问题或要处理的任务，按 Enter 发送"
          />
          <div className="message-composer__toolbar">
            <Space size={14} className="message-composer__tools">
              <Tooltip title={isTopicListVisible ? '隐藏会话列表' : '显示会话列表'}>
                <Button
                  type="text"
                  className="message-composer__topic-toggle"
                  aria-label={isTopicListVisible ? '隐藏会话列表' : '显示会话列表'}
                  aria-expanded={isTopicListVisible}
                  icon={
                    isTopicListVisible ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />
                  }
                  onClick={() => setIsTopicListVisible((visible) => !visible)}
                />
              </Tooltip>
              <Tooltip title={activeWorkspaceDirectory || '未选择工作目录'}>
                <Button
                  type="text"
                  className="message-composer__workspace"
                  aria-label={
                    activeWorkspaceDirectory
                      ? `当前会话工作目录：${activeWorkspaceDirectory}`
                      : '选择当前会话工作目录'
                  }
                  icon={<FolderOpenOutlined />}
                  disabled={!activeTopic}
                  onClick={() => void handleSelectWorkspaceDirectory()}
                >
                  {activeWorkspaceName}
                </Button>
              </Tooltip>
              <Popover
                trigger="click"
                placement="top"
                content={
                  <Select
                    mode="multiple"
                    placeholder="默认由意图识别自动调度"
                    value={selectedAssistantIds}
                    options={assistantOptions}
                    onChange={(values) => {
                      const lastSelected = values.at(-1)
                      const nextValues =
                        lastSelected === 'assistant-main'
                          ? ['assistant-main']
                          : values.filter((value) => value !== 'assistant-main')
                      if (activeTopic) {
                        dispatch(
                          updateTopicAssistantIds({
                            topicId: activeTopic.id,
                            assistantIds: nextValues
                          })
                        )
                      }
                    }}
                    style={{ width: 280 }}
                  />
                }
              >
                <Button type="text" aria-label="提及" className="message-composer__at">
                  @
                </Button>
              </Popover>
              {selectedAssistantNames.length > 0 && (
                <div className="message-composer__selected-agents" aria-label="已选择的智能体">
                  {selectedAssistantNames.map((name) => (
                    <span key={name} className="message-composer__agent-tag" title={name}>
                      {name}
                    </span>
                  ))}
                </div>
              )}
            </Space>
            <Space size={14} className="message-composer__actions">
              <Tooltip title={isRecording ? '停止录音并识别' : '语音输入'}>
                <Button
                  type="text"
                  aria-label={isRecording ? '停止录音并识别' : '语音输入'}
                  className={isRecording ? 'message-composer__voice is-recording' : 'message-composer__voice'}
                  icon={<AudioOutlined />}
                  loading={isTranscribing}
                  disabled={!activeTopic || isGenerating}
                  onClick={() => void handleToggleRecording()}
                />
              </Tooltip>
              <Button
                aria-label={isGenerating ? '停止生成' : '发送'}
                className={
                  isGenerating
                    ? 'message-composer__send is-stopping'
                    : 'message-composer__send'
                }
                disabled={!isGenerating && (!draft.trim() || !activeTopic)}
                icon={isGenerating ? <BorderOutlined /> : <ArrowUpOutlined />}
                onClick={isGenerating ? handleStop : () => void handleSend()}
              />
            </Space>
          </div>
        </div>
      </div>

      <Modal
        open={Boolean(renameTopicId)}
        title="重命名会话"
        onCancel={() => setRenameTopicId(null)}
        onOk={async () => {
          const values = await renameForm.validateFields()
          if (renameTopicId) {
            dispatch(renameTopic({ topicId: renameTopicId, title: values.title }))
          }
          setRenameTopicId(null)
        }}
      >
        <Form form={renameForm} layout="vertical">
          <Form.Item label="会话名称" name="title" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </section>
  )
}
