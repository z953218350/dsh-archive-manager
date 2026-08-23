import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  dshHome,
  listArchives,
  projcachePath,
  sessionsDir,
  workspacePath,
} from '../lib/index.js'

let previousDshHome
let tempRoots

beforeEach(() => {
  previousDshHome = process.env.DSH_HOME
  tempRoots = []
})

afterEach(async () => {
  if (previousDshHome === undefined) {
    delete process.env.DSH_HOME
  } else {
    process.env.DSH_HOME = previousDshHome
  }
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

describe('DSH home paths', () => {
  it('discovers archived sessions in a Desktop-provided DSH_HOME', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-archive-manager-'))
    tempRoots.push(root)
    const desktopHome = join(root, 'Application Support', 'harness')
    const sessionId = 'desktop-session'
    const dataDir = join(desktopHome, 'sessions', 'workspace', sessionId)
    const storageDir = join(desktopHome, 'storages')
    await mkdir(dataDir, { recursive: true })
    await mkdir(storageDir, { recursive: true })
    await writeFile(join(dataDir, 'session.jsonl'), '{}\n')
    await writeFile(join(storageDir, 'workspace.json'), JSON.stringify({
      global: { archivedSessionIds: [sessionId] },
      tables: {
        workspaces: {
          desktop: {
            path: '/workspace',
            title: 'Desktop workspace',
            sessionIds: [sessionId],
          },
        },
      },
    }))
    await writeFile(join(storageDir, 'session_projcache.json'), JSON.stringify({
      tables: {
        sessions: {
          [sessionId]: {
            identity: { createdAt: 123 },
            rows: {
              title: { val: 'Desktop archive' },
              sessionStats: { val: { turns: 2 } },
              tokenUsage: { val: { totals: { outputTokens: 5 } } },
            },
          },
        },
      },
    }))
    process.env.DSH_HOME = desktopHome

    assert.deepEqual(listArchives({}), [{
      sessionId,
      title: 'Desktop archive',
      workspacePath: '/workspace',
      workspaceTitle: 'Desktop workspace',
      workspaceId: 'desktop',
      createdAt: 123,
      turns: 2,
      outputTokens: 5,
      dataSize: 3,
      hasDataFile: true,
    }])
  })

  it('honors DSH_HOME and normalizes derived storage paths', () => {
    process.env.DSH_HOME = 'relative-root/../desktop-harness'
    const expected = resolve('desktop-harness')

    assert.equal(dshHome(), expected)
    assert.equal(workspacePath(), join(expected, 'storages', 'workspace.json'))
    assert.equal(projcachePath(), join(expected, 'storages', 'session_projcache.json'))
    assert.equal(sessionsDir(), join(expected, 'sessions'))
  })

  it('expands a home-relative DSH_HOME', () => {
    process.env.DSH_HOME = '~/desktop-harness/../harness'

    assert.equal(dshHome(), join(homedir(), 'harness'))
  })

  it('falls back to ~/.dsh when DSH_HOME is unset or blank', () => {
    const expected = join(homedir(), '.dsh')

    delete process.env.DSH_HOME
    assert.equal(dshHome(), expected)

    process.env.DSH_HOME = '   '
    assert.equal(dshHome(), expected)
  })
})
