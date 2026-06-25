import {
  ArrowUpOutlined,
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
  PlusSquareOutlined,
  ReloadOutlined,
  RightOutlined,
  RobotOutlined,
  ToolOutlined,
  TranslationOutlined,
  UserOutlined
} from '@ant-design/icons'
import {
  App,
  Avatar,
  Button,
  Card,
  Dropdown,
  Form,
  Input,
  Modal,
  Popover,
  Select,
  Space,
  Tooltip,
  Typography
} from 'antd'
import type { MenuProps } from 'antd'
import { Fragment, isValidElement, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import type { MemoryGreeting, MemoryProfile, MessageBlock } from '@emphant/shared/types'
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
  selectMailAgentSettings,
  selectMailNotifications,
  selectMessagesForActiveTopic,
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

const MarkdownCodeBlock = ({
  children,
  ...props
}: ComponentPropsWithoutRef<'pre'>) => {
  const { message: messageApi } = App.useApp()

  const handleCopy = async () => {
    const code = getCodeText(children).replace(/\n$/, '')
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

const extractMailBody = (instruction: string, recipient?: string) => {
  const withoutRecipient = recipient
    ? instruction.replace(recipient, ' ')
    : instruction
  const explicitBody = withoutRecipient.match(
    /(?:正文|内容|回复(?:对方)?|告诉(?:他|她|对方)?|说)[：:，,\s]*(.+)$/s
  )?.[1]
  return (explicitBody ?? withoutRecipient)
    .replace(/^(?:请)?(?:给|向)\s*/u, '')
    .replace(/^(?:发|发送|写|回复)(?:一封)?(?:邮件|信)?[：:，,\s]*/u, '')
    .trim()
}

const extractMailSubject = (instruction: string) =>
  instruction.match(/主题[为是：:\s]+([^，,。；;\n]+)/u)?.[1]?.trim() ||
  '来自 Emphant Studio 的邮件'

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

export const HomePage = () => {
  const dispatch = useAppDispatch()
  const { message: messageApi, modal: modalApi } = App.useApp()
  const assistants = useAppSelector(selectAssistants)
  const topics = useAppSelector(selectTopics)
  const activeTopic = useAppSelector(selectActiveTopic)
  const mailAgentSettings = useAppSelector(selectMailAgentSettings)
  const mailNotifications = useAppSelector(selectMailNotifications)
  const messages = useAppSelector(selectMessagesForActiveTopic)
  const systemNotes = useAppSelector(selectSystemNotes)
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
  const selectedAssistantIds = activeTopic?.assistantIds ?? []
  const isGenerating = messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.blocks.some((block) => block.status === 'streaming')
  )
  const [renameTopicId, setRenameTopicId] = useState<string | null>(null)
  const [renameForm] = Form.useForm<{ title: string }>()
  const messageListRef = useRef<HTMLDivElement | null>(null)
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
      selectedAssistantIds.flatMap((id) => {
        const assistant = assistants.find((item) => item.id === id)
        return assistant ? [assistant.name] : []
      }),
    [assistants, selectedAssistantIds]
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

    const isTodoAssistantSelected = selectedAssistantIds.includes('assistant-todo')
    const isMailAssistantSelected = selectedAssistantIds.includes('assistant-mail')
    if (isTodoAssistantSelected) {
      await dispatch(
        createTodoItemsFromWorkbench({
          topicId: activeTopic.id,
          prompt: content
        })
      ).unwrap()
      setDraft('')
      return
    }

    if (activeTopic.sourceMailId) {
      const sourceMail = mailNotifications.find(
        (mail) => mail.id === activeTopic.sourceMailId
      )
      if (!sourceMail) {
        void messageApi.error('未找到这封邮件的来源信息')
        return
      }
      try {
        await window.emphant.sendEmail({
          accountAddress: sourceMail.accountAddress,
          to: sourceMail.senderEmail,
          subject: sourceMail.subject.startsWith('Re:')
            ? sourceMail.subject
            : `Re: ${sourceMail.subject}`,
          text: extractMailBody(content),
          inReplyTo: sourceMail.messageId
        })
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

    const recipient = content.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]
    const isSendMailIntent =
      Boolean(recipient) &&
      /(发|发送|写|寄).{0,12}(邮件|信)|(邮件|信).{0,12}(给|到)/.test(content)

    if (recipient && isSendMailIntent && isMailAssistantSelected) {
      if (!mailAgentSettings.accountEmail) {
        void messageApi.error('请先在邮件助手 Agent 中选择默认发件邮箱')
        return
      }
      try {
        await window.emphant.sendEmail({
          accountAddress: mailAgentSettings.accountEmail,
          to: recipient,
          subject: extractMailSubject(content),
          text: extractMailBody(content, recipient)
        })
        dispatch(
          sendMailFromWorkbench({
            topicId: activeTopic.id,
            recipient,
            instruction: content
          })
        )
      } catch (error) {
        void messageApi.error(error instanceof Error ? error.message : '邮件发送失败')
      }
      setDraft('')
      return
    }

    const isUnreadMailSummaryIntent =
      /(整理|汇总|总结|查看|分析|分类|摘要).{0,12}(未读)?邮件|(未读)?邮件.{0,12}(整理|汇总|总结|分类|摘要)/.test(
        content
      )
    if (isUnreadMailSummaryIntent && isMailAssistantSelected) {
      try {
        const result = await window.emphant.checkAllEmailAccounts()
        dispatch(applyMailCheckResult(result))
        if (result.checkedAccounts.length === 0) {
          void messageApi.warning('长期记忆中还没有可检查的邮箱')
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

  const activeWorkspaceDirectory = activeTopic?.workspaceDirectory || ''
  const activeWorkspaceName = activeWorkspaceDirectory
    ? activeWorkspaceDirectory.split(/[\\/]/).filter(Boolean).at(-1) || activeWorkspaceDirectory
    : '工作目录'

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
        title: `删除任务 ${topic.title}？`,
        content: '任务中的全部消息也会一并删除，且无法恢复。',
        okText: '删除',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: () => {
          dispatch(deleteTopic(topic.id))
          void messageApi.success('任务已删除')
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
              <Typography.Title level={5}>任务</Typography.Title>
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
                      aria-label={`${topic.title}，右键打开任务菜单`}
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
                        aria-label={`管理任务 ${topic.title}`}
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
              return (
                <article key={message.id} className={`message-bubble role-${message.role}`}>
                  <Avatar
                    className="message-bubble__avatar"
                    size={34}
                    src={
                      message.role === 'assistant'
                        ? memoryProfile?.assistantProfile?.avatarDataUrl
                        : memoryProfile?.avatarDataUrl
                    }
                    icon={
                      message.role === 'assistant' ? (
                        <RobotOutlined />
                      ) : (
                        <UserOutlined />
                      )
                    }
                  />
                  <div className="message-bubble__content">
                    {message.role === 'assistant' && (
                      <header>
                        <strong>{assistantDisplayName}</strong>
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

                  if (isToolResult) {
                    return <ToolResult key={block.id} block={block} />
                  }

                  if (block.type === 'reference') {
                    return (
                      <details key={block.id} className="message-block block-reference">
                        <summary className="reference-summary">
                          <RightOutlined className="reference-summary__icon" />
                          <strong className="message-block__title">
                            {block.title || '引用'}
                          </strong>
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
                        <strong className="message-block__title">{block.title}</strong>
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
                      {block.meta?.approvalState === 'pending' &&
                        block.meta.runId &&
                        block.meta.approvalId && (
                          <Space size={8}>
                            <Button
                              size="small"
                              onClick={() =>
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
                            >
                              拒绝
                            </Button>
                            <Button
                              size="small"
                              type="primary"
                              danger={block.meta.risk === 'high'}
                              onClick={() =>
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
                            >
                              允许一次
                            </Button>
                          </Space>
                        )}
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
            placeholder="在这里输入消息，按 Enter 发送"
          />
          <div className="message-composer__toolbar">
            <Space size={14} className="message-composer__tools">
              <Tooltip title={isTopicListVisible ? '隐藏任务列表' : '显示任务列表'}>
                <Button
                  type="text"
                  className="message-composer__topic-toggle"
                  aria-label={isTopicListVisible ? '隐藏任务列表' : '显示任务列表'}
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
              <Button type="text" aria-label="添加" icon={<PlusSquareOutlined />} />
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
                <div className="message-composer__selected-agents" aria-label="已选择的 Agent">
                  {selectedAssistantNames.map((name) => (
                    <span key={name} className="message-composer__agent-tag" title={name}>
                      {name}
                    </span>
                  ))}
                </div>
              )}
            </Space>
            <Space size={14} className="message-composer__actions">
              <Button type="text" aria-label="翻译" icon={<TranslationOutlined />} />
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
        title="重命名任务"
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
          <Form.Item label="任务名称" name="title" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </section>
  )
}
