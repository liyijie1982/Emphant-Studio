import {
  CameraOutlined,
  DeleteOutlined,
  EditOutlined,
  KeyOutlined,
  MailOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  UserOutlined
} from '@ant-design/icons'
import {
  App,
  Avatar,
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Typography
} from 'antd'
import { useEffect, useMemo, useState } from 'react'
import type {
  EmailCredentialSetRequest,
  MemoryEmailAccount,
  MemoryProfile,
  MemoryProfileFact,
  MemoryProfileRelation
} from '@emphant/shared/types'

const predicateLabels: Record<string, string> = {
  name: '姓名',
  email: '邮箱',
  personal_email: '个人邮箱',
  work_email: '工作邮箱',
  occupation: '职业',
  job_title: '职位',
  company: '公司',
  location: '所在地',
  preferred_language: '偏好语言',
  uses_language: '常用技术',
  assistant_name: 'AI 助理名称',
  assistant_gender: 'AI 助理性别',
  assistant_personality: 'AI 助理性格',
  assistant_tone: 'AI 助理语气',
  assistant_avatar_data_url: 'AI 助理头像'
}

const relationLabels: Record<string, string> = {
  spouse: '配偶',
  parent: '父母',
  child: '子女',
  sibling: '兄弟姐妹',
  relative: '亲属',
  friend: '朋友',
  colleague: '同事',
  manager: '上级',
  subordinate: '下属',
  client: '客户',
  partner: '合作伙伴',
  works_at: '任职于',
  member_of: '属于',
  participates_in: '参与'
}

const emailTypeLabels = {
  personal: '个人邮箱',
  work: '工作邮箱',
  unknown: '邮箱'
}

const credentialTypeLabels = {
  password: '账号密码',
  app_password: '应用专用密码',
  api_key: 'API Key'
}

const getFactLabel = (predicate: string) =>
  predicateLabels[predicate] ??
  (predicate.startsWith('custom:') ? predicate.slice('custom:'.length) : predicate)

const assistantFactPredicates = [
  'assistant_name',
  'assistant_gender',
  'assistant_personality',
  'assistant_tone',
  'assistant_avatar_data_url'
]

const getMailServerDefaults = (email: string) => {
  const domain = email.split('@')[1]?.toLowerCase() ?? ''
  const known: Record<
    string,
    Pick<
      EmailCredentialSetRequest,
      'imapHost' | 'imapPort' | 'imapSecure' | 'smtpHost' | 'smtpPort' | 'smtpSecure'
    >
  > = {
    'gmail.com': {
      imapHost: 'imap.gmail.com',
      imapPort: 993,
      imapSecure: true,
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      smtpSecure: true
    },
    'outlook.com': {
      imapHost: 'outlook.office365.com',
      imapPort: 993,
      imapSecure: true,
      smtpHost: 'smtp.office365.com',
      smtpPort: 587,
      smtpSecure: false
    },
    'hotmail.com': {
      imapHost: 'outlook.office365.com',
      imapPort: 993,
      imapSecure: true,
      smtpHost: 'smtp.office365.com',
      smtpPort: 587,
      smtpSecure: false
    },
    'qq.com': {
      imapHost: 'imap.qq.com',
      imapPort: 993,
      imapSecure: true,
      smtpHost: 'smtp.qq.com',
      smtpPort: 465,
      smtpSecure: true
    },
    '163.com': {
      imapHost: 'imap.163.com',
      imapPort: 993,
      imapSecure: true,
      smtpHost: 'smtp.163.com',
      smtpPort: 465,
      smtpSecure: true
    }
  }
  return (
    known[domain] ?? {
      imapHost: domain ? `imap.${domain}` : '',
      imapPort: 993,
      imapSecure: true,
      smtpHost: domain ? `smtp.${domain}` : '',
      smtpPort: 465,
      smtpSecure: true
    }
  )
}

export const ProfilePage = () => {
  const { message } = App.useApp()
  const [profile, setProfile] = useState<MemoryProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [editingEmail, setEditingEmail] = useState<MemoryEmailAccount | null>(null)
  const [editingEmailAccount, setEditingEmailAccount] = useState<
    MemoryEmailAccount | 'new' | null
  >(null)
  const [editingFact, setEditingFact] = useState<MemoryProfileFact | 'new' | null>(null)
  const [editingRelation, setEditingRelation] = useState<
    MemoryProfileRelation | 'new' | null
  >(null)
  const [saving, setSaving] = useState(false)
  const [credentialForm] = Form.useForm<EmailCredentialSetRequest>()
  const [factForm] = Form.useForm<{
    label: string
    value: string
    emailType?: 'personal' | 'work' | 'unknown'
  }>()
  const [relationForm] = Form.useForm<{
    targetName: string
    relationType: string
  }>()
  const [emailAccountForm] = Form.useForm<{
    address: string
    type: 'personal' | 'work' | 'unknown'
  }>()

  const loadProfile = async () => {
    setLoading(true)
    try {
      setProfile(await window.emphant.getMemoryProfile())
      window.dispatchEvent(new CustomEvent('emphant:profile-updated'))
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '个人信息加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadProfile()
  }, [])

  const visibleFacts = useMemo(
    () =>
      profile?.facts.filter(
        (fact) =>
          !['name', 'email', 'personal_email', 'work_email'].includes(fact.predicate) &&
          !assistantFactPredicates.includes(fact.predicate)
      ) ?? [],
    [profile]
  )

  const openCredentialEditor = (email: MemoryEmailAccount) => {
    const defaults = getMailServerDefaults(email.address)
    setEditingEmail(email)
    credentialForm.setFieldsValue({
      email: email.address,
      credentialType: email.credentialType ?? 'app_password',
      secret: '',
      username: email.username ?? email.address,
      imapHost: email.imapHost ?? defaults.imapHost,
      imapPort: email.imapPort ?? defaults.imapPort,
      imapSecure: email.imapSecure ?? defaults.imapSecure,
      smtpHost: email.smtpHost ?? defaults.smtpHost,
      smtpPort: email.smtpPort ?? defaults.smtpPort,
      smtpSecure: email.smtpSecure ?? defaults.smtpSecure
    })
  }

  const openFactEditor = (fact?: MemoryProfileFact, label?: string) => {
    setEditingFact(fact ?? 'new')
    factForm.setFieldsValue({
      label:
        label ??
        (fact ? getFactLabel(fact.predicate) : ''),
      value: fact?.value ?? ''
    })
  }

  const saveFact = async () => {
    const values = await factForm.validateFields()
    const current = editingFact === 'new' ? undefined : editingFact ?? undefined
    const isEmail = current ? /email/.test(current.predicate) : false
    const predicate = current?.predicate.startsWith('custom:')
      ? `custom:${values.label.trim()}`
      : current?.predicate ?? `custom:${values.label.trim()}`
    setSaving(true)
    try {
      await window.emphant.updateMemoryProfileFact({
        id: current?.id,
        category: current?.category ?? (isEmail ? 'contact' : 'profile'),
        predicate,
        value: values.value
      })
      void message.success('个人信息已更新')
      setEditingFact(null)
      await loadProfile()
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '个人信息保存失败')
    } finally {
      setSaving(false)
    }
  }

  const deleteFact = async (fact: MemoryProfileFact) => {
    setSaving(true)
    try {
      await window.emphant.deleteMemoryProfileFact(fact.id)
      void message.success('个人信息已删除')
      setEditingFact(null)
      await loadProfile()
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '个人信息删除失败')
    } finally {
      setSaving(false)
    }
  }

  const openRelationEditor = (relation?: MemoryProfileRelation) => {
    setEditingRelation(relation ?? 'new')
    relationForm.setFieldsValue({
      targetName: relation?.targetName ?? '',
      relationType: relation?.relationType ?? 'friend'
    })
  }

  const saveRelation = async () => {
    const values = await relationForm.validateFields()
    const current = editingRelation === 'new' ? undefined : editingRelation ?? undefined
    setSaving(true)
    try {
      await window.emphant.updateMemoryProfileRelation({
        id: current?.id,
        targetEntityId: current?.targetEntityId,
        targetName: values.targetName,
        relationType: values.relationType
      })
      void message.success('人物关系已更新')
      setEditingRelation(null)
      await loadProfile()
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '人物关系保存失败')
    } finally {
      setSaving(false)
    }
  }

  const deleteRelation = async (relation: MemoryProfileRelation) => {
    setSaving(true)
    try {
      await window.emphant.deleteMemoryProfileRelation(relation.id)
      void message.success('人物关系已删除')
      setEditingRelation(null)
      await loadProfile()
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '人物关系删除失败')
    } finally {
      setSaving(false)
    }
  }

  const openEmailAccountEditor = (email?: MemoryEmailAccount) => {
    setEditingEmailAccount(email ?? 'new')
    emailAccountForm.setFieldsValue({
      address: email?.address ?? '',
      type: email?.type ?? 'personal'
    })
  }

  const saveEmailAccount = async () => {
    const values = await emailAccountForm.validateFields()
    const current =
      editingEmailAccount === 'new' ? undefined : editingEmailAccount ?? undefined
    const predicate =
      values.type === 'work'
        ? 'work_email'
        : values.type === 'personal'
          ? 'personal_email'
          : 'email'
    setSaving(true)
    try {
      await window.emphant.updateMemoryProfileFact({
        id: current?.sourceFactId,
        category: 'contact',
        predicate,
        value: values.address.trim().toLowerCase()
      })
      if (
        current?.credentialConfigured &&
        current.address.toLowerCase() !== values.address.trim().toLowerCase()
      ) {
        void message.warning('邮箱地址已修改，原地址的安全凭据未迁移，请为新邮箱重新配置')
      } else {
        void message.success('邮箱账户已更新')
      }
      setEditingEmailAccount(null)
      await loadProfile()
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '邮箱账户保存失败')
    } finally {
      setSaving(false)
    }
  }

  const deleteEmailAccount = async (email: MemoryEmailAccount) => {
    if (!email.sourceFactId) return
    setSaving(true)
    try {
      await window.emphant.deleteMemoryProfileFact(email.sourceFactId)
      if (email.credentialConfigured) {
        await window.emphant.deleteEmailCredential(email.address)
      }
      void message.success('邮箱账户及其安全凭据已删除')
      setEditingEmailAccount(null)
      await loadProfile()
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '邮箱账户删除失败')
    } finally {
      setSaving(false)
    }
  }

  const handleAvatarFile = async (file?: File) => {
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      void message.error('头像仅支持 PNG、JPEG 或 WebP')
      return
    }
    setSaving(true)
    try {
      await window.emphant.updateMemoryAvatar({
        mimeType: file.type as 'image/png' | 'image/jpeg' | 'image/webp',
        bytes: new Uint8Array(await file.arrayBuffer())
      })
      void message.success('头像已更新')
      await loadProfile()
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '头像更新失败')
    } finally {
      setSaving(false)
    }
  }

  const nameFact = profile?.facts.find((fact) => fact.predicate === 'name')

  const saveCredential = async () => {
    const values = await credentialForm.validateFields()
    setSaving(true)
    try {
      await window.emphant.setEmailCredential(values)
      void message.success('邮箱凭据已写入系统安全存储')
      setEditingEmail(null)
      await loadProfile()
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '邮箱凭据保存失败')
    } finally {
      setSaving(false)
    }
  }

  const deleteCredential = async (email: string) => {
    setSaving(true)
    try {
      await window.emphant.deleteEmailCredential(email)
      void message.success('邮箱凭据已删除')
      setEditingEmail(null)
      await loadProfile()
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '邮箱凭据删除失败')
    } finally {
      setSaving(false)
    }
  }

  if (loading && !profile) {
    return (
      <div className="profile-loading">
        <Spin size="large" />
      </div>
    )
  }

  return (
    <div className="profile-page">
      <Card className="workspace-panel profile-hero" bordered={false}>
        <div className="profile-avatar-editor">
          <Avatar
            size={72}
            src={profile?.avatarDataUrl}
            icon={!profile?.avatarDataUrl ? <UserOutlined /> : undefined}
          />
          <label className="profile-avatar-editor__button" aria-label="修改头像">
            <CameraOutlined />
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => {
                void handleAvatarFile(event.target.files?.[0])
                event.currentTarget.value = ''
              }}
            />
          </label>
        </div>
        <div>
          <span className="profile-hero__eyebrow">长期记忆画像</span>
          <Typography.Title level={2}>{profile?.userName ?? '尚未记录姓名'}</Typography.Title>
          <Typography.Paragraph type="secondary">
            这里展示系统在对话中逐渐形成的有效用户信息。邮箱凭据独立保存在系统安全存储中，
            不会写入长期记忆或以明文显示。
          </Typography.Paragraph>
        </div>
        <Space className="profile-hero__actions">
          <Button
            icon={<EditOutlined />}
            onClick={() =>
              openFactEditor(
                nameFact ?? {
                  id: '',
                  category: 'identity',
                  predicate: 'name',
                  value: profile?.userName ?? '',
                  confidence: 1,
                  importance: 1,
                  updatedAt: ''
                },
                '姓名'
              )
            }
          >
            编辑姓名
          </Button>
          {profile?.avatarDataUrl && (
            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={async () => {
                await window.emphant.deleteMemoryAvatar()
                await loadProfile()
              }}
            >
              删除头像
            </Button>
          )}
        </Space>
      </Card>

      <div className="profile-grid">
        <Card className="workspace-panel profile-section" bordered={false}>
          <div className="profile-section__header">
            <div>
              <Typography.Title level={4}>个人信息</Typography.Title>
              <Typography.Text type="secondary">来自对话中确认过的有效事实</Typography.Text>
            </div>
            <Tag color="blue">{visibleFacts.length} 项</Tag>
            <Button
              type="text"
              icon={<PlusOutlined />}
              aria-label="新增个人信息"
              onClick={() => openFactEditor()}
            />
          </div>
          {visibleFacts.length > 0 ? (
            <div className="profile-fact-list">
              {visibleFacts.map((fact) => (
                <div className="profile-fact" key={fact.id}>
                  <span>{getFactLabel(fact.predicate)}</span>
                  <strong>{fact.value}</strong>
                  <small>可信度 {Math.round(fact.confidence * 100)}%</small>
                  <Space size={2}>
                    <Button
                      type="text"
                      size="small"
                      icon={<EditOutlined />}
                      aria-label="编辑"
                      onClick={() => openFactEditor(fact)}
                    />
                    <Button
                      type="text"
                      danger
                      size="small"
                      icon={<DeleteOutlined />}
                      aria-label="删除"
                      onClick={() => void deleteFact(fact)}
                    />
                  </Space>
                </div>
              ))}
            </div>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未采集到更多个人信息" />
          )}
        </Card>

        <Card className="workspace-panel profile-section" bordered={false}>
          <div className="profile-section__header">
            <div>
              <Typography.Title level={4}>相关人物与关系</Typography.Title>
              <Typography.Text type="secondary">家人、朋友、同事和组织关系</Typography.Text>
            </div>
            <Tag>{profile?.relations.length ?? 0} 项</Tag>
            <Button
              type="text"
              icon={<PlusOutlined />}
              aria-label="新增人物关系"
              onClick={() => openRelationEditor()}
            />
          </div>
          {profile?.relations.length ? (
            <div className="profile-relation-list">
              {profile.relations.map((relation) => (
                <div className="profile-relation" key={relation.id}>
                  <span>{relation.sourceName}</span>
                  <Tag bordered={false}>
                    {relationLabels[relation.relationType] ?? relation.relationType}
                  </Tag>
                  <strong>{relation.targetName}</strong>
                  <Space size={2}>
                    <Button
                      type="text"
                      size="small"
                      icon={<EditOutlined />}
                      aria-label="编辑人物关系"
                      onClick={() => openRelationEditor(relation)}
                    />
                    <Button
                      type="text"
                      danger
                      size="small"
                      icon={<DeleteOutlined />}
                      aria-label="删除人物关系"
                      onClick={() => void deleteRelation(relation)}
                    />
                  </Space>
                </div>
              ))}
            </div>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未采集到人物关系" />
          )}
        </Card>
      </div>

      <Card className="workspace-panel profile-section profile-email-section" bordered={false}>
        <div className="profile-section__header">
          <div>
            <Typography.Title level={4}>邮箱账户</Typography.Title>
            <Typography.Text type="secondary">
              区分个人邮箱和工作邮箱；安全凭据供后续检查新邮件或发送邮件使用
            </Typography.Text>
          </div>
          <Tag icon={<SafetyCertificateOutlined />} color="green">
            系统加密存储
          </Tag>
          <Button
            type="text"
            icon={<PlusOutlined />}
            aria-label="新增邮箱账户"
            onClick={() => openEmailAccountEditor()}
          />
        </div>
        {profile?.emails.length ? (
          <div className="profile-email-grid">
            {profile.emails.map((email) => (
              <div className="profile-email-card" key={email.address}>
                <div className="profile-email-card__icon">
                  <MailOutlined />
                </div>
                <div className="profile-email-card__body">
                  <Space wrap size={6}>
                    <strong>{email.address}</strong>
                    <Tag color={email.type === 'work' ? 'purple' : 'blue'}>
                      {emailTypeLabels[email.type]}
                    </Tag>
                  </Space>
                  <span>
                    {email.credentialConfigured
                      ? `${credentialTypeLabels[email.credentialType ?? 'password']}：•••••••• · ${
                          email.imapHost && email.smtpHost
                            ? 'IMAP/SMTP 已配置'
                            : '待补充服务器配置'
                        }`
                      : '尚未配置密码或 Key'}
                  </span>
                </div>
                <Button
                  icon={<KeyOutlined />}
                  onClick={() => openCredentialEditor(email)}
                >
                  {email.credentialConfigured ? '替换凭据' : '配置凭据'}
                </Button>
                {email.sourceFactId && (
                  <Button
                    type="text"
                    icon={<EditOutlined />}
                    aria-label="编辑邮箱"
                    onClick={() => openEmailAccountEditor(email)}
                  />
                )}
              </div>
            ))}
          </div>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="尚未在对话中采集到邮箱地址"
          />
        )}
      </Card>

      <Modal
        open={Boolean(editingEmail)}
        title={`邮箱凭据 · ${editingEmail?.address ?? ''}`}
        onCancel={() => setEditingEmail(null)}
        footer={[
          editingEmail?.credentialConfigured ? (
            <Button
              danger
              key="delete"
              loading={saving}
              onClick={() => void deleteCredential(editingEmail.address)}
            >
              删除凭据
            </Button>
          ) : null,
          <Button key="cancel" onClick={() => setEditingEmail(null)}>
            取消
          </Button>,
          <Button
            key="save"
            type="primary"
            loading={saving}
            onClick={() => void saveCredential()}
          >
            保存到安全存储
          </Button>
        ]}
      >
        <Typography.Paragraph type="secondary">
          IMAP 用于收取邮件，SMTP 用于发送邮件。密码或授权码只会加密保存在本机，
          不会进入聊天记录、Redux、长期记忆或页面返回值。
        </Typography.Paragraph>
        <Form layout="vertical" form={credentialForm}>
          <Form.Item name="email" hidden>
            <Input />
          </Form.Item>
          <Form.Item label="凭据类型" name="credentialType" rules={[{ required: true }]}>
            <Select
              options={[
                { label: '应用专用密码（推荐）', value: 'app_password' },
                { label: 'API Key / Access Token', value: 'api_key' },
                { label: '账号密码', value: 'password' }
              ]}
            />
          </Form.Item>
          <Form.Item label="登录用户名" name="username" rules={[{ required: true }]}>
            <Input placeholder="通常与邮箱地址相同" />
          </Form.Item>
          <div className="email-server-config">
            <div className="email-server-config__title">
              <strong>IMAP 收件服务器</strong>
              <Form.Item name="imapSecure" valuePropName="checked" noStyle>
                <Switch checkedChildren="TLS" unCheckedChildren="STARTTLS" />
              </Form.Item>
            </div>
            <div className="email-server-config__fields">
              <Form.Item label="服务器" name="imapHost" rules={[{ required: true }]}>
                <Input placeholder="imap.example.com" />
              </Form.Item>
              <Form.Item label="端口" name="imapPort" rules={[{ required: true }]}>
                <InputNumber min={1} max={65535} style={{ width: '100%' }} />
              </Form.Item>
            </div>
          </div>
          <div className="email-server-config">
            <div className="email-server-config__title">
              <strong>SMTP 发件服务器</strong>
              <Form.Item name="smtpSecure" valuePropName="checked" noStyle>
                <Switch checkedChildren="TLS" unCheckedChildren="STARTTLS" />
              </Form.Item>
            </div>
            <div className="email-server-config__fields">
              <Form.Item label="服务器" name="smtpHost" rules={[{ required: true }]}>
                <Input placeholder="smtp.example.com" />
              </Form.Item>
              <Form.Item label="端口" name="smtpPort" rules={[{ required: true }]}>
                <InputNumber min={1} max={65535} style={{ width: '100%' }} />
              </Form.Item>
            </div>
          </div>
          <Form.Item
            label="密码或授权码"
            name="secret"
            rules={[
              {
                required: !editingEmail?.credentialConfigured,
                message: '首次配置请输入密码或授权码'
              }
            ]}
            extra={
              editingEmail?.credentialConfigured
                ? '留空将保留原密码或授权码'
                : '推荐使用邮箱服务商提供的应用专用密码或客户端授权码'
            }
          >
            <Input.Password
              autoComplete="new-password"
              placeholder={
                editingEmail?.credentialConfigured
                  ? '留空保留原凭据'
                  : '输入后将立即加密保存'
              }
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={Boolean(editingRelation)}
        title={editingRelation === 'new' ? '新增人物关系' : '编辑人物关系'}
        onCancel={() => setEditingRelation(null)}
        footer={[
          editingRelation && editingRelation !== 'new' ? (
            <Button
              danger
              key="delete"
              loading={saving}
              onClick={() => void deleteRelation(editingRelation)}
            >
              删除关系
            </Button>
          ) : null,
          <Button key="cancel" onClick={() => setEditingRelation(null)}>
            取消
          </Button>,
          <Button
            key="save"
            type="primary"
            loading={saving}
            onClick={() => void saveRelation()}
          >
            保存
          </Button>
        ]}
      >
        <Form layout="vertical" form={relationForm}>
          <Form.Item label="人物姓名" name="targetName" rules={[{ required: true }]}>
            <Input placeholder="例如：林宁" />
          </Form.Item>
          <Form.Item label="与用户的关系" name="relationType" rules={[{ required: true }]}>
            <Select
              showSearch
              options={Object.entries(relationLabels).map(([value, label]) => ({
                value,
                label
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={Boolean(editingEmailAccount)}
        title={editingEmailAccount === 'new' ? '新增邮箱账户' : '编辑邮箱账户'}
        onCancel={() => setEditingEmailAccount(null)}
        footer={[
          editingEmailAccount && editingEmailAccount !== 'new' ? (
            <Button
              danger
              key="delete"
              loading={saving}
              onClick={() => void deleteEmailAccount(editingEmailAccount)}
            >
              删除邮箱
            </Button>
          ) : null,
          <Button key="cancel" onClick={() => setEditingEmailAccount(null)}>
            取消
          </Button>,
          <Button
            key="save"
            type="primary"
            loading={saving}
            onClick={() => void saveEmailAccount()}
          >
            保存
          </Button>
        ]}
      >
        <Form layout="vertical" form={emailAccountForm}>
          <Form.Item
            label="邮箱地址"
            name="address"
            rules={[
              { required: true },
              { type: 'email', message: '请输入有效的邮箱地址' }
            ]}
          >
            <Input placeholder="name@example.com" />
          </Form.Item>
          <Form.Item label="邮箱类型" name="type" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'personal', label: '个人邮箱' },
                { value: 'work', label: '工作邮箱' },
                { value: 'unknown', label: '未分类邮箱' }
              ]}
            />
          </Form.Item>
          {editingEmailAccount !== 'new' &&
            editingEmailAccount?.credentialConfigured && (
              <Typography.Paragraph type="secondary">
                修改邮箱地址不会迁移原地址的密码或 Key，防止凭据绑定到错误账户。
              </Typography.Paragraph>
            )}
        </Form>
      </Modal>

      <Modal
        open={Boolean(editingFact)}
        title={editingFact === 'new' ? '新增个人信息' : '编辑个人信息'}
        onCancel={() => setEditingFact(null)}
        footer={[
          editingFact && editingFact !== 'new' && editingFact.id ? (
            <Button
              danger
              key="delete"
              loading={saving}
              onClick={() => void deleteFact(editingFact)}
            >
              删除
            </Button>
          ) : null,
          <Button key="cancel" onClick={() => setEditingFact(null)}>
            取消
          </Button>,
          <Button
            key="save"
            type="primary"
            loading={saving}
            onClick={() => void saveFact()}
          >
            保存
          </Button>
        ]}
      >
        <Form layout="vertical" form={factForm}>
          <Form.Item label="项目名称" name="label" rules={[{ required: true }]}>
            <Input
              disabled={
                editingFact !== 'new' &&
                editingFact !== null &&
                !editingFact.predicate.startsWith('custom:')
              }
            />
          </Form.Item>
          <Form.Item label="内容" name="value" rules={[{ required: true }]}>
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
