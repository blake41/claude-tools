import { describe, expect, it } from 'bun:test'
import { isTerminal, parseStatusLine, newStatusLines } from '../src/status-protocol.ts'
import { contextTokens, transcriptPath, projectSlug } from '../src/transcript.ts'

describe('status protocol', () => {
  it('parses every line kind from PLAN 4.2', () => {
    expect(parseStatusLine('working: writing the cache test')).toEqual({ k: 'working', note: 'writing the cache test' })
    expect(parseStatusLine('needs-decision thread=bd-43aa7/bd-43aa7.3: which model busts the cache?')).toEqual({
      k: 'needs_decision',
      thread: 'bd-43aa7/bd-43aa7.3',
      question: 'which model busts the cache?',
    })
    expect(parseStatusLine('rotate baton=.baton/2026-11-03-bd-43aa7.3.md')).toEqual({
      k: 'rotate',
      baton: '.baton/2026-11-03-bd-43aa7.3.md',
    })
    expect(parseStatusLine('done sha=96a276fa4')).toEqual({ k: 'done', sha: '96a276fa4' })
    expect(parseStatusLine('failed: suppression file conflict')).toEqual({ k: 'failed', reason: 'suppression file conflict' })
    expect(parseStatusLine('I think I am done')).toEqual({ k: 'unknown', raw: 'I think I am done' })
  })

  it('parses deferred and rejects malformed deferred lines', () => {
    expect(parseStatusLine('deferred: bust on SfAccount or TTL?')).toEqual({ k: 'deferred', what: 'bust on SfAccount or TTL?' })
    expect(parseStatusLine('deferred:')).toEqual({ k: 'unknown', raw: 'deferred:' })
    expect(parseStatusLine('deferred:   ')).toEqual({ k: 'unknown', raw: 'deferred:' })
    expect(parseStatusLine('deferred the question')).toEqual({ k: 'unknown', raw: 'deferred the question' })
    expect(isTerminal(parseStatusLine('deferred: x'))).toBe(true)
  })

  it('returns only lines after the cursor and the new cursor', () => {
    const text = 'working: a\ndone sha=b7afc7b12\nworking: b\n'
    expect(newStatusLines(text, 1)).toEqual({
      lines: [
        { k: 'done', sha: 'b7afc7b12' },
        { k: 'working', note: 'b' },
      ],
      cursor: 3,
    })
    expect(newStatusLines(null, 0)).toEqual({ lines: [], cursor: 0 })
  })
})

describe('transcript', () => {
  it('derives the Claude project slug by replacing / and . with -', () => {
    expect(projectSlug('/Users/blake/Documents/Development/clay/terra/.claude/worktrees/epic-spike')).toBe(
      '-Users-blake-Documents-Development-clay-terra--claude-worktrees-epic-spike',
    )
    expect(transcriptPath('/home/x/.claude/projects', '/r/.claude/worktrees/e', 'sid')).toBe(
      '/home/x/.claude/projects/-r--claude-worktrees-e/sid.jsonl',
    )
  })

  it('measures context from the last main-thread assistant usage, skipping sidechains', () => {
    const lines = [
      { type: 'user', message: { content: 'hi' } },
      {
        type: 'assistant',
        isSidechain: false,
        message: { usage: { input_tokens: 2, cache_creation_input_tokens: 664, cache_read_input_tokens: 71303, output_tokens: 62 } },
      },
      {
        type: 'assistant',
        isSidechain: true,
        message: { usage: { input_tokens: 9, cache_creation_input_tokens: 9, cache_read_input_tokens: 9, output_tokens: 1 } },
      },
      'not json at all',
    ]
    const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')
    expect(contextTokens(text)).toBe(71969)
    expect(contextTokens('')).toBeNull()
  })
})
