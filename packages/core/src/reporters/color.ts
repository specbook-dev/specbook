// Terminal colors, only when they will be seen: a TTY, not NO_COLOR, or FORCE_COLOR.

export interface Colors {
  red(s: string): string
  green(s: string): string
  yellow(s: string): string
  cyan(s: string): string
  dim(s: string): string
  bold(s: string): string
}

/** Whether to color output: FORCE_COLOR wins, then NO_COLOR, then whether the stream is an interactive terminal. */
export function colorEnabled(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  return isTTY && env.TERM !== 'dumb'
}

export function createColors(enabled: boolean): Colors {
  const wrap = (open: number, close: number) => (s: string) =>
    enabled ? `\u001b[${open}m${s}\u001b[${close}m` : s
  return {
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
    dim: wrap(2, 22),
    bold: wrap(1, 22),
  }
}
