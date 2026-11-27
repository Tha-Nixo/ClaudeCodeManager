import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fuzzyMatch, rankBy } from '../src/main/indexer/fuzzy'

/**
 * Positions go to the UI to highlight the matched letters: if an index falls
 * outside the string, or goes backwards, the highlight moves to the wrong
 * characters or breaks rendering. This check lives in a helper because it has
 * to run on EVERY match, not just the convenient ones.
 */
function verifyPositions(pattern: string, text: string, positions: number[]): void {
  // Counted in UTF-16 code units: positions are indices in `text`, and for emoji
  // surrogate pairs take two indices.
  const expected = pattern.split('').filter((c) => c !== ' ')

  assert.equal(
    positions.length,
    expected.length,
    `${JSON.stringify(pattern)} on ${JSON.stringify(text)}: ${positions.length} positions for ${expected.length} characters`
  )

  let previous = -1
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i]
    assert.ok(Number.isInteger(pos), `non-integer position: ${pos}`)
    assert.ok(pos >= 0, `negative position: ${pos}`)
    assert.ok(pos < text.length, `position out of bounds: ${pos} >= ${text.length}`)
    assert.ok(pos > previous, `positions not strictly ascending: ${previous} then ${pos}`)
    previous = pos

    // The highlighted character must really be the one searched for, otherwise
    // the user sees underlined letters they never typed.
    assert.equal(
      text[pos].toLowerCase(),
      expected[i].toLowerCase(),
      `position ${pos} points to ${JSON.stringify(text[pos])} instead of ${JSON.stringify(expected[i])}`
    )
  }
}

/**
 * Regression test for issue #6.
 *
 * Searching for "cm" ranked `C:\Users\Chiara\Modelli` and `C:\Users\Carlo\Musica`
 * ahead of `C:\dev\ClaudeManager`: 'c' matched the drive letter greedily as a word
 * boundary, and from there any later 'm' completed the match. The very use case
 * the module exists for gave the wrong answer.
 */
describe('fuzzy: final component initials beat scattered characters (issue #6)', () => {
  /** The issue's literal case, with both separators. */
  const issueCases = [
    {
      query: 'cm',
      expected: 'C:\\dev\\ClaudeManager',
      rivals: ['C:\\Users\\Chiara\\Modelli', 'C:\\Users\\Carlo\\Musica']
    },
    {
      query: 'CM',
      expected: 'C:\\dev\\ClaudeManager',
      rivals: ['C:\\Users\\Chiara\\Modelli', 'C:\\Users\\Carlo\\Musica']
    },
    {
      query: 'cm',
      expected: 'C:/dev/ClaudeManager',
      rivals: ['C:/Users/Chiara/Modelli', 'C:/Users/Carlo/Musica']
    },
    // Same shape, other letters: initials of two words of the final name against
    // paths that hold them scattered across intermediate folders.
    {
      query: 'sd',
      expected: 'C:\\work\\SpreadSheet',
      rivals: ['C:\\Users\\Sara\\Downloads', 'C:\\Users\\Simon\\Documents']
    },
    {
      query: 'tb',
      expected: 'C:\\repo\\TokenBridge',
      rivals: ['C:\\Users\\Teresa\\Backup', 'C:\\Users\\Thomas\\Briefs']
    },
    {
      query: 'nm',
      expected: 'C:\\projects\\NoteMaker',
      rivals: ['C:\\Users\\Nadia\\Music', 'C:\\Users\\Nick\\Maps']
    },
    {
      query: 'pv',
      expected: 'C:\\src\\ProjectVault',
      rivals: ['C:\\Users\\Paul\\Projects\\vintage', 'C:\\Users\\Paul\\Documents\\Videos']
    },
    {
      query: 'db',
      expected: 'D:\\work\\DataBridge',
      rivals: ['C:\\Users\\David\\Backup', 'C:\\Users\\Diana\\Board']
    }
  ]

  for (const { query, expected, rivals } of issueCases) {
    it(`"${query}" ranks ${expected} ahead of ${rivals.length} paths containing scattered characters`, () => {
      // The starting order puts the victim last: if ranking did not really reorder,
      // the test would pass by accident.
      const list = [...rivals, expected]
      const ranking = rankBy(query, list, (p) => p)

      assert.equal(ranking.length, list.length, 'all paths should match')
      assert.equal(ranking[0].item, expected, `expected first ${expected}, got ${ranking[0].item}`)

      // Coming first by one point is not enough: the lead must be clear, otherwise
      // the next tuning of the weights flips the order again.
      for (const rival of rivals) {
        const rivalRank = ranking.find((r) => r.item === rival)!
        assert.ok(
          ranking[0].score > rivalRank.score,
          `${expected} (${ranking[0].score}) does not beat ${rival} (${rivalRank.score})`
        )
      }
    })
  }

  it('"man" prefers ClaudeManager over manuals buried midway in path', () => {
    // This is the example cited in the module's comment: a match in the final
    // name must be worth more than one in an intermediate folder.
    const ranking = rankBy(
      'man',
      ['C:\\Users\\Mark\\Documents\\manuals\\attachments', 'C:\\dev\\ClaudeManager'],
      (p) => p
    )
    assert.equal(ranking[0].item, 'C:\\dev\\ClaudeManager')
  })

  it('positions point to word initials, not drive letter', () => {
    // If the greedy match were chosen, the first position would be 0 (the drive's
    // 'C:') and the user would see the wrong letter highlighted.
    const text = 'C:\\dev\\ClaudeManager'
    const result = fuzzyMatch('cm', text)
    assert.ok(result, 'no match')
    verifyPositions('cm', text, result.positions)
    assert.deepEqual(
      result.positions.map((i) => text[i]),
      ['C', 'M'],
      'highlighted characters differ from ClaudeManager initials'
    )
    assert.ok(result.positions[0] > text.lastIndexOf('\\'), 'match outside final component')
  })
})

describe('fuzzy: positions are always valid indices', () => {
  /** Paths mixing ASCII, accents, ideographs and emoji. */
  const corpus: Array<[string, string]> = [
    ['cm', 'C:\\dev\\ClaudeManager'],
    ['claudemanager', 'C:\\dev\\ClaudeManager'],
    ['c m', 'C:\\dev\\ClaudeManager'],
    ['C:', 'C:\\dev\\ClaudeManager'],
    ['r', 'C:\\dev\\ClaudeManager'],
    ['cafe', 'C:\\café\\naïve'],
    ['città', 'C:\\Users\\José\\città'],
    ['CITTÀ', 'C:\\Users\\José\\città'],
    ['josé', 'C:\\Users\\José\\note'],
    ['ù', 'C:\\Perù\\dati'],
    ['straße', 'C:\\dev\\Straße'],
    ['école', 'C:\\ÉCOLE\\lessons'],
    ['ns', 'C:\\日本語\\note 🚀 sessions'],
    ['日語', 'C:\\日本語\\project'],
    ['🚀', 'C:\\rockets\\a🚀b'],
    ['🚀x', 'C:\\rockets\\🚀xy'],
    ['ırmak', 'C:\\Irmak\\ırmak']
  ]

  for (const [pattern, text] of corpus) {
    it(`"${pattern}" on ${text}`, () => {
      const result = fuzzyMatch(pattern, text)
      assert.ok(result, `${JSON.stringify(pattern)} should match ${JSON.stringify(text)}`)
      verifyPositions(pattern, text, result.positions)
    })
  }

  it('when there is no match, never returns fabricated indices', () => {
    // Texts with characters whose lowercase form changes length: that is where
    // indices found on one string and used on another would go out of range.
    for (const text of ['İstanbul', 'C:\\dev\\İstanbul', 'C:\\ǰ\\ǅungla']) {
      for (const pattern of ['x', 'zqw', 'stanbul', 'dev', 'un']) {
        const result = fuzzyMatch(pattern, text)
        if (result) verifyPositions(pattern, text, result.positions)
      }
    }
  })
})

describe('fuzzy: edge cases of query', () => {
  it('empty query matches everything without highlights', () => {
    // A freshly opened picker has an empty field: it must show the whole list,
    // not zero results.
    const result = fuzzyMatch('', 'C:\\dev\\ClaudeManager')
    assert.deepEqual(result, { score: 0, positions: [] })

    const list = ['C:\\a', 'C:\\b', 'C:\\c']
    assert.equal(rankBy('', list, (p) => p).length, list.length)
  })

  it('query longer than text does not match', () => {
    assert.equal(fuzzyMatch('claudemanager', 'C:\\cm'), null)
    assert.equal(fuzzyMatch('a', ''), null)
  })

  it('query with no matching sequence returns null', () => {
    assert.equal(fuzzyMatch('zqw', 'C:\\dev\\ClaudeManager'), null)
    // All the letters are there, but not in the order typed.
    assert.equal(fuzzyMatch('mc', 'C:\\cm'), null)
  })

  it('text identical to query matches in full', () => {
    const result = fuzzyMatch('project', 'project')
    assert.ok(result)
    assert.deepEqual(result.positions, [0, 1, 2, 3, 4, 5, 6])
  })
})

describe('fuzzy: query is plain text, not a regular expression', () => {
  /** What happens when typing fast or pasting a path. */
  const hazardous = ['.*', '[', ']', '\\', '(?<', '(', ')', '+', '?', '|', '^', '$', '{2}', '[a-z]', '\\d+', '**']

  it('no query throws an unhandled exception', () => {
    const texts = ['C:\\dev\\ClaudeManager', 'C:\\a.b*c\\[x]\\(?<y>)', '', 'a', 'C:\\日本語\\🚀']
    for (const pattern of hazardous) {
      for (const text of texts) {
        const result = fuzzyMatch(pattern, text)
        if (result) verifyPositions(pattern, text, result.positions)
      }
      // Through the ranking too, which is the way the UI calls it.
      assert.doesNotThrow(() => rankBy(pattern, texts, (t) => t))
    }
  })

  it('special characters are matched literally', () => {
    // '.*' is not "anything": it must find a dot followed by an asterisk,
    // otherwise the search would return the whole universe.
    const text = 'C:\\a.b*c\\end'
    const result = fuzzyMatch('.*', text)
    assert.ok(result)
    verifyPositions('.*', text, result.positions)
    assert.equal(fuzzyMatch('.*', 'C:\\plain\\path'), null)

    // The backslash is the path separator: it must stay searchable.
    const withSlash = fuzzyMatch('\\dev', 'C:\\dev\\ClaudeManager')
    assert.ok(withSlash)
    verifyPositions('\\dev', 'C:\\dev\\ClaudeManager', withSlash.positions)
  })
})

describe('fuzzy: performance on large texts', () => {
  it('searches across hundred thousand characters in milliseconds', () => {
    // A pathological scrollback or path must not freeze the UI: the picker runs
    // the search again on every key press.
    const large = 'C:\\' + 'xyz'.repeat(33_333) + '\\VeryLongSession'
    assert.ok(large.length > 100_000)

    const start = process.hrtime.bigint()
    for (let round = 0; round < 20; round++) {
      fuzzyMatch('vls', large)
      fuzzyMatch('xyz', large)
      fuzzyMatch('qwk', large)
    }
    const ms = Number(process.hrtime.bigint() - start) / 1e6

    assert.ok(ms < 500, `60 searches over ${large.length} chars took ${ms.toFixed(1)} ms`)
  })
})

describe('fuzzy: rankBy', () => {
  const list = [
    'C:\\Users\\Sara\\Documents\\notes',
    'C:\\dev\\ClaudeManager',
    'C:\\Users\\Carlo\\Music',
    'C:\\dev\\ClaudeManager\\src\\main',
    'C:\\Users\\Chiara\\Models',
    'C:\\temp\\cache\\thumbnails',
    'C:\\work\\MilanClients'
  ]

  it('sorts by descending score', () => {
    const ranking = rankBy('cm', list, (p) => p)
    assert.ok(ranking.length > 1, 'need multiple results to check ordering')

    for (let i = 1; i < ranking.length; i++) {
      assert.ok(
        ranking[i - 1].score >= ranking[i].score,
        `position ${i}: ${ranking[i - 1].score} before ${ranking[i].score}`
      )
    }
  })

  it('returns identical score and positions as single match for each item', () => {
    for (const entry of rankBy('cm', list, (p) => p)) {
      const direct = fuzzyMatch('cm', entry.item)
      assert.ok(direct)
      assert.equal(entry.score, direct.score, entry.item)
      assert.deepEqual(entry.positions, direct.positions, entry.item)
      verifyPositions('cm', entry.item, entry.positions)
    }
  })

  it('filters out non-matching items without dropping valid matches', () => {
    assert.equal(rankBy('zqw', list, (p) => p).length, 0)

    const matched = list.filter((p) => fuzzyMatch('cm', p) !== null)
    const ranking = rankBy('cm', list, (p) => p)
    assert.deepEqual(
      [...ranking.map((r) => r.item)].sort(),
      [...matched].sort(),
      'ranking does not contain exactly the matching items'
    )
  })

  it('respects limit keeping top scores', () => {
    const full = rankBy('cm', list, (p) => p)
    const truncated = rankBy('cm', list, (p) => p, 2)
    assert.equal(truncated.length, 2)
    assert.deepEqual(
      truncated.map((r) => r.item),
      full.slice(0, 2).map((r) => r.item),
      'truncation discarded top items instead of lowest'
    )
  })

  it('extracts text using provided accessor function, not string representation', () => {
    // In the UI the entries are sessions, not strings: if rankBy read the object,
    // the search would run on "[object Object]".
    const sessions = [
      { id: 1, path: 'C:\\Users\\Carlo\\Music' },
      { id: 2, path: 'C:\\dev\\ClaudeManager' }
    ]
    const ranking = rankBy('cm', sessions, (s) => s.path)
    assert.equal(ranking[0].item.id, 2)
  })
})

describe('fuzzy: observed behaviors for documentation', () => {
  it.skip('finds exact folder name containing Turkish dotted capital I', () => {
    // Known defect, tracked in #29: fuzzyMatch('İstanbul', 'C:\\dev\\İstanbul')
    // returns null. The module deliberately stops ignoring case when
    // toLowerCase() changes the length of the text, but it still lowercases the
    // QUERY: 'İ' becomes two units ('i' plus a combining mark) that do not exist in
    // the text, which is now compared literally. The folder cannot be found even
    // by typing its full name.
    assert.notEqual(fuzzyMatch('İstanbul', 'C:\\dev\\İstanbul'), null)
  })

  it.skip('matches accented paths when typing unaccented query', () => {
    // Known defect, tracked in #29: fuzzyMatch('citta', 'C:\\dev\\città') returns
    // null, while 'città' and 'CITTÀ' work. It may be a choice, but in an Italian
    // project accented names are common and almost always typed without the
    // accent.
    assert.notEqual(fuzzyMatch('citta', 'C:\\dev\\città'), null)
  })
})
