import { BellOutlined, UserOutlined } from '@ant-design/icons'
import { Avatar, Badge, Button, Dropdown, Empty, Popover, Space, Typography } from 'antd'
import type { MenuProps } from 'antd'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWindowDrag } from '@/hooks/useWindowDrag'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  createMailTask,
  markTodoNotificationRead,
  selectUnreadMailNotifications,
  selectUnreadTodoNotifications,
  setActiveTopic
} from '@/store/workbenchSlice'

type AppNavbarProps = {
  onLogout: () => void
}

export const AppNavbar = ({ onLogout }: AppNavbarProps) => {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const unreadMails = useAppSelector(selectUnreadMailNotifications)
  const unreadTodoNotifications = useAppSelector(selectUnreadTodoNotifications)
  const notificationCount = unreadMails.length + unreadTodoNotifications.length
  const [avatarDataUrl, setAvatarDataUrl] = useState<string>()
  const [notificationOpen, setNotificationOpen] = useState(false)
  const startWindowDrag = useWindowDrag()
  const mailTypeLabel = (type: 'personal' | 'work' | 'unknown') =>
    type === 'work' ? '公司邮件' : type === 'personal' ? '个人邮件' : '其他邮件'
  useEffect(() => {
    const loadAvatar = () => {
      void window.emphant
        .getMemoryProfile()
        .then((profile) => setAvatarDataUrl(profile.avatarDataUrl))
        .catch(() => undefined)
    }
    loadAvatar()
    window.addEventListener('emphant:profile-updated', loadAvatar)
    return () => window.removeEventListener('emphant:profile-updated', loadAvatar)
  }, [])
  const userMenuItems: MenuProps['items'] = [
    {
      key: 'profile-info',
      label: '个人信息'
    },
    {
      key: 'profile-settings',
      label: '个人设置'
    },
    {
      key: 'lock-vault',
      label: '锁定保险箱'
    },
    {
      key: 'logout',
      label: '退出登录'
    }
  ]

  return (
    <header className="app-navbar" data-tauri-drag-region="" onMouseDown={startWindowDrag}>
      <div className="app-navbar__intro" data-tauri-drag-region="" onMouseDown={startWindowDrag}>
        <Typography.Title level={4} style={{ margin: 0 }} data-tauri-drag-region="">
          Emphant Studio
        </Typography.Title>
        <Typography.Text type="secondary" data-tauri-drag-region="">
          管理对话、知识、任务和自动化动作
        </Typography.Text>
      </div>
      <Space size={12} className="app-navbar__actions">
        <Popover
          open={notificationOpen}
          onOpenChange={setNotificationOpen}
          trigger="click"
          placement="bottomRight"
          content={
            <div className="mail-notification-popover">
              <div className="mail-notification-popover__header">
                <strong>消息通知</strong>
                <span>{notificationCount} 条</span>
              </div>
              {notificationCount > 0 ? (
                <div className="mail-notification-list">
                  {unreadTodoNotifications.map((notification) => (
                    <button
                      type="button"
                      key={notification.id}
                      onClick={() => {
                        dispatch(markTodoNotificationRead(notification.id))
                        if (notification.topicId) {
                          dispatch(setActiveTopic(notification.topicId))
                          navigate('/')
                        } else if (notification.todoId) {
                          navigate('/todo')
                        } else {
                          setNotificationOpen(false)
                          return
                        }
                        setNotificationOpen(false)
                      }}
                    >
                      <strong>{notification.title}</strong>
                      <span>{notification.message}</span>
                    </button>
                  ))}
                  {unreadMails.map((mail) => (
                    <button
                      type="button"
                      key={mail.id}
                      onClick={() => {
                        dispatch(createMailTask(mail.id))
                        setNotificationOpen(false)
                        navigate('/')
                      }}
                    >
                      <strong>
                        <em className={`mail-type-label is-${mail.accountType}`}>
                          {mailTypeLabel(mail.accountType)}
                        </em>
                        {mail.subject}
                      </strong>
                      <span>{mail.sender} · {mail.senderEmail}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="没有新通知"
                />
              )}
            </div>
          }
        >
          <Badge count={notificationCount} size="small" offset={[-2, 2]}>
            <Button
              shape="circle"
              icon={<BellOutlined />}
              aria-label={`通知，${notificationCount} 条未读消息`}
            />
          </Badge>
        </Popover>
        <Dropdown
          menu={{
            items: userMenuItems,
            onClick: ({ key }) => {
              if (key === 'profile-info') navigate('/profile')
              if (key === 'profile-settings') navigate('/profile/settings')
              if (key === 'lock-vault') onLogout()
              if (key === 'logout') onLogout()
            }
          }}
          trigger={['click']}
          placement="bottomRight"
        >
          <Button
            shape="circle"
            className="app-navbar__profile-button"
            icon={
              <Avatar
                size={28}
                src={avatarDataUrl}
                icon={!avatarDataUrl ? <UserOutlined /> : undefined}
              />
            }
            aria-label="用户菜单"
          />
        </Dropdown>
      </Space>
    </header>
  )
}
