/**
 * dsh-archive-manager — host half (TypeScript source).
 *
 * This is the TypeScript companion source for lib/index.js.
 * Registers HTTP routes under /api/dsh-archive-manager/* that let the browser
 * settings card list, preview, restore, and permanently delete archived sessions.
 *
 * ## Config
 *
 * `trustedHosts` (optional, `string[]`): non-loopback authorities whose HTTP
 * Host header is accepted alongside loopback. When omitted, the plugin
 * automatically inherits DSH's trusted-host list from `--trusted-host` flags.
 * Each entry must be a bare `host` or `host:port` string. The socket
 * remoteAddress is always required to be loopback.
 *
 * ```yaml
 * - id: archive-manager
 *   name: '@mlgbnb/dsh-archive-manager'
 *   config:
 *     trustedHosts:
 *       - dsh.example.com
 * ```
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Stable cordis plugin name. */
export const name = 'archive-manager'

/** Services required (webServer for route registration, workspaceRegistry for live state sync). */
export const inject = ['webServer', 'workspaceRegistry']

/** Plugin config schema. */
export interface ArchiveManagerConfig {
  /** Non-loopback authorities accepted when the remote address is loopback. */
  trustedHosts?: string[]
}

/** One archived session as returned to the browser. */
export interface ArchiveInfo {
  sessionId: string
  title: string | null
  workspacePath: string | null
  workspaceTitle: string | null
  workspaceId: string | null
  createdAt: number | null
  turns: number
  outputTokens: number
  dataSize: number
  hasDataFile: boolean
}

/** Resolve the active DSH data root, including a DSH_HOME override. */
export function dshHome(): string {
  return resolveDshHome()
}

export function apply(ctx: Context, _config?: ArchiveManagerConfig): void {
  void ctx
  void _config
}
