import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  SearchOutlined,
  UnorderedListOutlined
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
  Tag,
  Tooltip,
  Typography
} from 'antd'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { TodoItem, TodoStatus } from '@emphant/shared/types'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  createTodoGroup,
  createTodoItem,
  deleteTodoGroup,
  deleteTodoItem,
  runTodoTask,
  selectActiveTodoTaskId,
  selectTodoGroups,
  selectTodoItems,
  setActiveTopic,
  updateTodoItem
} from '@/store/workbenchSlice'

type TaskGroupFilter = 'all' | string

type TodoFormValues = {
  title: string
  description?: string
  taskGroup?: string
  scheduledAt?: string
}

type TodoGroupFormValues = {
  sourceText: string
}

const statusLabel: Record<TodoStatus, string> = {
  pending: '待执行',
  scheduled: '已定时',
  running: '执行中',
  completed: '已完成',
  failed: '失败'
}

const statusColor: Record<TodoStatus, string> = {
  pending: 'default',
  scheduled: 'blue',
  running: 'processing',
  completed: 'success',
  failed: 'error'
}

const formatDateTime = (value?: string) =>
  value ? new Date(value).toLocaleString() : '未设置'

const normalizeDateTimeValue = (value?: string) =>
  value ? value.slice(0, 16) : ''

const deriveTaskGroupName = (sourceText: string) => {
  const cleaned = sourceText
    .replace(/^(请|帮我|麻烦)?(把|将)?/u, '')
    .replace(/(加入|添加|写入|生成|整理).*(TODO|待办|任务清单).*$/iu, '')
    .trim()
  const firstMeaningfulLine =
    cleaned
      .split(/\n+|[；;。]/)
      .map((item) => item.replace(/^[-*、\d.\s]+/, '').trim())
      .find((item) => item.length >= 2) ||
    cleaned ||
    sourceText
  const title = firstMeaningfulLine
    .replace(/[，,：:].*$/u, '')
    .replace(/^(关于|围绕|针对|处理|完成|执行|规划|拆分)/u, '')
    .trim()
  const shortTitle = Array.from(title || '默认').slice(0, 14).join('')
  return shortTitle.endsWith('任务组') ? shortTitle : `${shortTitle}任务组`
}

export const TodoPage = () => {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const { message: messageApi } = App.useApp()
  const todoItems = useAppSelector(selectTodoItems)
  const storedTodoGroups = useAppSelector(selectTodoGroups)
  const activeTodoTaskId = useAppSelector(selectActiveTodoTaskId)
  const [taskGroupFilter, setTaskGroupFilter] = useState<TaskGroupFilter>('all')
  const [query, setQuery] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [createGroupOpen, setCreateGroupOpen] = useState(false)
  const [form] = Form.useForm<TodoFormValues>()
  const [groupForm] = Form.useForm<TodoGroupFormValues>()

  const taskGroups = useMemo(() => {
    const unique = Array.from(
      new Set([
        ...storedTodoGroups,
        ...todoItems.map((item) => item.taskGroup)
      ].filter(Boolean))
    )
    return ['all', ...unique]
  }, [storedTodoGroups, todoItems])

  const selectableTaskGroups = useMemo(
    () => taskGroups.filter((taskGroup) => taskGroup !== 'all'),
    [taskGroups]
  )

  const filteredTodoItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()

    return todoItems.filter((item) => {
      const matchesTaskGroup =
        taskGroupFilter === 'all' || item.taskGroup === taskGroupFilter
      const matchesQuery =
        !normalizedQuery ||
        [item.title, item.description, item.taskGroup, statusLabel[item.status]].some(
          (value) => value.toLowerCase().includes(normalizedQuery)
        )

      return matchesTaskGroup && matchesQuery
    })
  }, [query, taskGroupFilter, todoItems])

  const handleCreate = async () => {
    const values = await form.validateFields()
    dispatch(
      createTodoItem({
        title: values.title,
        description: values.description,
        taskGroup: values.taskGroup,
        scheduledAt: values.scheduledAt
      })
    )
    setTaskGroupFilter('all')
    setCreateOpen(false)
    form.resetFields()
  }

  const handleCreateTaskGroup = async () => {
    const values = await groupForm.validateFields()
    const taskGroup = deriveTaskGroupName(values.sourceText)
    dispatch(createTodoGroup({ sourceText: values.sourceText }))
    setTaskGroupFilter(taskGroup)
    setCreateGroupOpen(false)
    groupForm.resetFields()
    void messageApi.success(`任务组「${taskGroup}」已创建`)
  }

  const handleRun = async (item: TodoItem) => {
    try {
      await dispatch(runTodoTask(item.id)).unwrap()
      void messageApi.success('TODO 已执行完成')
      navigate('/')
    } catch (error) {
      void messageApi.error(error instanceof Error ? error.message : 'TODO 启动失败')
    }
  }

  const handleOpenTopic = (item: TodoItem) => {
    if (!item.workspaceTopicId) {
      return
    }
    dispatch(setActiveTopic(item.workspaceTopicId))
    navigate('/')
  }

  const updateSchedule = (item: TodoItem, scheduledAt: string) => {
    dispatch(
      updateTodoItem({
        todoId: item.id,
        patch: {
          scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined
        }
      })
    )
  }

  const handleDeleteTodo = (item: TodoItem) => {
    dispatch(deleteTodoItem(item.id))
    void messageApi.success('TODO 已删除')
  }

  const handleDeleteTaskGroup = (taskGroup: string) => {
    const groupItems = todoItems.filter((item) => item.taskGroup === taskGroup)
    if (groupItems.some((item) => item.status === 'running')) {
      void messageApi.warning('该任务组中有正在执行的 TODO，暂不能删除')
      return
    }
    dispatch(deleteTodoGroup(taskGroup))
    if (taskGroupFilter === taskGroup) {
      setTaskGroupFilter('all')
    }
    void messageApi.success('任务组已删除')
  }

  return (
    <>
      <section className="todo-layout">
        <Card className="workspace-panel todo-sidebar" bordered={false}>
          <div className="panel-header todo-sidebar__header">
            <Typography.Title level={4}>TODO</Typography.Title>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              aria-label="新建任务组"
              onClick={() => setCreateGroupOpen(true)}
            />
          </div>

          <Input
            allowClear
            value={query}
            prefix={<SearchOutlined />}
            placeholder="搜索任务"
            onChange={(event) => setQuery(event.target.value)}
            className="sidebar-list-search"
          />

          <nav className="todo-category-list" aria-label="TODO 任务组">
            {taskGroups.map((taskGroup) => {
              const count = todoItems.filter(
                (item) => taskGroup === 'all' || item.taskGroup === taskGroup
              ).length
              const label = taskGroup === 'all' ? '全部任务' : taskGroup

              const canDeleteGroup =
                taskGroup !== 'all' &&
                todoItems.some((item) => item.taskGroup === taskGroup)

              return (
                <div
                  key={taskGroup}
                  className={
                    taskGroupFilter === taskGroup
                      ? 'todo-category-item is-active'
                      : 'todo-category-item'
                  }
                >
                  <button
                    type="button"
                    className="todo-category-item__main"
                    onClick={() => setTaskGroupFilter(taskGroup)}
                  >
                    <span>
                      <UnorderedListOutlined />
                      {label}
                    </span>
                  </button>
                  <span className="todo-category-item__meta">
                    <small>{count}</small>
                    {canDeleteGroup && (
                      <Popconfirm
                        title={`删除任务组 ${label}？`}
                        description="该任务组下的 TODO 任务也会一并删除。"
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => handleDeleteTaskGroup(taskGroup)}
                      >
                        <Tooltip title="删除任务组">
                          <Button
                            type="text"
                            size="small"
                            danger
                            icon={<DeleteOutlined />}
                            aria-label={`删除任务组 ${label}`}
                          />
                        </Tooltip>
                      </Popconfirm>
                    )}
                  </span>
                </div>
              )
            })}
          </nav>
        </Card>

        <Card className="workspace-panel todo-content" bordered={false}>
          <div className="todo-content__header">
            <div>
              <Typography.Title level={4}>系统 TODO</Typography.Title>
              <Typography.Text type="secondary">
                按任务组管理任务，支持定时发送到工作台执行或手动启动。
              </Typography.Text>
            </div>
            {activeTodoTaskId && (
              <Tag color="processing" bordered={false}>
                工作台正在执行 TODO
              </Tag>
            )}
          </div>

          <div className="todo-workspace">
            <div className="todo-list-column">
              <div className="todo-list-column__header">
                <div>
                  <strong>任务列表</strong>
                  <span>{filteredTodoItems.length} 项任务</span>
                </div>
                <Button icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
                  新建任务
                </Button>
              </div>

              <div className="todo-items">
                {filteredTodoItems.map((item) => (
                  <article key={item.id} className={`todo-item status-${item.status}`}>
                    <div className="todo-item__content">
                      <div className="todo-item__title">
                        <strong>{item.title}</strong>
                        <Tag bordered={false}>{item.taskGroup}</Tag>
                        <Tag bordered={false} color={statusColor[item.status]}>
                          {statusLabel[item.status]}
                        </Tag>
                      </div>
                      <p>{item.description || '暂未补充任务说明。'}</p>
                      <div className="todo-item__meta">
                        {item.scheduledAt ? <ClockCircleOutlined /> : <CheckCircleOutlined />}
                        <span>定时执行：{formatDateTime(item.scheduledAt)}</span>
                        {item.completedAt && <span>完成：{formatDateTime(item.completedAt)}</span>}
                      </div>
                      {item.resultSummary && (
                        <p className="todo-item__result">{item.resultSummary}</p>
                      )}
                      {item.errorMessage && (
                        <p className="todo-item__error">{item.errorMessage}</p>
                      )}
                    </div>

                    <div className="todo-item__controls">
                      <label>
                        <span>定时发送到工作台</span>
                        <Input
                          type="datetime-local"
                          value={normalizeDateTimeValue(item.scheduledAt)}
                          aria-label={`${item.title} 定时执行时间`}
                          disabled={item.status === 'running' || item.status === 'completed'}
                          onChange={(event) => updateSchedule(item, event.target.value)}
                        />
                      </label>
                      <Space size={8} className="todo-item__actions">
                        <Button
                          icon={<PlayCircleOutlined />}
                          type="primary"
                          disabled={
                            item.status === 'completed' ||
                            (Boolean(activeTodoTaskId) && activeTodoTaskId !== item.id)
                          }
                          loading={item.status === 'running'}
                          onClick={() => void handleRun(item)}
                        >
                          手动执行
                        </Button>
                        <Button
                          disabled={!item.workspaceTopicId}
                          onClick={() => handleOpenTopic(item)}
                        >
                          工作台任务
                        </Button>
                        <Popconfirm
                          title={`删除 TODO ${item.title}？`}
                          description="删除后不会删除已经生成的工作台会话。"
                          okText="删除"
                          cancelText="取消"
                          okButtonProps={{ danger: true }}
                          disabled={item.status === 'running'}
                          onConfirm={() => handleDeleteTodo(item)}
                        >
                          <Button
                            danger
                            icon={<DeleteOutlined />}
                            disabled={item.status === 'running'}
                          >
                            删除
                          </Button>
                        </Popconfirm>
                      </Space>
                    </div>
                  </article>
                ))}

                {filteredTodoItems.length === 0 && (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="暂无匹配的 TODO"
                  />
                )}
              </div>
            </div>
          </div>
        </Card>
      </section>

      <Modal
        open={createOpen}
        title="新建 TODO"
        okText="添加任务"
        cancelText="取消"
        onCancel={() => setCreateOpen(false)}
        onOk={() => void handleCreate()}
      >
        <Form
          form={form}
          layout="vertical"
        >
          <div className="todo-create-grid">
            <Form.Item label="任务名称" name="title" rules={[{ required: true }]}>
              <Input placeholder="例如：整理下周发布计划" />
            </Form.Item>
            <Form.Item
              label="任务组"
              name="taskGroup"
            >
              <Select
                showSearch
                allowClear
                placeholder="不选择则根据任务内容自动生成"
                options={selectableTaskGroups.map((taskGroup) => ({
                  value: taskGroup,
                  label: taskGroup
                }))}
              />
            </Form.Item>
          </div>
          <Form.Item label="任务说明" name="description">
            <Input.TextArea rows={4} placeholder="补充执行目标、上下文或完成标准" />
          </Form.Item>
          <Form.Item label="定时发送到工作台" name="scheduledAt">
            <Input type="datetime-local" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={createGroupOpen}
        title="新建任务组"
        okText="创建任务组"
        cancelText="取消"
        onCancel={() => {
          setCreateGroupOpen(false)
          groupForm.resetFields()
        }}
        onOk={() => void handleCreateTaskGroup()}
      >
        <Form form={groupForm} layout="vertical">
          <Form.Item
            label="任务内容"
            name="sourceText"
            rules={[{ required: true, message: '请描述这组任务的内容' }]}
          >
            <Input.TextArea
              rows={5}
              placeholder="描述这组任务要解决的目标、背景或任务内容，系统会据此生成任务组名"
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
