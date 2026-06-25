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
  const [assistantModalOpen, setAssistantModalOpen] = useState(false)
  const [mailAccounts, setMailAccounts] = useState<MemoryEmailAccount[]>([])
  const [checkingMail, setCheckingMail] = useState(false)
  const [editingAssistantId, setEditingAssistantId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
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
      dispatch(createAssistant(values))
    }
    setAssistantModalOpen(false)
  }

  return (
    <div className="agents-layout">
      <Card className="workspace-panel agents-panel agents-panel--list" bordered={false}>
        <div className="panel-header agents-list-header">
          <Typography.Title level={4}>Agent</Typography.Title>
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
                {assistant.id === activeAssistant?.id && <Tag color="blue">当前</Tag>}
              </div>
            </div>
          ))}
          {filteredAssistants.length === 0 && (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={assistants.length === 0 ? '还没有 Agent' : '没有匹配的 Agent'}
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
                  {activeAssistant.description || '这个 Agent 还没有补充描述。'}
                </Typography.Paragraph>
              </div>
              <Space wrap>
                <Button onClick={openEditAssistant}>编辑信息</Button>
                {isIntentAssistant && <Tag color="purple">默认入口</Tag>}
                {isMailAssistant && <Tag color="blue" icon={<MailOutlined />}>邮件监听</Tag>}
                {!isIntentAssistant && !isMailAssistant && assistants.length > 1 && (
                  <Popconfirm
                    title={`删除 Agent ${activeAssistant.name}？`}
                    onConfirm={() => dispatch(deleteAssistant(activeAssistant.id))}
                  >
                    <Button danger>删除 Agent</Button>
                  </Popconfirm>
                )}
              </Space>
            </div>

            <div className="agents-detail-grid">
              <div className="provider-card">
                <strong>模型接入</strong>
                <span>切换 Provider 和模型版本，影响当前 Agent 的回答来源。</span>
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
                <span>当前 Agent 的功能定位和系统约束。</span>
                <Space wrap>
                  {activeAssistant.capabilities.map((capability) => (
                    <Tag key={capability} bordered={false}>
                      {capability}
                    </Tag>
                  ))}
                </Space>
                <Typography.Paragraph className="agents-system-prompt">
                  {activeAssistant.systemPrompt || '还没有配置系统提示词。'}
                </Typography.Paragraph>
                <Typography.Text type="secondary">
                  上下文消息数：{activeAssistant.contextLimit}
                </Typography.Text>
              </div>
            </div>

            {isMailAssistant && (
              <div className="provider-card mail-agent-settings">
                <div className="agent-skills-header">
                  <div>
                    <strong>邮件检查与通知</strong>
                    <span>按设定周期检查新邮件，并将未读邮件显示在 Header 通知中。</span>
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
              <strong>知识库挂载</strong>
              <span>控制这个 Agent 在聊天页可引用的知识库范围。</span>
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
              <strong>工具挂载</strong>
              <span>控制这个 Agent 在聊天页可调用的 MCP 工具。</span>
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
                  <strong>Skills 挂载</strong>
                  <span>选择这个 Agent 可使用的 Skills，运行时会按任务内容自动挑选其中几项。</span>
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
                      aria-label={`${mounted ? '卸载' : '挂载'} Skill ${skill.name}`}
                    >
                      <span>
                        <strong>{skill.name}</strong>
                        <small>
                          {skill.kind === 'code' ? '代码型' : 'Prompt'} · {skill.description || '暂未补充描述'}
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
                  暂无 Skill，可前往 Skills 页面创建或导入。
                </div>
              )}
            </div>
          </Space>
        ) : (
          <div className="agents-empty">
            <div>
              <Typography.Title level={4}>还没有 Agent</Typography.Title>
              <Typography.Paragraph type="secondary">
                先创建一个 Agent，再回到工作台开始建任务和聊天。
              </Typography.Paragraph>
              <Button type="primary" onClick={openCreateAssistant}>
                创建第一个 Agent
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Modal
        open={assistantModalOpen}
        title={editingAssistantId ? '编辑 Agent' : '新建 Agent'}
        onCancel={() => setAssistantModalOpen(false)}
        onOk={() => void handleSubmitAssistant()}
      >
        <Form layout="vertical" form={assistantForm}>
          <Form.Item label="名称" name="name" rules={[{ required: true }]}>
            <Input disabled={editingAssistantId === 'assistant-main'} />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input />
          </Form.Item>
          <Form.Item label="Provider" name="providerId" rules={[{ required: true }]}>
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
