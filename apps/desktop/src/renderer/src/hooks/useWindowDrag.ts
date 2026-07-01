import { getCurrentWindow } from '@tauri-apps/api/window'
import type { MouseEventHandler } from 'react'

const interactiveSelector = [
  'a',
  'button',
  'input',
  'textarea',
  'select',
  '[role="button"]',
  '[data-window-no-drag]'
].join(',')

export const useWindowDrag = (): MouseEventHandler<HTMLElement> => (event) => {
  if (event.button !== 0) {
    return
  }

  const target = event.target
  if (target instanceof Element && target.closest(interactiveSelector)) {
    return
  }

  void getCurrentWindow().startDragging().catch((error) => {
    console.error('Failed to start window dragging', error)
  })
}
