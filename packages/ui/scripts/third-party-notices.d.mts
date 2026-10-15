export const ALLOWED: Set<string>
export function packageOf(file: string): { dir: string; pkg: Record<string, any> } | undefined
export function licenseName(pkg: Record<string, any>): string
export function licenseText(dir: string): string | undefined
export function isAllowed(expression: string): boolean
export function render(
  entries: { name: string; version: string; license: string; text?: string }[],
): string
/** Two Vite/Rollup plugins; typed loosely because the hooks are called by hand in the tests. */
export function noticesPlugins(): { collect: any; emit: any }
