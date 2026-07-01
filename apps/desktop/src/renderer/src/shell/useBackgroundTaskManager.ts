import { useEffect, useRef } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  addMailCheckErrorNotification,
  applyMailCheckResult,
  runTodoTask,
  selectActiveTodoTaskId,
  selectMailAgentSettings,
  selectTodoItems,
  updateMailAgentSettings
} from '@/store/workbenchSlice'

export const useBackgroundTaskManager = ({
  enabled,
  vaultUnlocked
}: {
  enabled: boolean
  vaultUnlocked: boolean
}) => {
  const dispatch = useAppDispatch()
  const mailAgentSettings = useAppSelector(selectMailAgentSettings)
  const todoItems = useAppSelector(selectTodoItems)
  const activeTodoTaskId = useAppSelector(selectActiveTodoTaskId)
  const scheduledTodoRunIdsRef = useRef(new Set<string>())

  useEffect(() => {
    if (!enabled || !mailAgentSettings.enabled || !vaultUnlocked) return

    let checking = false
    const checkAllAccounts = async () => {
      if (checking) return
      checking = true
      try {
        const profile = await window.emphant.getMemoryProfile()
        const configuredEmails = profile.emails.filter((email) => email.credentialConfigured)
        if (
          configuredEmails.length > 0 &&
          !configuredEmails.some((email) => email.address === mailAgentSettings.accountEmail)
        ) {
          dispatch(updateMailAgentSettings({ accountEmail: configuredEmails[0].address }))
        }
        dispatch(applyMailCheckResult(await window.emphant.checkAllEmailAccounts()))
      } catch (error) {
        console.error('Failed to check email accounts', error)
        dispatch(
          addMailCheckErrorNotification({
            message: error instanceof Error ? error.message : '邮件检查失败'
          })
        )
      } finally {
        checking = false
      }
    }

    void checkAllAccounts()
    const intervalMs = Math.max(mailAgentSettings.checkIntervalMinutes, 1) * 60_000
    const timerId = window.setInterval(() => {
      void checkAllAccounts()
    }, intervalMs)

    return () => window.clearInterval(timerId)
  }, [
    dispatch,
    enabled,
    mailAgentSettings.accountEmail,
    mailAgentSettings.checkIntervalMinutes,
    mailAgentSettings.enabled,
    vaultUnlocked
  ])

  useEffect(() => {
    if (!enabled) return

    const runDueTodo = () => {
      if (activeTodoTaskId) {
        return
      }
      const dueTodo = todoItems.find((item) => {
        if (!item.scheduledAt || item.status !== 'scheduled') {
          return false
        }
        if (scheduledTodoRunIdsRef.current.has(item.id)) {
          return false
        }
        return Date.parse(item.scheduledAt) <= Date.now()
      })
      if (!dueTodo) {
        return
      }
      scheduledTodoRunIdsRef.current.add(dueTodo.id)
      void dispatch(runTodoTask(dueTodo.id))
        .unwrap()
        .catch((error) => {
          console.error('Failed to run scheduled TODO', error)
        })
        .finally(() => {
          scheduledTodoRunIdsRef.current.delete(dueTodo.id)
        })
    }

    runDueTodo()
    const timerId = window.setInterval(runDueTodo, 15_000)
    return () => window.clearInterval(timerId)
  }, [activeTodoTaskId, dispatch, enabled, todoItems])
}
