const VIRTUAL_KEYS: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
}

export function virtualKey(key: string, code: string): number | undefined {
  if (VIRTUAL_KEYS[key] !== undefined) return VIRTUAL_KEYS[key]
  if (key.length === 1) {
    const upper = key.toUpperCase()
    if (upper >= 'A' && upper <= 'Z') return upper.charCodeAt(0)
    if (upper >= '0' && upper <= '9') return upper.charCodeAt(0)
  }
  if (code.startsWith('Key') && code.length === 4) return code.charCodeAt(3)
  if (code.startsWith('Digit') && code.length === 6) return code.charCodeAt(5)
  return undefined
}

/** Ctrl/Cmd editing commands forwarded natively instead of as key events. */
export function editingCommands(key: string, modifiers: number): string[] | undefined {
  const primary = (modifiers & 2) !== 0 || (modifiers & 4) !== 0
  if (!primary || key.length !== 1) return undefined
  const lower = key.toLowerCase()
  if (lower === 'a') return ['selectAll']
  if (lower === 'c') return ['copy']
  if (lower === 'x') return ['cut']
  if (lower === 'v') return ['paste']
  if (lower === 'z') return (modifiers & 8) !== 0 ? ['redo'] : ['undo']
  if (lower === 'y') return ['redo']
  return undefined
}
