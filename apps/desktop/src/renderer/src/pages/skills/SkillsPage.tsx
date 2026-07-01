import {
  AppstoreOutlined,
  CheckCircleFilled,
  CodeOutlined,
  FolderOpenOutlined,
  GithubOutlined,
  PlusOutlined,
  SearchOutlined
} from '@ant-design/icons'
import {
  App,
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
import { useEffect, useMemo, useState } from 'react'
import type {
  CodeSkillRuntime,
  PermissionCapability,
  Skill,
  SkillKind
} from '@emphant/shared/types'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  createSkill,
  deleteSkill,
  selectMcpTools,
  selectSkills,
  toggleSkill,
  updateSkill
} from '@/store/workbenchSlice'

type SkillFormValues = Pick<
  Skill,
  'name' | 'description' | 'instructions' | 'tags' | 'enabled'
> & {
  kind: SkillKind
  version: string
  source: string
  triggers: string[]
  requiredToolIds: string[]
  permissions: PermissionCapability[]
  codeRuntime: CodeSkillRuntime
  codeEntrypoint?: string
  codeCommand?: string
}

const permissionOptions: PermissionCapability[] = [
  'workspace.read',
  'workspace.write',
  'network.fetch',
  'task.read',
  'task.write',
  'mail.read',
  'mail.draft',
  'mail.send',
  'calendar.read',
  'calendar.write',
  'browser.read',
  'browser.interact',
  'knowledge.write',
  'memory.read',
  'memory.write'
]

export const SkillsPage = () => {
  const dispatch = useAppDispatch()
  const { message } = App.useApp()
  const skills = useAppSelector(selectSkills)
  const tools = useAppSelector(selectMcpTools)
  const [query, setQuery] = useState('')
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(skills[0]?.id ?? null)
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null)
  const [skillModalOpen, setSkillModalOpen] = useState(false)
  const [importModalOpen, setImportModalOpen] = useState(false)
  const [githubSource, setGithubSource] = useState('')
  const [importing, setImporting] = useState(false)
  const [skillForm] = Form.useForm<SkillFormValues>()

  const filteredSkills = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (!normalizedQuery) {
      return skills
    }

    return skills.filter((skill) =>
      [skill.name, skill.description, ...skill.tags]
        .join(' ')
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    )
  }, [query, skills])

  const activeSkill = skills.find((skill) => skill.id === selectedSkillId)
  const selectedKind = Form.useWatch('kind', skillForm)

  useEffect(() => {
    if (!activeSkill) {
      setSelectedSkillId(skills[0]?.id ?? null)
    }
  }, [activeSkill, skills])

  const openCreateSkill = () => {
    setEditingSkillId(null)
    skillForm.resetFields()
    skillForm.setFieldsValue({
      name: '',
      description: '',
      kind: 'prompt',
      instructions: '',
      tags: [],
      version: '1.0.0',
      source: 'user',
      triggers: [],
      requiredToolIds: [],
      permissions: [],
      codeRuntime: 'unknown',
      codeEntrypoint: '',
      codeCommand: '',
      enabled: true
    })
    setSkillModalOpen(true)
  }

  const openEditSkill = () => {
    if (!activeSkill) {
      return
    }

    setEditingSkillId(activeSkill.id)
    skillForm.setFieldsValue({
      name: activeSkill.name,
      description: activeSkill.description,
      kind: activeSkill.kind,
      instructions: activeSkill.instructions,
      tags: activeSkill.tags,
      version: activeSkill.version ?? '1.0.0',
      source: activeSkill.source ?? 'user',
      triggers: activeSkill.triggers ?? [],
      requiredToolIds: activeSkill.requiredToolIds ?? [],
      permissions: activeSkill.permissions ?? [],
      codeRuntime: activeSkill.code?.runtime ?? 'unknown',
      codeEntrypoint: activeSkill.code?.entrypoint ?? '',
      codeCommand: activeSkill.code?.command ?? '',
      enabled: activeSkill.enabled
    })
    setSkillModalOpen(true)
  }

  const handleSubmitSkill = async () => {
    const values = await skillForm.validateFields()
    const { codeRuntime, codeEntrypoint, codeCommand, ...skillValues } = values
    const normalizedValues = {
      ...skillValues,
      name: values.name.trim(),
      description: values.description.trim(),
      instructions: values.instructions.trim(),
      version: values.version.trim(),
      source: values.source.trim(),
      tags: Array.from(new Set(values.tags.map((tag) => tag.trim()).filter(Boolean))),
      triggers: Array.from(new Set(values.triggers.map((item) => item.trim()).filter(Boolean))),
      code:
        values.kind === 'code'
          ? {
              runtime: codeRuntime,
              entrypoint: codeEntrypoint?.trim() || undefined,
              command: codeCommand?.trim() || undefined
            }
          : undefined
    }

    if (editingSkillId) {
      dispatch(updateSkill({ skillId: editingSkillId, patch: normalizedValues }))
      void message.success('技能已更新')
    } else {
      const skillId = `skill-${Date.now()}`
      dispatch(createSkill({ id: skillId, ...normalizedValues }))
      setSelectedSkillId(skillId)
      void message.success('技能已创建')
    }
    setSkillModalOpen(false)
  }

  const importSkills = async (source: string, kind: 'local' | 'github') => {
    setImporting(true)
    try {
      const result = await window.emphant.importSkillSource({ source, kind })
      for (const skill of result.skills) {
        dispatch(createSkill(skill))
      }
      if (result.skills[0]) {
        setSelectedSkillId(result.skills[0].id)
      }
      void message.success(`已导入 ${result.skills.length} 个技能`)
      setImportModalOpen(false)
      setGithubSource('')
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '技能导入失败')
    } finally {
      setImporting(false)
    }
  }

  const handleImportLocal = async () => {
    const directory = await window.emphant.selectSkillDirectory()
    if (directory) {
      await importSkills(directory, 'local')
    }
  }

  return (
    <div className="skills-layout">
      <Card className="workspace-panel skills-panel skills-panel--list" bordered={false}>
        <div className="panel-header skills-list-header">
          <Typography.Title level={4}>技能</Typography.Title>
          <Space>
            <Button
              icon={<FolderOpenOutlined />}
              onClick={() => void handleImportLocal()}
              aria-label="导入本地技能"
            />
            <Button
              icon={<GithubOutlined />}
              onClick={() => setImportModalOpen(true)}
              aria-label="导入 GitHub 技能"
            />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={openCreateSkill}
              aria-label="新建技能"
            />
          </Space>
        </div>

        <Input
          allowClear
          value={query}
          prefix={<SearchOutlined />}
          placeholder="搜索名称、描述或标签"
          onChange={(event) => setQuery(event.target.value)}
          className="skills-search"
        />

        <div className="skills-list">
          {filteredSkills.map((skill) => {
            return (
              <div
                key={skill.id}
                className={skill.id === activeSkill?.id ? 'select-card is-active' : 'select-card'}
              >
                <button
                  className="select-card__main"
                  onClick={() => setSelectedSkillId(skill.id)}
                  type="button"
                >
                  <span className="skill-list-item__title">
                    <strong>{skill.name}</strong>
                    <span className={skill.enabled ? 'skill-status is-enabled' : 'skill-status'}>
                      {skill.enabled ? '启用' : '停用'}
                    </span>
                  </span>
                  <span>{skill.description || '暂未补充描述'}</span>
                </button>
                <div className="select-card__actions">
                  <Tag bordered={false}>{skill.kind === 'code' ? '代码型' : '提示词'}</Tag>
                  <span>{skill.tags.length} 标签</span>
                </div>
              </div>
            )
          })}
          {filteredSkills.length === 0 && (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={skills.length === 0 ? '还没有技能' : '没有匹配的技能'}
            >
              {skills.length === 0 && (
                <Button type="primary" onClick={openCreateSkill}>
                  创建第一个技能
                </Button>
              )}
            </Empty>
          )}
        </div>
      </Card>

      <Card className="workspace-panel skills-panel skills-panel--detail" bordered={false}>
        {activeSkill ? (
          <Space direction="vertical" size={18} className="fill-column">
            <div className="panel-header">
              <div className="skill-detail-title">
                <span className="skill-detail-icon">
                  <AppstoreOutlined />
                </span>
                <div>
                  <Space size={8} wrap>
                    <Typography.Title level={4}>{activeSkill.name}</Typography.Title>
                    <Tag color={activeSkill.enabled ? 'blue' : 'default'}>
                      {activeSkill.enabled ? '已启用' : '已停用'}
                    </Tag>
                  </Space>
                  <Typography.Paragraph type="secondary">
                    {activeSkill.description || '这个技能还没有补充描述。'}
                  </Typography.Paragraph>
                </div>
              </div>
              <Space wrap>
                <Button onClick={openEditSkill}>编辑信息</Button>
                <Popconfirm
                  title={`删除技能 ${activeSkill.name}？`}
                  description="删除后无法恢复。"
                  onConfirm={() => {
                    dispatch(deleteSkill(activeSkill.id))
                    void message.success('技能已删除')
                  }}
                >
                  <Button danger>删除</Button>
                </Popconfirm>
              </Space>
            </div>

            <div className="skills-detail-grid">
              <div className="provider-card skill-config-card">
                <div className="skill-card-section-header">
                  <div>
                    <strong>运行状态</strong>
                    <span>停用后所有智能体都不会使用这项能力。</span>
                  </div>
                  <Switch
                    checked={activeSkill.enabled}
                    onChange={() => dispatch(toggleSkill(activeSkill.id))}
                  />
                </div>
                <div className="skill-status-summary">
                  <CheckCircleFilled />
                  <span>
                    {activeSkill.enabled
                      ? '已参与智能体运行配置'
                      : '当前不会参与智能体运行'}
                  </span>
                </div>
              </div>

              <div className="provider-card skill-config-card">
                <strong>技能类型</strong>
                <span>
                  {activeSkill.kind === 'code'
                    ? '代码型技能可从本地目录或开源仓库导入，当前作为受控能力说明供智能体选择。'
                    : '提示词技能会向智能体注入任务方法、输出格式和边界。'}
                </span>
                <Tag icon={activeSkill.kind === 'code' ? <CodeOutlined /> : <AppstoreOutlined />}>
                  {activeSkill.kind === 'code' ? '代码型技能' : '提示词技能'}
                </Tag>
              </div>
            </div>

            <div className="provider-card">
              <strong>技能指令</strong>
              <span>被智能体启用并匹配当前任务时，会追加到系统提示词中。</span>
              <Typography.Paragraph className="skills-instructions">
                {activeSkill.instructions || '还没有配置技能指令。'}
              </Typography.Paragraph>
            </div>

            <div className="provider-card">
              <strong>能力标签</strong>
              <span>用于快速检索和识别这个技能的适用场景。</span>
              <Space wrap>
                {activeSkill.tags.length > 0 ? (
                  activeSkill.tags.map((tag) => (
                    <Tag key={tag} className="skill-tag">
                      {tag}
                    </Tag>
                  ))
                ) : (
                  <Typography.Text type="secondary">暂无标签</Typography.Text>
                )}
              </Space>
            </div>

            <div className="skills-detail-grid">
              <div className="provider-card">
                <strong>包信息</strong>
                <span>用于识别安装来源和后续升级。</span>
                <Typography.Text>{activeSkill.source ?? 'user'}</Typography.Text>
                <Tag>v{activeSkill.version ?? '1.0.0'}</Tag>
              </div>
              <div className="provider-card">
                <strong>触发词</strong>
                <span>智能体会据此判断当前任务是否需要使用这个技能。</span>
                <Space wrap>
                  {(activeSkill.triggers ?? []).map((trigger) => (
                    <Tag key={trigger}>{trigger}</Tag>
                  ))}
                  {(activeSkill.triggers?.length ?? 0) === 0 && (
                    <Typography.Text type="secondary">暂无触发词</Typography.Text>
                  )}
                </Space>
              </div>
            </div>

            <div className="skills-detail-grid">
              <div className="provider-card">
                <strong>工具依赖</strong>
                <Space wrap>
                  {(activeSkill.requiredToolIds ?? []).map((toolId) => (
                    <Tag key={toolId}>
                      {tools.find((tool) => tool.id === toolId)?.name ?? toolId}
                    </Tag>
                  ))}
                  {(activeSkill.requiredToolIds?.length ?? 0) === 0 && (
                    <Typography.Text type="secondary">无额外工具依赖</Typography.Text>
                  )}
                </Space>
              </div>
              <div className="provider-card">
                <strong>权限声明</strong>
                <Space wrap>
                  {(activeSkill.permissions ?? []).map((permission) => (
                    <Tag color="orange" key={permission}>
                      {permission}
                    </Tag>
                  ))}
                  {(activeSkill.permissions?.length ?? 0) === 0 && (
                    <Typography.Text type="secondary">无额外权限</Typography.Text>
                  )}
                </Space>
              </div>
            </div>

            <div className="provider-card">
              <strong>执行资源</strong>
              <span>技能本身不绑定智能体。请在智能体页面选择哪些智能体可以使用它。</span>
              <div className="skill-resource-grid">
                <div>
                  <span>类型</span>
                  <strong>{activeSkill.kind === 'code' ? '代码型' : '提示词'}</strong>
                  <Typography.Text type="secondary">运行时按任务内容选择</Typography.Text>
                </div>
                <div>
                  <span>代码运行时</span>
                  <strong>{activeSkill.code?.runtime ?? '无'}</strong>
                  <Typography.Text type="secondary">
                    {activeSkill.code?.entrypoint ?? activeSkill.code?.command ?? '未配置入口'}
                  </Typography.Text>
                </div>
                <div>
                  <span>工具依赖</span>
                  <strong>{activeSkill.requiredToolIds?.length ?? 0}</strong>
                  <Typography.Text type="secondary">
                    {(activeSkill.requiredToolIds ?? [])
                      .map((toolId) => tools.find((tool) => tool.id === toolId)?.name ?? toolId)
                      .join('、') || '未声明'}
                  </Typography.Text>
                </div>
              </div>
            </div>
          </Space>
        ) : (
          <div className="agents-empty">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="选择或创建一个技能开始配置"
            >
              <Button type="primary" onClick={openCreateSkill}>
                新建技能
              </Button>
            </Empty>
          </div>
        )}
      </Card>

      <Modal
        open={skillModalOpen}
        title={editingSkillId ? '编辑技能' : '新建技能'}
        onCancel={() => setSkillModalOpen(false)}
        onOk={() => void handleSubmitSkill()}
        okText={editingSkillId ? '保存' : '创建'}
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={skillForm} layout="vertical" requiredMark={false}>
          <Form.Item
            label="名称"
            name="name"
            rules={[
              { required: true, message: '请输入技能名称' },
              {
                validator: (_, value: string) =>
                  value?.trim()
                    ? Promise.resolve()
                    : Promise.reject(new Error('名称不能只包含空格'))
              }
            ]}
          >
            <Input maxLength={40} placeholder="例如：竞品调研" />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 4 }}
              maxLength={160}
              placeholder="说明这个技能适合处理什么任务"
            />
          </Form.Item>
          <Form.Item label="类型" name="kind" rules={[{ required: true }]}>
            <Select
              options={[
                { label: '提示词技能', value: 'prompt' },
                { label: '代码型技能', value: 'code' }
              ]}
            />
          </Form.Item>
          <Form.Item
            label="技能指令"
            name="instructions"
            rules={[{ required: true, message: '请输入技能指令' }]}
          >
            <Input.TextArea
              autoSize={{ minRows: 4, maxRows: 7 }}
              placeholder="描述执行步骤、输出要求和边界"
            />
          </Form.Item>
          {selectedKind === 'code' && (
            <div className="skills-detail-grid">
              <Form.Item name="codeRuntime" label="代码运行时" rules={[{ required: true }]}>
                <Select
                  options={[
                    { label: 'Node.js', value: 'node' },
                    { label: 'Python', value: 'python' },
                    { label: 'Rust', value: 'rust' },
                    { label: 'Shell', value: 'shell' },
                    { label: 'MCP', value: 'mcp' },
                    { label: 'Unknown', value: 'unknown' }
                  ]}
                />
              </Form.Item>
              <Form.Item name="codeEntrypoint" label="入口文件">
                <Input placeholder="例如 main.py、index.js 或 run.sh" />
              </Form.Item>
              <Form.Item name="codeCommand" label="执行命令">
                <Input placeholder="例如 python main.py" />
              </Form.Item>
            </div>
          )}
          <Form.Item label="标签" name="tags">
            <Select
              mode="tags"
              tokenSeparators={[',', '，']}
              placeholder="输入标签后回车"
              maxTagCount="responsive"
            />
          </Form.Item>
          <div className="skills-detail-grid">
            <Form.Item name="version" label="版本" rules={[{ required: true }]}>
              <Input placeholder="1.0.0" />
            </Form.Item>
            <Form.Item name="source" label="来源" rules={[{ required: true }]}>
              <Input placeholder="user 或 owner/repo" />
            </Form.Item>
          </div>
          <Form.Item name="triggers" label="触发词">
            <Select
              mode="tags"
              tokenSeparators={[',', '，']}
              placeholder="输入适用表达后回车"
            />
          </Form.Item>
          <Form.Item name="requiredToolIds" label="工具依赖">
            <Select
              mode="multiple"
              options={tools.map((tool) => ({ label: tool.name, value: tool.id }))}
            />
          </Form.Item>
          <Form.Item name="permissions" label="权限声明">
            <Select
              mode="multiple"
              options={permissionOptions.map((permission) => ({
                label: permission,
                value: permission
              }))}
            />
          </Form.Item>
          <Form.Item label="立即启用" name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={importModalOpen}
        title="导入 GitHub 技能"
        onCancel={() => setImportModalOpen(false)}
        onOk={() => void importSkills(githubSource, 'github')}
        okText="导入"
        cancelText="取消"
        confirmLoading={importing}
        okButtonProps={{ disabled: !githubSource.trim() }}
      >
        <Space direction="vertical" size={12} className="fill-column">
          <Typography.Paragraph type="secondary">
            支持填写 owner/repo、GitHub HTTPS 地址或 git 地址。导入时会读取仓库中的
            skill.json、SKILL.md 或 README.md。
          </Typography.Paragraph>
          <Input
            value={githubSource}
            onChange={(event) => setGithubSource(event.target.value)}
            placeholder="例如 anthropics/knowledge-work-plugins"
          />
        </Space>
      </Modal>
    </div>
  )
}
