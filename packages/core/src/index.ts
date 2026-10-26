// What a project imports to write requests, flows, scripts and its config. Everything Specbook's own packages
// need beyond this is in `@specbook/core/internal`, which may change in any release.
export type { BrandingConfig, EnvironmentConfig, ServiceConfig, SpecbookConfig } from './config'
export { defineConfig } from './config'
export type { Control, Controls, Default, InferControls } from './controls'
export { c } from './controls'
export type { FakerConfig } from './faker-runtime'
export type { OAuthClientCredentials, OAuthDiscovery, OAuthEndpoints, OAuthSettings } from './oauth'
export { defineOperation, request, withMock } from './request'
export type { AuthProfile, Session } from './runner/run'
export type {
  Given,
  PageElement,
  ScriptBody,
  ScriptDef,
  ScriptHelpers,
  ScriptInput,
  ScriptLoadOptions,
  ScriptMeta,
  ScriptMockHook,
  ScriptOverrides,
  ScriptRuntime,
} from './script'
export { script } from './script'
export type { SecretProvider, SecretRef } from './secrets'
export type { Sequence, SequenceMeta, StepCtx, StepNode } from './sequence'
export { sequence } from './sequence'
export type * from './types'
