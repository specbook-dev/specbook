// The project-file and proxy helpers Specbook's own CLI and tests use. Not a public API: it may change in any release.
export * from './environments'
export { requestsDirFor, SCRIPT_FILE, safeProjectPath, scanProject } from './files'
export type { EnvironmentAddresses, ProxyConfig, ProxyDeps } from './proxy'
export { handleProxy } from './proxy'
