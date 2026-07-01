export type WorkbenchIntentKind =
  | 'chat'
  | 'todo.create'
  | 'mail.reply'
  | 'mail.send'
  | 'mail.summary'

export type WorkbenchIntentPlan = {
  kind: WorkbenchIntentKind
  confidence: number
  requiresConfirmation: boolean
  risk: 'low' | 'medium' | 'high'
  reason: string
  parameters: {
    recipient?: string
    subject?: string
    body?: string
  }
}

const mailAddressPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const sendMailPattern = /(发|发送|写|寄).{0,12}(邮件|信)|(邮件|信).{0,12}(给|到)/
const mailSummaryPattern =
  /(整理|汇总|总结|查看|分析|分类|摘要).{0,12}(未读)?邮件|(未读)?邮件.{0,12}(整理|汇总|总结|分类|摘要)/

export const extractMailBody = (instruction: string, recipient?: string) => {
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

export const extractMailSubject = (instruction: string) =>
  instruction.match(/主题[为是：:\s]+([^，,。；;\n]+)/u)?.[1]?.trim() ||
  '来自 Emphant Studio 的邮件'

export const planWorkbenchIntent = ({
  content,
  selectedAssistantIds,
  hasSourceMail
}: {
  content: string
  selectedAssistantIds: string[]
  hasSourceMail: boolean
}): WorkbenchIntentPlan => {
  const isTodoAssistantSelected = selectedAssistantIds.includes('assistant-todo')
  if (isTodoAssistantSelected) {
    return {
      kind: 'todo.create',
      confidence: 0.9,
      requiresConfirmation: false,
      risk: 'medium',
      reason: '用户已选择任务助手，本轮输入会转为可追踪任务。',
      parameters: {}
    }
  }

  if (hasSourceMail) {
    return {
      kind: 'mail.reply',
      confidence: 0.88,
      requiresConfirmation: true,
      risk: 'high',
      reason: '当前会话来自邮件，回复会发送到外部收件箱。',
      parameters: {
        body: extractMailBody(content)
      }
    }
  }

  const isMailAssistantSelected = selectedAssistantIds.includes('assistant-mail')
  const recipient = content.match(mailAddressPattern)?.[0]
  if (recipient && sendMailPattern.test(content) && isMailAssistantSelected) {
    return {
      kind: 'mail.send',
      confidence: 0.86,
      requiresConfirmation: true,
      risk: 'high',
      reason: '用户选择邮件助手并提供收件人，发送邮件前必须确认。',
      parameters: {
        recipient,
        subject: extractMailSubject(content),
        body: extractMailBody(content, recipient)
      }
    }
  }

  if (mailSummaryPattern.test(content) && isMailAssistantSelected) {
    return {
      kind: 'mail.summary',
      confidence: 0.82,
      requiresConfirmation: false,
      risk: 'medium',
      reason: '用户选择邮件助手并请求整理邮件，会读取已授权邮箱的未读邮件。',
      parameters: {}
    }
  }

  return {
    kind: 'chat',
    confidence: 0.7,
    requiresConfirmation: false,
    risk: 'low',
    reason: '没有识别到需要特殊执行的结构化动作，按普通会话处理。',
    parameters: {}
  }
}
