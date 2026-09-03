/**
 * dsh-archive-manager — host half (plain JavaScript).
 *
 * Registers HTTP routes under /api/dsh-archive-manager/* that let the browser
 * settings card list, preview, restore, and permanently delete archived sessions.
 *
 * Routes (all loopback-only, same-origin):
 *   GET  /api/dsh-archive-manager/archives   — list archived sessions with accurate metadata
 *   GET  /api/dsh-archive-manager/detail     — preview conversation history parsed directly from session.jsonl.zstd
 *   POST /api/dsh-archive-manager/unarchive  — restore one or more sessions from archive via workspaceRegistry
 *   POST /api/dsh-archive-manager/delete     — delete one or more sessions completely (disk, projcache, workspace)
 *   POST /api/dsh-archive-manager/delete-all — delete every archived session
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Stable cordis plugin name. */
export const name = 'archive-manager'

/** Services required (webServer for route registration, workspaceRegistry for live state sync). */
export const inject = ['webServer', 'workspaceRegistry']

/** API path prefix. */
const API_PREFIX = '/api/dsh-archive-manager'

/** Cap on JSON request bodies. */
const MAX_JSON_BODY_BYTES = 512 * 1024

const ZSTD_MAGIC = 4247762216

/** DSH home directory. */
export function dshHome() {
  return resolveDshHome()
}

/** Path to workspace.json. */
export function workspacePath() {
  return join(dshHome(), 'storages', 'workspace.json')
}

/** Path to session_projcache.json. */
export function projcachePath() {
  return join(dshHome(), 'storages', 'session_projcache.json')
}

/** Path to sessions directory. */
export function sessionsDir() {
  return join(dshHome(), 'sessions')
}

/** Read and parse JSON safely. */
export function readJsonFile(filePath) {
  if (!existsSync(filePath)) return undefined
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

/** Write JSON atomically (tmp + rename). */
export function writeJsonFile(filePath, data) {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = filePath + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, filePath)
}

/** Encode segment helper matching dsh internal session persistence. */
export function encodeSegment(raw) {
  if (!raw || raw.length === 0) return ''
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * Find the session data directory for a given session id.
 * Searches all workspace sub-directories under ~/.dsh/sessions/.
 */
export function findSessionDir(sessionId) {
  const root = sessionsDir()
  if (!existsSync(root)) return undefined
  const encoded = encodeSegment(sessionId)
  try {
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry)
      try {
        if (statSync(dir).isDirectory()) {
          const directDir = join(dir, sessionId)
          if (existsSync(directDir)) return directDir
          if (encoded && encoded !== sessionId) {
            const encodedDir = join(dir, encoded)
            if (existsSync(encodedDir)) return encodedDir
          }
        }
      } catch {
        // skip unreadable entries
      }
    }
  } catch {}
  return undefined
}

/** Safely remove a directory with retry on Windows. */
export function safeRemoveDir(targetDir, maxRetries = 3) {
  if (!existsSync(targetDir)) return true
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      rmSync(targetDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      return true
    } catch (err) {
      if (attempt === maxRetries) throw err
      const wait = 150 * attempt
      const start = Date.now()
      while (Date.now() - start < wait) {}
    }
  }
  return false
}

/** Clean up empty project directory under ~/.dsh/sessions/. */
export function cleanEmptyProjectDir(sessionDirPath) {
  try {
    const parentDir = dirname(sessionDirPath)
    const root = sessionsDir()
    if (parentDir !== root && dirname(parentDir) === root) {
      const remaining = readdirSync(parentDir)
      if (remaining.length === 0) {
        rmSync(parentDir, { recursive: true, force: true })
      }
    }
  } catch {}
}

/** Get total size of a directory (recursive). */
export function dirSize(dir) {
  let total = 0
  if (!existsSync(dir)) return 0
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        total += dirSize(full)
      } else {
        total += stat.size
      }
    }
  } catch {
    // best effort
  }
  return total
}

/**
 * Scan Zstandard frames from a concatenated buffer.
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) break
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) break
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = blockHeader >>> 1 & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) break
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) break
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) break
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/**
 * Decompress multi-frame zstd session log to UTF-8 text using Node built-in zlib.
 */
export function decodeZstdLog(filePath) {
  if (!existsSync(filePath)) return ''
  try {
    const buf = readFileSync(filePath)
    const frames = scanZstdFrames(buf)
    if (frames.length === 0) {
      try {
        return zstdDecompressSync(buf).toString('utf8')
      } catch {
        return ''
      }
    }
    const chunks = []
    for (const { start, end } of frames) {
      try {
        chunks.push(zstdDecompressSync(buf.subarray(start, end)))
      } catch {
        // tolerate trailing damaged frame
      }
    }
    return Buffer.concat(chunks).toString('utf8')
  } catch {
    return ''
  }
}

/** Read full transcript text from data directory. */
export function readTranscriptText(dataDir) {
  const zstdPath = join(dataDir, 'session.jsonl.zstd')
  const jsonlPath = join(dataDir, 'session.jsonl')

  if (existsSync(zstdPath)) {
    return decodeZstdLog(zstdPath)
  }
  if (existsSync(jsonlPath)) {
    try {
      return readFileSync(jsonlPath, 'utf8')
    } catch {}
  }
  return ''
}

/** Read title and metadata directly from session log data file. */
export function readSessionMetaFromDataFile(dataDir) {
  const rawText = readTranscriptText(dataDir)
  if (!rawText) return {}

  let title = null
  let createdAt = null
  let cwd = null
  let firstUserMsg = null
  let turns = 0

  const lines = rawText.split('\n')
  for (const line of lines) {
    if (!line) continue
    try {
      const ev = JSON.parse(line)
      if (ev.type === 'session') {
        if (ev.createdAt) createdAt = ev.createdAt
        if (ev.cwd) cwd = ev.cwd
      } else if (ev.type === 'session/title/set' || ev.type === 'title') {
        title = ev.title || ev.data?.title || title
      } else if (ev.type === 'turn/start') {
        turns++
      } else if (!firstUserMsg && ev.type === 'user/message') {
        const contents = ev.data?.content || []
        for (const item of contents) {
          if (item && item.type === 'text' && typeof item.text === 'string') {
            let clean = item.text
            const reminderIdx = clean.indexOf('<system-reminder>')
            if (reminderIdx !== -1) clean = clean.slice(0, reminderIdx).trim()
            const runtimeIdx = clean.indexOf('Current runtime context.')
            if (runtimeIdx !== -1) clean = clean.slice(0, runtimeIdx).trim()
            if (clean) {
              firstUserMsg = clean.slice(0, 50)
              break
            }
          }
        }
      }
    } catch {}
  }
  return { title: title || firstUserMsg, createdAt, cwd, turns }
}

/** Extract conversation preview messages accurately from session log. */
export function extractSessionDetail(dataDir, maxMessages = 50) {
  const rawText = readTranscriptText(dataDir)
  if (!rawText) return { messages: [], header: null, totalMessages: 0 }

  let header = null
  const messages = []

  const lines = rawText.split('\n')
  for (const line of lines) {
    if (!line) continue
    try {
      const ev = JSON.parse(line)
      if (ev.type === 'session') {
        header = ev
      } else if (ev.type === 'user/message') {
        const contents = ev.data?.content || []
        for (const item of contents) {
          if (item && item.type === 'text' && typeof item.text === 'string') {
            let clean = item.text
            const reminderIdx = clean.indexOf('<system-reminder>')
            if (reminderIdx !== -1) clean = clean.slice(0, reminderIdx).trim()
            const runtimeIdx = clean.indexOf('Current runtime context.')
            if (runtimeIdx !== -1) clean = clean.slice(0, runtimeIdx).trim()
            if (clean) {
              messages.push({
                role: 'user',
                time: ev.time || header?.createdAt,
                content: clean,
              })
            }
          }
        }
      } else if (ev.type === 'assistant/message') {
        const contents = ev.data?.message?.content || []
        const textParts = []
        for (const item of contents) {
          if (item && item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
            textParts.push(item.text.trim())
          }
        }
        if (textParts.length > 0) {
          messages.push({
            role: 'assistant',
            time: ev.time,
            content: textParts.join('\n\n'),
          })
        }
      }
    } catch {}
  }

  return {
    header,
    messages: messages.slice(-maxMessages),
    totalMessages: messages.length,
  }
}

/**
 * List every archived session with metadata.
 */
export function listArchives(ctx) {
  const workspace = readJsonFile(workspacePath())
  const projcache = readJsonFile(projcachePath())

  const archivedIds = ctx?.workspaceRegistry?.archivedSessionIds ?? workspace?.global?.archivedSessionIds ?? []
  const workspaces = workspace?.tables?.workspaces ?? {}
  const sessions = projcache?.tables?.sessions ?? {}

  // Build a reverse map: sessionId -> workspace info
  const sessionToWorkspace = new Map()
  for (const [wsId, ws] of Object.entries(workspaces)) {
    const wsPath = ws.path ?? ''
    const wsTitle = ws.title || (wsPath ? basename(wsPath) : '')
    for (const sid of ws.sessionIds ?? []) {
      sessionToWorkspace.set(sid, { id: wsId, path: wsPath, title: wsTitle })
    }
  }

  const result = []
  const ghostIds = []

  for (const sid of archivedIds) {
    const wsInfo = sessionToWorkspace.get(sid)
    const sessionMeta = sessions[sid]
    const rows = sessionMeta?.rows ?? {}

    let title = rows.title?.val ?? null
    let createdAt = sessionMeta?.identity?.createdAt ?? null
    let turns = rows.sessionStats?.val?.turns ?? 0
    const outputTokens = rows.tokenUsage?.val?.totals?.outputTokens ?? 0

    const dataDir = findSessionDir(sid)
    let dataSize = 0
    let hasDataFile = false

    if (dataDir !== undefined) {
      dataSize = dirSize(dataDir)
      const zstdPath = join(dataDir, 'session.jsonl.zstd')
      const jsonlPath = join(dataDir, 'session.jsonl')
      hasDataFile = existsSync(zstdPath) || existsSync(jsonlPath)

      // Fallback extraction from data file
      if (hasDataFile && (!title || !createdAt || turns === 0)) {
        const fileMeta = readSessionMetaFromDataFile(dataDir)
        if (!title && fileMeta.title) title = fileMeta.title
        if (!createdAt && fileMeta.createdAt) createdAt = fileMeta.createdAt
        if (turns === 0 && fileMeta.turns) turns = fileMeta.turns
      }
    }

    // Ghost detection: no disk file and no projcache record
    if (!hasDataFile && !sessionMeta) {
      ghostIds.push(sid)
      continue
    }

    let workspaceTitle = wsInfo?.title || null
    let workspacePathStr = wsInfo?.path || null

    result.push({
      sessionId: sid,
      title: title || '未命名会话',
      workspacePath: workspacePathStr,
      workspaceTitle: workspaceTitle,
      workspaceId: wsInfo?.id ?? null,
      createdAt,
      turns,
      outputTokens,
      dataSize,
      hasDataFile,
    })
  }

  // Auto-prune ghost IDs from workspace.json
  if (ghostIds.length > 0 && workspace?.global?.archivedSessionIds) {
    try {
      workspace.global.archivedSessionIds = workspace.global.archivedSessionIds.filter((id) => !ghostIds.includes(id))
      writeJsonFile(workspacePath(), workspace)
    } catch {}
  }

  result.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  return result
}

/**
 * Restore one or more archived sessions using live workspaceRegistry.
 */
export async function unarchiveSessions(ctx, sessionIds) {
  const unarchived = []
  const notFound = []
  const errors = []

  const registry = ctx?.workspaceRegistry
  if (registry && typeof registry.requireState === 'function' && typeof registry.setState === 'function') {
    try {
      const state = registry.requireState()
      const currentArchived = Array.isArray(state.archivedSessionIds) ? [...state.archivedSessionIds] : []
      const nextArchived = []
      for (const id of currentArchived) {
        if (sessionIds.includes(id)) {
          unarchived.push(id)
        } else {
          nextArchived.push(id)
        }
      }
      for (const id of sessionIds) {
        if (!unarchived.includes(id)) {
          notFound.push(id)
        }
      }
      if (unarchived.length > 0) {
        await registry.setState({
          ...state,
          archivedSessionIds: nextArchived,
        })
      }
    } catch (err) {
      errors.push('workspaceRegistry.setState: ' + (err instanceof Error ? err.message : String(err)))
    }
    return { unarchived, notFound, errors }
  }

  // Fallback to file modification
  const workspace = readJsonFile(workspacePath())
  if (!workspace) {
    return { unarchived, notFound: sessionIds, errors: ['workspace.json not found'] }
  }

  if (Array.isArray(workspace.global?.archivedSessionIds)) {
    const origLen = workspace.global.archivedSessionIds.length
    for (const sid of sessionIds) {
      const idx = workspace.global.archivedSessionIds.indexOf(sid)
      if (idx !== -1) {
        workspace.global.archivedSessionIds.splice(idx, 1)
        unarchived.push(sid)
      } else {
        notFound.push(sid)
      }
    }
    if (workspace.global.archivedSessionIds.length !== origLen) {
      try {
        writeJsonFile(workspacePath(), workspace)
      } catch (err) {
        errors.push('workspace.json write error: ' + (err instanceof Error ? err.message : String(err)))
      }
    }
  } else {
    notFound.push(...sessionIds)
  }

  return { unarchived, notFound, errors }
}

/**
 * Delete one or more sessions COMPLETELY (physical deletion + state cleanup):
 *   1. Teardown / detach live session instances in ctx.sessions
 *   2. Emit 'session/disposed' so dsh-host-apiproxy broadcasts 'host/session-removed' to all frontends
 *   3. Prune internal workspaceRegistry memory indexes
 *   4. Prune sessionProjectionCache memory rows
 *   5. Remove from workspace.json -> global.archivedSessionIds
 *   6. Remove from every workspace in workspace.json -> tables.workspaces[id].sessionIds
 *   7. Detach from live workspace entities in workspaceRegistry via detachSession()
 *   8. Remove metadata from session_projcache.json
 *   9. Physically remove on-disk session data directory from ~/.dsh/sessions/
 *   10. Push updated state to workspaceRegistry to notify all frontend clients
 */
export async function deleteSessions(ctx, sessionIds) {
  const removed = []
  const notFound = []
  const errors = []

  const workspace = readJsonFile(workspacePath())
  const projcache = readJsonFile(projcachePath())

  let wsChanged = false
  let pcChanged = false

  for (const sid of sessionIds) {
    let found = false

    // 1. Detach live in-memory session in ctx.sessions
    try {
      const sessions = ctx?.get?.('sessions') || ctx?.sessions
      if (sessions && typeof sessions.get === 'function') {
        const live = sessions.get(sid)
        if (live) {
          const entry = sessions.liveEntryFor?.(live) || sessions.store?.get?.(sid)
          if (entry && typeof entry.detach === 'function') {
            entry.detach()
          }
        }
      }
    } catch {}

    // 2. Broadcast session removal to frontend via session/disposed -> host/session-removed
    try {
      if (typeof ctx?.emit === 'function') {
        ctx.emit('session/disposed', { id: sid, session: { id: sid } })
      }
    } catch {}

    // 3. Clear workspaceRegistry internal memory mappings
    try {
      const registry = ctx?.workspaceRegistry
      if (registry) {
        if (registry.headers instanceof Map) registry.headers.delete(sid)
        if (registry.sessionPaths instanceof Map) registry.sessionPaths.delete(sid)
        if (registry.invalidSessionPaths instanceof Map) registry.invalidSessionPaths.delete(sid)
      }
    } catch {}

    // 4. Clear sessionProjectionCache in-memory cached rows
    try {
      const projCacheService = ctx?.get?.('sessionProjectionCache') || ctx?.sessionProjectionCache
      if (projCacheService?.cachedRows instanceof Map) {
        projCacheService.cachedRows.delete(sid)
      }
    } catch {}

    // 5. Remove from workspace.json -> global.archivedSessionIds
    if (workspace?.global?.archivedSessionIds) {
      const before = workspace.global.archivedSessionIds.length
      workspace.global.archivedSessionIds = workspace.global.archivedSessionIds.filter(
        (id) => id !== sid,
      )
      if (workspace.global.archivedSessionIds.length !== before) {
        wsChanged = true
        found = true
      }
    }

    // 6. Remove from every workspace's sessionIds in workspace.json
    if (workspace?.tables?.workspaces) {
      for (const ws of Object.values(workspace.tables.workspaces)) {
        if (Array.isArray(ws.sessionIds)) {
          const before = ws.sessionIds.length
          ws.sessionIds = ws.sessionIds.filter((id) => id !== sid)
          if (ws.sessionIds.length !== before) {
            wsChanged = true
            found = true
          }
        }
      }
    }

    // 7. Remove metadata from session_projcache.json
    if (projcache?.tables?.sessions && projcache.tables.sessions[sid] !== undefined) {
      delete projcache.tables.sessions[sid]
      pcChanged = true
      found = true
    }

    // 8. Physically remove session data directory on disk
    const dataDir = findSessionDir(sid)
    if (dataDir !== undefined) {
      try {
        safeRemoveDir(dataDir)
        cleanEmptyProjectDir(dataDir)
        found = true
      } catch (err) {
        errors.push(sid + ': ' + (err instanceof Error ? err.message : String(err)))
      }
    }

    if (found) {
      removed.push(sid)
    } else {
      notFound.push(sid)
    }
  }

  // 9. Update workspaceRegistry live in memory via public detachSession & setState
  const registry = ctx?.workspaceRegistry
  if (registry) {
    try {
      if (registry.entities && typeof registry.entities.values === 'function') {
        for (const entity of registry.entities.values()) {
          if (typeof entity.detachSession === 'function') {
            for (const sid of sessionIds) {
              try {
                await entity.detachSession(sid)
              } catch {}
            }
          }
        }
      }

      const table = typeof registry.requireTable === 'function' ? registry.requireTable() : null
      if (table && workspace?.tables?.workspaces) {
        for (const [wsId, ws] of Object.entries(workspace.tables.workspaces)) {
          try {
            await table.set(wsId, ws)
          } catch {}
        }
      }

      if (typeof registry.requireState === 'function' && typeof registry.setState === 'function') {
        const state = registry.requireState()
        const currentArchived = Array.isArray(state.archivedSessionIds) ? [...state.archivedSessionIds] : []
        const nextArchived = currentArchived.filter((id) => !sessionIds.includes(id))
        if (nextArchived.length !== currentArchived.length) {
          await registry.setState({
            ...state,
            archivedSessionIds: nextArchived,
          })
        }
      }
    } catch (err) {
      errors.push('workspaceRegistry sync: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  // 10. Persist atomic writes to disk
  if (wsChanged && workspace !== undefined) {
    try {
      writeJsonFile(workspacePath(), workspace)
    } catch (err) {
      errors.push('workspace.json write: ' + (err instanceof Error ? err.message : String(err)))
    }
  }
  if (pcChanged && projcache !== undefined) {
    try {
      writeJsonFile(projcachePath(), projcache)
    } catch (err) {
      errors.push('session_projcache.json write: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  return { removed, notFound, errors }
}

/** Check if hostname is a loopback address (shared with dsh-client-connection). */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Parse an authority string into a URL for canonical comparison. */
function parseAuthority(authority) {
  try {
    return new URL('http://' + authority)
  } catch {
    return undefined
  }
}

/** Canonical form of a parsed authority: hostname or hostname:port. */
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL('https://' + entry).port
  return port === '' ? entryUrl.hostname : entryUrl.hostname + ':' + port
}

/** Whether the request authority matches a trustedHosts entry. */
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * Request trust check.
 *
 * Always requires the socket remoteAddress to be loopback — a reverse proxy
 * or tunnel (cloudflared) connecting to 127.0.0.1 satisfies this.
 *
 * When `trustedHosts` is configured and non-empty, the Host header is checked
 * against the list using DSH connection-plugin's trusted-authority logic.
 * When `trustedHosts` is empty / undefined, the Host header must itself be a
 * loopback address (the original strict behaviour).
 *
 * Browser markers (sec-fetch-site, Origin) are checked in both modes.
 */
function isTrustedRequest(request, trustedHosts) {
  const address = request.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false

  const host = request.headers.host
  if (typeof host !== 'string') return false

  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }

  if (trustedHosts && trustedHosts.length > 0) {
    if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  } else {
    if (!isLoopbackHostname(hostUrl.hostname)) return false
  }

  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Write a JSON response. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

/** Read a JSON request body. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Mount the archive-manager HTTP routes.
 *
 * @param {object} ctx - Cordis plugin context
 * @param {object} [_config] - optional plugin config
 * @param {string[]} [_config.trustedHosts] - trusted non-loopback authorities (e.g. ['dsh.example.com']).
 *   When omitted, falls back to DSH connection's trustedHosts (set via --trusted-host).
 */
export function apply(ctx, _config) {
  const trustedHosts = _config?.trustedHosts ?? ctx.get('connection')?.trustedHosts ?? []

  function checkTrust(req, res) {
    if (!isTrustedRequest(req, trustedHosts)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    return true
  }

  const route = {
    kind: 'exact',
    path: API_PREFIX + '/archives',
    handler: async (req, res) => {
      if (!checkTrust(req, res)) return
      if (req.method !== 'GET') {
        writeJson(res, 405, { error: 'method not allowed: ' + req.method })
        return
      }
      try {
        const archives = listArchives(ctx)
        writeJson(res, 200, { archives, total: archives.length })
      } catch (err) {
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  }

  const detailRoute = {
    kind: 'exact',
    path: API_PREFIX + '/detail',
    handler: async (req, res) => {
      if (!checkTrust(req, res)) return
      if (req.method !== 'GET') {
        writeJson(res, 405, { error: 'method not allowed: ' + req.method })
        return
      }
      try {
        const url = new URL(req.url, 'http://localhost')
        const sessionId = url.searchParams.get('sessionId')
        if (!sessionId) {
          writeJson(res, 400, { error: 'sessionId parameter required' })
          return
        }
        const dataDir = findSessionDir(sessionId)
        if (!dataDir) {
          writeJson(res, 404, { error: 'session directory not found on disk' })
          return
        }
        const detail = extractSessionDetail(dataDir, 50)
        writeJson(res, 200, { sessionId, ...detail })
      } catch (err) {
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  }

  const unarchiveRoute = {
    kind: 'exact',
    path: API_PREFIX + '/unarchive',
    handler: async (req, res) => {
      if (!checkTrust(req, res)) return
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: 'method not allowed: ' + req.method })
        return
      }
      const body = await readJsonBody(req)
      if (body === undefined) {
        writeJson(res, 400, { error: 'invalid JSON body' })
        return
      }
      const ids = Array.isArray(body.sessionIds)
        ? body.sessionIds.filter((x) => typeof x === 'string')
        : typeof body.sessionId === 'string'
          ? [body.sessionId]
          : []
      if (ids.length === 0) {
        writeJson(res, 400, { error: 'sessionIds (array) or sessionId (string) is required' })
        return
      }
      try {
        const result = await unarchiveSessions(ctx, ids)
        writeJson(res, 200, result)
      } catch (err) {
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  }

  const deleteRoute = {
    kind: 'exact',
    path: API_PREFIX + '/delete',
    handler: async (req, res) => {
      if (!checkTrust(req, res)) return
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: 'method not allowed: ' + req.method })
        return
      }
      const body = await readJsonBody(req)
      if (body === undefined) {
        writeJson(res, 400, { error: 'invalid JSON body' })
        return
      }
      const ids = Array.isArray(body.sessionIds)
        ? body.sessionIds.filter((x) => typeof x === 'string')
        : typeof body.sessionId === 'string'
          ? [body.sessionId]
          : []
      if (ids.length === 0) {
        writeJson(res, 400, { error: 'sessionIds (array) or sessionId (string) is required' })
        return
      }
      try {
        const result = await deleteSessions(ctx, ids)
        writeJson(res, 200, result)
      } catch (err) {
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  }

  const deleteAllRoute = {
    kind: 'exact',
    path: API_PREFIX + '/delete-all',
    handler: async (req, res) => {
      if (!checkTrust(req, res)) return
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: 'method not allowed: ' + req.method })
        return
      }
      try {
        const archives = listArchives(ctx)
        const ids = archives.map((a) => a.sessionId)
        if (ids.length === 0) {
          writeJson(res, 200, { removed: [], notFound: [], errors: [], total: 0 })
          return
        }
        const result = await deleteSessions(ctx, ids)
        writeJson(res, 200, { ...result, total: ids.length })
      } catch (err) {
        writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    },
  }

  const routes = [route, detailRoute, unarchiveRoute, deleteRoute, deleteAllRoute]

  ctx.effect(
    () => {
      const disposers = routes.map((r) => ctx.webServer.register(r))
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    'dsh-archive-manager: routes',
  )
}
