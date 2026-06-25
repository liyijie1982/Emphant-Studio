import {
  CameraOutlined,
  DeleteOutlined,
  RobotOutlined
} from '@ant-design/icons'
import {
  App,
  Avatar,
  Button,
  Card,
  Form,
  Input,
  Select,
  Spin,
  Tag,
  Typography
} from 'antd'
import { useEffect, useState } from 'react'
import type { MemoryProfile } from '@emphant/shared/types'

const assistantGenderOptions = [
  { value: '不指定', label: '不指定' },
  { value: '女性', label: '女性' },
  { value: '男性', label: '男性' },
  { value: '中性', label: '中性' }
]

const assistantToneOptions = [
  { value: '自然、清晰、温暖', label: '自然、清晰、温暖' },
  { value: '专业、克制、高效', label: '专业、克制、高效' },
  { value: '活泼、鼓励、有陪伴感', label: '活泼、鼓励、有陪伴感' },
  { value: '简洁、直接、少解释', label: '简洁、直接、少解释' }
]

export const ProfileSettingsPage = () => {
  const { message } = App.useApp()
  const [profile, setProfile] = useState<MemoryProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [assistantForm] = Form.useForm<{
    name: string
    gender: string
    personality: string
    tone: string
  }>()

  const loadProfile = async () => {
    setLoading(true)
    try {
      setProfile(await window.emphant.getMemoryProfile())
      window.dispatchEvent(new CustomEvent('emphant:profile-updated'))
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '个人设置加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadProfile()
  }, [])

  useEffect(() => {
    assistantForm.setFieldsValue({
      name: profile?.assistantProfile?.name ?? '',
      gender: profile?.assistantProfile?.gender ?? '不指定',
      personality: profile?.assistantProfile?.personality ?? '',
      tone: profile?.assistantProfile?.tone ?? '自然、清晰、温暖'
    })
  }, [assistantForm, profile])

  const getProfileFact = (predicate: string) =>
    profile?.facts.find((fact) => fact.predicate === predicate)

  const upsertOptionalFact = async ({
    predicate,
    value
  }: {
    predicate: string
    value?: string
  }) => {
    const current = getProfileFact(predicate)
    const trimmed = value?.trim() ?? ''
    if (!trimmed) {
      if (current) {
        await window.emphant.deleteMemoryProfileFact(current.id)
      }
      return
    }

    await window.emphant.updateMemoryProfileFact({
      id: current?.id,
      category: 'assistant_profile',
      predicate,
      value: trimmed
    })
  }

  const saveAssistantProfile = async () => {
    const values = await assistantForm.validateFields()
    setSaving(true)
    try {
      await Promise.all([
        upsertOptionalFact({ predicate: 'assistant_name', value: values.name }),
        upsertOptionalFact({ predicate: 'assistant_gender', value: values.gender }),
        upsertOptionalFact({ predicate: 'assistant_personality', value: values.personality }),
        upsertOptionalFact({ predicate: 'assistant_tone', value: values.tone })
      ])
      void message.success('AI 助理设定已更新')
      await loadProfile()
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'AI 助理设定保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleAssistantAvatarFile = async (file?: File) => {
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      void message.error('AI 助理头像仅支持 PNG、JPEG 或 WebP')
      return
    }
    if (file.size > 1024 * 1024) {
      void message.error('AI 助理头像不能超过 1 MB')
      return
    }

    setSaving(true)
    try {
      const buffer = await file.arrayBuffer()
      const base64 = window.btoa(
        Array.from(new Uint8Array(buffer), (byte) => String.fromCharCode(byte)).join('')
      )
      await upsertOptionalFact({
        predicate: 'assistant_avatar_data_url',
        value: `data:${file.type};base64,${base64}`
      })
      void message.success('AI 助理头像已更新')
      await loadProfile()
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'AI 助理头像更新失败')
    } finally {
      setSaving(false)
    }
  }

  const deleteAssistantAvatar = async () => {
    const current = getProfileFact('assistant_avatar_data_url')
    if (!current) return
    setSaving(true)
    try {
      await window.emphant.deleteMemoryProfileFact(current.id)
      void message.success('AI 助理头像已删除')
      await loadProfile()
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'AI 助理头像删除失败')
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
      <Card className="workspace-panel profile-section assistant-profile-section" bordered={false}>
        <div className="profile-section__header">
          <div>
            <Typography.Title level={4}>个人设置</Typography.Title>
            <Typography.Text type="secondary">
              AI 助理设定会影响工作台中的显示头像、名称和回答语气偏好
            </Typography.Text>
          </div>
          <Tag color="cyan">AI 助理设定</Tag>
        </div>
        <div className="assistant-profile-editor">
          <div className="assistant-profile-editor__avatar">
            <Avatar
              size={72}
              src={profile?.assistantProfile?.avatarDataUrl}
              icon={!profile?.assistantProfile?.avatarDataUrl ? <RobotOutlined /> : undefined}
            />
            <label className="profile-avatar-editor__button" aria-label="修改 AI 助理头像">
              <CameraOutlined />
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  void handleAssistantAvatarFile(event.target.files?.[0])
                  event.currentTarget.value = ''
                }}
              />
            </label>
            {profile?.assistantProfile?.avatarDataUrl && (
              <Button
                type="text"
                danger
                size="small"
                icon={<DeleteOutlined />}
                loading={saving}
                onClick={() => void deleteAssistantAvatar()}
              >
                删除头像
              </Button>
            )}
          </div>
          <Form layout="vertical" form={assistantForm} className="assistant-profile-form">
            <div className="assistant-profile-form__grid">
              <Form.Item label="助理名称" name="name">
                <Input placeholder="例如：小澈" maxLength={24} />
              </Form.Item>
              <Form.Item label="助理性别" name="gender">
                <Select options={assistantGenderOptions} />
              </Form.Item>
            </div>
            <Form.Item label="性格" name="personality">
              <Input.TextArea
                rows={3}
                maxLength={200}
                placeholder="例如：耐心、细致、有边界感，喜欢先帮我理清问题再给建议"
              />
            </Form.Item>
            <Form.Item label="语气偏好" name="tone">
              <Select
                showSearch
                options={assistantToneOptions}
                placeholder="选择或输入语气偏好"
              />
            </Form.Item>
            <Button
              type="primary"
              loading={saving}
              onClick={() => void saveAssistantProfile()}
            >
              保存 AI 助理设定
            </Button>
          </Form>
        </div>
      </Card>
    </div>
  )
}
