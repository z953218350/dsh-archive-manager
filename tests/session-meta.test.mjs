import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readSessionMetaFromDataFile } from '../lib/index.js'

async function withSessionLog(events, run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-archive-manager-title-'))
  try {
    await writeFile(join(dir, 'session.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n')
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('reads the latest current DSH session/title event', async () => {
  await withSessionLog([
    { type: 'session', createdAt: 1735689600000, cwd: '/workspace' },
    { type: 'user/message', data: { content: [{ type: 'text', text: '<botmux_identity>injected context</botmux_identity>' }] } },
    { type: 'session/title', data: { title: 'Fallback title' } },
    { type: 'session/title', data: { title: 'Actual session title' } },
    { type: 'turn/start' },
  ], (dir) => {
    assert.deepEqual(readSessionMetaFromDataFile(dir), {
      title: 'Actual session title',
      createdAt: 1735689600000,
      cwd: '/workspace',
      turns: 1,
    })
  })
})

test('keeps support for legacy title event shapes', async () => {
  await withSessionLog([
    { type: 'session/title/set', title: 'Legacy top-level title' },
    { type: 'title', data: { title: 'Legacy nested title' } },
  ], (dir) => {
    assert.equal(readSessionMetaFromDataFile(dir).title, 'Legacy nested title')
  })
})

test('ignores blank title updates and falls back to the first user message', async () => {
  await withSessionLog([
    { type: 'user/message', data: { content: [{ type: 'text', text: 'Fallback user message' }] } },
    { type: 'session/title', data: { title: '   ' } },
  ], (dir) => {
    assert.equal(readSessionMetaFromDataFile(dir).title, 'Fallback user message')
  })
})
