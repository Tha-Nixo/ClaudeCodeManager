import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { __userData } from './helpers/electron'
import { DEFAULT_CONFIG } from '../src/shared/types'
import { getConfig } from '../src/main/store/config'

/**
 * Object fields of config.json with one value of the wrong type (issue #5).
 *
 * config caches the file on first access, so this file exists only to give
 * getConfig a different starting config.json from test/store.test.ts: there,
 * the object fields are whole strings and arrays; here, they are objects
 * with one key set by hand to the wrong type. Keys left alone must come out
 * right, and the wrong one must fall back to its default instead of reaching
 * the renderer.
 */
writeFileSync(
  join(__userData, 'config.json'),
  JSON.stringify({
    launchDefaults: { model: 42, effort: 'high' },
    indexSources: { claude: 'yes', git: false, unknownKey: true }
  }),
  'utf8'
)

describe('config: object fields with one value of the wrong type (issue #5)', () => {
  it('a value with the wrong type falls back to its default', () => {
    const config = getConfig()
    assert.equal(config.launchDefaults.model, DEFAULT_CONFIG.launchDefaults.model)
    assert.equal(config.indexSources.claude, DEFAULT_CONFIG.indexSources.claude)
  })

  it('values of the right type are kept, unknown keys are dropped', () => {
    const config = getConfig()
    assert.equal(config.launchDefaults.effort, 'high')
    assert.equal(config.indexSources.git, false)
    assert.ok(!('unknownKey' in config.indexSources))
  })
})
