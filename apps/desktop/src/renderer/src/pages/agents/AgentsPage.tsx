import {
  MailOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined
} from '@ant-design/icons'
import {
  App,
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tag,
  Typography
} from 'antd'
import { useEffect, useMemo, useState } from 'react'
import type { MemoryEmailAccount } from '@emphant/shared/types'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  addMailCheckErrorNotification,
  createAssistant,
  applyMailCheckResult,
  deleteAssistant,
  selectAssistants,
  selectKnowledgeBases,
  selectMcpTools,
  selectMailAgentSettings,
  selectMailNotifications,
  selectMessages,
  selectProviders,
  selectSettings,
  selectSkills,
  toggleAssistantSkill,
  toggleAssistantKnowledgeBase,
  toggleAssistantTool,
  updateAssistant,
  updateAssistantModel,
  updateMailAgentSettings
} from '@/store/workbenchSlice'

type AssistantFormValues = {
  name: string
  description: string
  providerId: string
  model: string
  systemPrompt: string
  contextLimit: number
}

const assistantTemplates = [
  {
    id: 'strategy',
    name: '产品策略分析',
    description: '适合需求分析、竞品调研、路线图和方案取舍。',
    capabilities: ['需求分析', '策略判断', '结构化输出'],
    knowledgeBaseIds: ['kb-prd', 'kb-design'],
    enabledToolIds: ['tool-search', 'tool-document-extract'],
    enabledSkillIds: ['skill-research', 'skill-analysis'],
    systemPrompt: '你是产品策略分析智能体。先界定问题和用户，再拆解事实、假设、风险和可执行建议。',
    contextLimit: 10,
    riskBoundary: '可联网检索和读取文档，不直接写文件或执行命令。'
  },
  {
    id: 'builder',
    name: '工程实现助手',
    description: '适合代码方案、实现拆解、文件变更建议和验证计划。',
    capabilities: ['代码方案', '工程拆解', '验证计划'],
    knowledgeBaseIds: ['kb-prd'],
    enabledToolIds: ['tool-filesystem', 'tool-file-write', 'tool-file-edit'],
    enabledSkillIds: ['skill-coding', 'skill-command'],
    systemPrompt: '你是工程实现智能体。优先给出边界清晰、可验证、可维护的实现方案；写文件前说明影响。',
    contextLimit: 10,
    riskBoundary: '可能写入工作区文件，高风险动作必须确认。'
  },
  {
    id: 'research',
    name: '研究归纳助手',
    description: '适合资料检索、多来源汇总和证据化结论。',
    capabilities: ['资料检索', '来源归纳', '事实核查'],
    knowledgeBaseIds: ['kb-prd'],
    enabledToolIds: ['tool-search', 'tool-document-extract'],
    enabledSkillIds: ['skill-research', 'skill-document-understanding'],
    systemPrompt: '你是研究归纳智能体。回答前说明范围，输出来源线索、关键发现、待验证假设和下一步。',
    contextLimit: 12,
    riskBoundary: '只读检索和文档读取，不执行外部写入动作。'
  }
]

const getSourceLabel = (source?: string) =>
  source === 'builtin' ? '系统预设' : source === 'user' || !source ? '用户资产' : source

const getSourceTagColor = (source?: string) =>
  source === 'builtin' ? 'geekblue' : source === 'user' || !source ? 'green' : 'purple'

export const AgentsPage = () => {
  const { message } = App.useApp()
  const dispatch = useAppDispatch()
  const assistants = useAppSelector(selectAssistants)
  const providers = useAppSelector(selectProviders)
  const settings = useAppSelector(selectSettings)
  const knowledgeBases = useAppSelector(selectKnowledgeBases)
  const tools = useAppSelector(selectMcpTools)
  const skills = useAppSelector(selectSkills)
  const mailAgentSettings = useAppSelector(selectMailAgentSettings)
  const mailNotifications = useAppSelector(selectMailNotifications)
  const messages = useAppSelector(selectMessages)
  const [assistantModalOpen, setAssistantModalOpen] = useState(false)
  const [mailAccounts, setMailAccounts] = useState<MemoryEmailAccount[]>([])
  const [checkingMail, setCheckingMail] = useState(false)
  const [editingAssistantId, setEditingAssistantId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedTemplateId, setSelectedTemplateId] = useState('blank')
  const [selectedAssistantId, setSelectedAssistantId] = useState<string | null>(
    assistants[0]?.id ?? null
  )
  const [assistantForm] = Form.useForm<AssistantFormValues>()
  const activeAssistant = assistants.find((assistant) => assistant.id === selectedAssistantId)
  const isIntentAssistant = activeAssistant?.id === 'assistant-main'
  const isMailAssistant = activeAssistant?.id === 'assistant-mail'

  useEffect(() => {
    if (!activeAssistant) {
      setSelectedAssistantId(assistants[0]?.id ?? null)
    }
  }, [activeAssistant, assistants])

  useEffect(() => {
    if (!isMailAssistant) return
    void window.emphant
      .getMemoryProfile()
      .then((profile) => setMailAccounts(profile.emails))
      .catch(() => setMailAccounts([]))
  }, [isMailAssistant])

  const handleCheckMail = async () => {
    setCheckingMail(true)
    try {
      const result = await window.emphant.checkAllEmailAccounts()
      dispatch(applyMailCheckResult(result))
      void message.success(`已检查 ${result.checkedAccounts.length} 个邮箱`)
    } catch (error) {
      dispatch(
        addMailCheckErrorNotification({
          message: error instanceof Error ? error.message : '邮件检查失败'
        })
      )
    } finally {
      setCheckingMail(false)
    }
  }

  const activeProvider = useMemo(
    () => providers.find((provider) => provider.id === activeAssistant?.providerId),
    [providers, activeAssistant?.providerId]
  )
  const boundSkills = useMemo(
    () => skills.filter((skill) => activeAssistant?.enabledSkillIds?.includes(skill.id)),
    [skills, activeAssistant?.enabledSkillIds]
  )
  const boundKnowledgeBases = useMemo(
    () =>
      knowledgeBases.filter((base) =>
        activeAssistant?.knowledgeBaseIds.includes(base.id)
      ),
    [activeAssistant?.knowledgeBaseIds, knowledgeBases]
  )
  const boundTools = useMemo(
    () =>
      tools.filter((tool) =>
        activeAssistant?.enabledToolIds.includes(tool.id)
      ),
    [activeAssistant?.enabledToolIds, tools]
  )
  const sensitiveTools = useMemo(
    () =>
      boundTools.filter((tool) =>
        ['filesystem-write', 'command', 'system', 'database', 'devops'].includes(tool.category)
      ),
    [boundTools]
  )
  const recentRuns = useMemo(
    () =>
      activeAssistant
        ? messages
            .filter(
              (item) =>
                item.role === 'assistant' &&
                item.assistantName === activeAssistant.name
            )
            .slice(-5)
            .reverse()
        : [],
    [activeAssistant, messages]
  )
  const filteredAssistants = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) {
      return assistants
    }

    return assistants.filter((assistant) =>
      [
        assistant.name,
        assistant.description,
        assistant.model,
        ...assistant.capabilities
      ].some((value) => value.toLowerCase().includes(normalizedQuery))
    )
  }, [assistants, query])

  const openCreateAssistant = () => {
    setEditingAssistantId(null)
    setSelectedTemplateId('blank')
    const defaultProvider =
      providers.find((provider) => provider.id === settings.defaultProviderId && provider.enabled) ??
      providers.find((provider) => provider.enabled) ??
      providers[0]
    assistantForm.setFieldsValue({
      name: '',
      description: '',
      providerId: defaultProvider?.id ?? '',
      model:
        defaultProvider?.id === settings.defaultProviderId &&
        defaultProvider.models.includes(settings.defaultModel)
          ? settings.defaultModel
          : defaultProvider?.models[0] ?? '',
      systemPrompt: '',
      contextLimit: 8
    })
    setAssistantModalOpen(true)
  }

  const openEditAssistant = () => {
    if (!activeAssistant) {
      return
    }

    setEditingAssistantId(activeAssistant.id)
    assistantForm.setFieldsValue({
      name: activeAssistant.name,
      description: activeAssistant.description,
      providerId: activeAssistant.providerId,
      model: activeAssistant.model,
      systemPrompt: activeAssistant.systemPrompt,
      contextLimit: activeAssistant.contextLimit
    })
    setAssistantModalOpen(true)
  }

  const handleSubmitAssistant = async () => {
    const values = await assistantForm.validateFields()
    if (editingAssistantId) {
      dispatch(updateAssistant({ assistantId: editingAssistantId, patch: values }))
    } else {
      const template = assistantTemplates.find((item) => item.id === selectedTemplateId)
      dispatch(
        createAssistant({
          ...values,
          capabilities: template?.capabilities,
          knowledgeBaseIds: template?.knowledgeBaseIds,
          enabledToolIds: template?.enabledToolIds,
          enabledSkillIds: template?.enabledSkillIds
        })
      )
    }
    setAssistantModalOpen(false)
  }

  return (
    <div className="agents-layout">
      <Card className="workspace-panel agents-panel agents-panel--list" bordered={false}>
        <div className="panel-header agents-list-header">
          <Typography.Title level={4}>智能体</Typography.Title>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreateAssistant}>
          </Button>
        </div>

        <Input
          allowClear
          value={query}
          prefix={<SearchOutlined />}
          placeholder="搜索名称、描述或能力"
          onChange={(event) => setQuery(event.target.value)}
          className="sidebar-list-search"
        />

        <Space direction="vertical" size={10} className="fill-column agents-list">
          {filteredAssistants.map((assistant) => (
            <div
              key={assistant.id}
              className={
                assistant.id === activeAssistant?.id ? 'select-card is-active' : 'select-card'
              }
            >
              <button
                className="select-card__main"
                onClick={() => setSelectedAssistantId(assistant.id)}
                type="button"
              >
                <strong>{assistant.name}</strong>
                <span>{assistant.description}</span>
              </button>
              <div className="select-card__actions">
                <Tag>{assistant.model}</Tag>
                <Tag color={getSourceTagColor(assistant.source)}>
                  {getSourceLabel(assistant.source)}
                </Tag>
                {assistant.id === activeAssistant?.id && <Tag color="blue">当前</Tag>}
              </div>
            </div>
          ))}
          {filteredAssistants.length === 0 && (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={assistants.length === 0 ? '还没有智能体' : '没有匹配的智能体'}
            />
          )}
        </Space>
      </Card>

      <Card className="workspace-panel agents-panel" bordered={false}>
        {activeAssistant ? (
          <Space direction="vertical" size={18} className="fill-column">
            <div className="panel-header">
              <div>
                <Typography.Title level={4}>{activeAssistant.name}</Typography.Title>
                <Typography.Paragraph type="secondary">
                  {activeAssistant.description || '这个智能体还没有补充描述。'}
                </Typography.Paragraph>
              </div>
              <Space wrap>
                <Tag color={getSourceTagColor(activeAssistant.source)}>
                  {getSourceLabel(activeAssistant.source)}
                </Tag>
                <Button onClick={openEditAssistant}>编辑信息</Button>
                {isIntentAssistant && <Tag color="purple">默认入口</Tag>}
                {isMailAssistant && <Tag color="blue" icon={<MailOutlined />}>邮件监听</Tag>}
                {!isIntentAssistant && !isMailAssistant && assistants.length > 1 && (
                  <Popconfirm
                    title={`删除智能体 ${activeAssistant.name}？`}
                    onConfirm={() => dispatch(deleteAssistant(activeAssistant.id))}
                  >
                    <Button danger>删除智能体</Button>
                  </Popconfirm>
                )}
              </Space>
            </div>

            <div className="agents-detail-grid">
              <div className="provider-card">
                <strong>回答引擎</strong>
                <span>切换当前智能体使用的模型通道和模型版本。</span>
                <Select
                  value={activeAssistant.providerId}
                  options={providers.map((provider) => ({
                    label: provider.enabled ? provider.name : `${provider.name}（已停用）`,
                    value: provider.id,
                    disabled: !provider.enabled
                  }))}
                  onChange={(providerId) => {
                    const provider = providers.find((item) => item.id === providerId)
                    dispatch(
                      updateAssistantModel({
                        assistantId: activeAssistant.id,
                        providerId,
                        model: provider?.models[0] ?? activeAssistant.model
                      })
                    )
                  }}
                />
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder="搜索并选择模型"
                  notFoundContent="没有匹配的模型"
                  value={activeAssistant.model}
                  options={(activeProvider?.models ?? []).map((model) => ({
                    label: model,
                    value: model
                  }))}
                  onChange={(model) =>
                    dispatch(
                      updateAssistantModel({
                        assistantId: activeAssistant.id,
                        providerId: activeAssistant.providerId,
                        model
                      })
                    )
                  }
                />
              </div>

              <div className="provider-card">
                <strong>能力画像</strong>
                <span>用面向用户的方式描述它能做什么、能访问什么，以及哪里需要确认。</span>
                <div className="agents-runtime-preview">
                  <div>
                    <span>功能定位</span>
                    <strong>{activeAssistant.capabilities.join('、') || '通用对话'}</strong>
                  </div>
                  <div>
                    <span>可用范围</span>
                    <strong>
                      {boundKnowledgeBases.length} 个知识库 · {boundTools.length} 个工具
                    </strong>
                  </div>
                  <div>
                    <span>风险边界</span>
                    <strong>
                      {sensitiveTools.length > 0
                        ? `${sensitiveTools.length} 个动作执行前需要确认`
                        : '仅使用低风险或只读能力'}
                    </strong>
                  </div>
                </div>
                <Typography.Paragraph className="agents-system-prompt">
                  {activeAssistant.systemPrompt || '还没有配置系统提示词。'}
                </Typography.Paragraph>
                <Typography.Text type="secondary">
                  上下文消息数：{activeAssistant.contextLimit}
                </Typography.Text>
              </div>
            </div>

            <div className="provider-card">
              <div className="agent-skills-header">
                <div>
                  <strong>运行预览</strong>
                  <span>这个智能体在会话中会使用的模型、知识、工具和确认边界。</span>
                </div>
                <Tag color={settings.openClawCore?.requireToolApproval ? 'green' : 'orange'}>
                  {settings.openClawCore?.requireToolApproval ? '高风险动作需确认' : '执行前确认关闭'}
                </Tag>
              </div>
              <div className="agents-runtime-preview">
	                <div>
	                  <span>模型</span>
	                  <strong>
	                    {activeProvider?.name ?? '未启用回答引擎'} · {activeAssistant.model}
	                  </strong>
	                </div>
                <div>
                  <span>知识库</span>
                  <strong>
                    {boundKnowledgeBases.length > 0
                      ? boundKnowledgeBases.map((base) => base.name).join('、')
                      : '不引用知识库'}
                  </strong>
                </div>
                <div>
                  <span>工具</span>
                  <strong>
                    {boundTools.length > 0
                      ? boundTools.map((tool) => tool.name).join('、')
                      : '不调用外部工具'}
                  </strong>
                </div>
                <div>
                  <span>确认边界</span>
                  <strong>
                    {sensitiveTools.length > 0
                      ? `${sensitiveTools.length} 个敏感工具：${sensitiveTools
                          .map((tool) => tool.name)
                          .join('、')}`
                      : '未挂载敏感工具'}
                  </strong>
                </div>
              </div>
              <div className="agents-recent-runs">
                <strong>最近运行</strong>
                {recentRuns.length > 0 ? (
                  <Space wrap>
                    {recentRuns.map((run) => (
                      <Tag key={run.id}>
                        {new Date(run.createdAt).toLocaleString()}
                      </Tag>
                    ))}
                  </Space>
                ) : (
                  <Typography.Text type="secondary">还没有运行记录</Typography.Text>
                )}
              </div>
            </div>

            {isMailAssistant && (
              <div className="provider-card mail-agent-settings">
                <div className="agent-skills-header">
                  <div>
                    <strong>邮件检查与通知</strong>
                    <span>按设定周期检查新邮件，并在顶部通知中提醒。</span>
                  </div>
                  <Switch
                    checked={mailAgentSettings.enabled}
                    checkedChildren="运行中"
                    unCheckedChildren="已停用"
                    onChange={(enabled) => dispatch(updateMailAgentSettings({ enabled }))}
                  />
                </div>
                <div className="mail-agent-settings__grid">
                  <label>
                    <span>默认发件邮箱</span>
                    <Select
                      value={mailAgentSettings.accountEmail}
                      placeholder="请选择已配置 SMTP 的邮箱"
                      onChange={(accountEmail) =>
                        dispatch(updateMailAgentSettings({ accountEmail }))
                      }
                      options={mailAccounts
                        .filter((email) => email.credentialConfigured)
                        .map((email) => ({
                          value: email.address,
                          label: `${
                            email.type === 'work'
                              ? '公司邮箱'
                              : email.type === 'personal'
                                ? '个人邮箱'
                                : '其他邮箱'
                          } · ${email.address}`
                        }))}
                    />
                  </label>
                  <label>
                    <span>检查周期</span>
                    <Select
                      value={mailAgentSettings.checkIntervalMinutes}
                      onChange={(checkIntervalMinutes) =>
                        dispatch(updateMailAgentSettings({ checkIntervalMinutes }))
                      }
                      options={[
                        { value: 1, label: '每 1 分钟' },
                        { value: 5, label: '每 5 分钟' },
                        { value: 15, label: '每 15 分钟' },
                        { value: 30, label: '每 30 分钟' },
                        { value: 60, label: '每 1 小时' }
                      ]}
                    />
                  </label>
                </div>
                <div className="mail-agent-settings__status">
                  <span>
                    上次检查：
                    {mailAgentSettings.lastCheckedAt
                      ? new Date(mailAgentSettings.lastCheckedAt).toLocaleString()
                      : '尚未检查'}
                    {' · '}
                    已检查 {mailAgentSettings.checkedAccountAddresses?.length ?? 0} 个邮箱
                    {' · '}
                    {mailNotifications.filter((mail) => mail.unread).length} 封未读
                  </span>
                  <Button
                    icon={<ReloadOutlined />}
                    disabled={!mailAgentSettings.enabled}
                    loading={checkingMail}
                    onClick={() => void handleCheckMail()}
                  >
                    立即检查
                  </Button>
                </div>
                {mailAgentSettings.checkErrors &&
                  mailAgentSettings.checkErrors.length > 0 && (
                    <div className="mail-agent-errors">
                      {mailAgentSettings.checkErrors.map((error) => (
                        <span key={error.accountAddress}>
                          {error.accountAddress}：{error.message}
                        </span>
                      ))}
                    </div>
                  )}
              </div>
            )}

            <div className="provider-card">
              <strong>知识范围</strong>
              <span>控制这个智能体在对话中可引用的知识。</span>
              <Space wrap>
                {knowledgeBases.map((base) => (
                  <Tag
                    key={base.id}
                    className={
                      activeAssistant.knowledgeBaseIds.includes(base.id)
                        ? 'interactive-tag is-active'
                        : 'interactive-tag'
                    }
                    onClick={() =>
                      dispatch(
                        toggleAssistantKnowledgeBase({
                          assistantId: activeAssistant.id,
                          knowledgeBaseId: base.id
                        })
                      )
                    }
                  >
                    {base.name}
                  </Tag>
                ))}
              </Space>
            </div>

            <div className="provider-card">
              <strong>可用工具</strong>
              <span>控制这个智能体在会话中可调用的扩展能力，高风险动作会进入确认流程。</span>
              <Space wrap>
                {tools.map((tool) => (
                  <Tag
                    key={tool.id}
                    className={
                      activeAssistant.enabledToolIds.includes(tool.id)
                        ? 'interactive-tag is-active'
                        : 'interactive-tag'
                    }
                    onClick={() =>
                      dispatch(
                        toggleAssistantTool({
                          assistantId: activeAssistant.id,
                          toolId: tool.id
                        })
                      )
                    }
                  >
                    {tool.name}
                  </Tag>
                ))}
              </Space>
            </div>

            <div className="provider-card">
              <div className="agent-skills-header">
                <div>
                  <strong>可用技能</strong>
                  <span>选择这个智能体可使用的技能，运行时会按任务内容自动挑选。</span>
                </div>
                <Tag color="blue">{boundSkills.length} 项</Tag>
              </div>
              {skills.length > 0 ? (
                <div className="agent-skills-list">
                  {skills.map((skill) => {
                    const mounted = activeAssistant.enabledSkillIds?.includes(skill.id) ?? false
                    return (
                    <button
                      key={skill.id}
                      type="button"
                      className={
                        mounted
                          ? 'agent-skill-item is-enabled'
                          : 'agent-skill-item'
                      }
                      onClick={() =>
                        dispatch(
                          toggleAssistantSkill({
                            assistantId: activeAssistant.id,
                            skillId: skill.id
                          })
                        )
                      }
                      aria-label={`${mounted ? '移除' : '添加'}技能 ${skill.name}`}
                    >
                      <span>
                        <strong>{skill.name}</strong>
                        <small>
                          {skill.kind === 'code' ? '代码型' : '提示词'} · {skill.description || '暂未补充描述'}
                        </small>
                      </span>
                      <Tag color={mounted ? 'blue' : 'default'}>
                        {mounted ? '已挂载' : skill.enabled ? '可挂载' : '已停用'}
                      </Tag>
                    </button>
                    )
                  })}
                </div>
              ) : (
                <div className="agent-skills-empty">
                  暂无技能，可前往技能页面创建或导入。
                </div>
              )}
            </div>
          </Space>
        ) : (
          <div className="agents-empty">
            <div>
              <Typography.Title level={4}>还没有智能体</Typography.Title>
              <Typography.Paragraph type="secondary">
                先创建一个智能体，再回到工作台处理会话和任务。
              </Typography.Paragraph>
              <Button type="primary" onClick={openCreateAssistant}>
                创建第一个智能体
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Modal
        open={assistantModalOpen}
        title={editingAssistantId ? '编辑智能体' : '新建智能体'}
        onCancel={() => setAssistantModalOpen(false)}
        onOk={() => void handleSubmitAssistant()}
      >
        <Form layout="vertical" form={assistantForm}>
          {!editingAssistantId && (
            <Form.Item label="智能体模板">
              <Select
                value={selectedTemplateId}
                options={[
                  { label: '空白智能体', value: 'blank' },
                  ...assistantTemplates.map((template) => ({
                    label: template.name,
                    value: template.id
                  }))
                ]}
                onChange={(templateId) => {
                  setSelectedTemplateId(templateId)
                  const template = assistantTemplates.find((item) => item.id === templateId)
                  if (!template) return
                  const defaultProvider =
                    providers.find((provider) => provider.id === settings.defaultProviderId && provider.enabled) ??
                    providers.find((provider) => provider.enabled) ??
                    providers[0]
                  assistantForm.setFieldsValue({
                    name: template.name,
                    description: template.description,
                    providerId: defaultProvider?.id ?? '',
                    model:
                      defaultProvider?.id === settings.defaultProviderId &&
                      defaultProvider.models.includes(settings.defaultModel)
                        ? settings.defaultModel
                        : defaultProvider?.models[0] ?? '',
                    systemPrompt: template.systemPrompt,
                    contextLimit: template.contextLimit
                  })
                }}
              />
              {selectedTemplateId !== 'blank' && (
                <div className="agent-template-preview">
                  {(() => {
                    const template = assistantTemplates.find((item) => item.id === selectedTemplateId)
                    if (!template) return null
                    return (
                      <>
                        <span>{template.description}</span>
                        <Space wrap>
                          {template.capabilities.map((capability) => (
                            <Tag key={capability}>{capability}</Tag>
                          ))}
                        </Space>
                        <p>{template.riskBoundary}</p>
                      </>
                    )
                  })()}
                </div>
              )}
            </Form.Item>
          )}
          <Form.Item label="名称" name="name" rules={[{ required: true }]}>
            <Input disabled={editingAssistantId === 'assistant-main'} />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input />
          </Form.Item>
          <Form.Item label="回答引擎" name="providerId" rules={[{ required: true }]}>
            <Select
              options={providers.map((provider) => ({
                label: provider.enabled ? provider.name : `${provider.name}（已停用）`,
                value: provider.id,
                disabled: !provider.enabled
              }))}
              onChange={(providerId) => {
                const provider = providers.find((item) => item.id === providerId)
                assistantForm.setFieldValue('model', provider?.models[0] ?? '')
              }}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate>
            {() => {
              const providerId = assistantForm.getFieldValue('providerId')
              const provider = providers.find((item) => item.id === providerId)
              return (
                <Form.Item label="模型" name="model" rules={[{ required: true }]}>
                  <Select
                    showSearch
                    optionFilterProp="label"
                    placeholder="搜索并选择模型"
                    notFoundContent="没有匹配的模型"
                    options={(provider?.models ?? []).map((model) => ({
                      label: model,
                      value: model
                    }))}
                  />
                </Form.Item>
              )
            }}
          </Form.Item>
          <Form.Item label="系统提示词" name="systemPrompt">
            <Input.TextArea autoSize={{ minRows: 3, maxRows: 5 }} />
          </Form.Item>
          <Form.Item label="上下文消息数" name="contextLimit">
            <InputNumber min={4} max={20} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
