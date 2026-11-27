/**
 * Release notes come from CHANGELOG.md: the section of a version is the text
 * between its `## <version> ` heading and the next `## `.
 *
 * Pure functions, shared by the local release script and the release workflow.
 */

/**
 * The CHANGELOG.md section of a version, heading included, or '' when the
 * version has none.
 *
 * @param {string} md contents of CHANGELOG.md
 * @param {string} version e.g. '1.2.0'
 */
export function changelogEntryFor(md, version) {
  const lines = md.split(/\r?\n/)
  const start = lines.findIndex((l) => l.startsWith(`## ${version} `))
  if (start === -1) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => l.startsWith('## '))
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n').trim()
}

/**
 * What the release workflow is about to publish, or why it must not.
 *
 * The workflow builds whatever the tag points at, so the tag and package.json
 * must agree: otherwise the packages would carry one version and the release
 * another, and latest.yml would offer installed copies an update to a version
 * that is not the one they download. A release without notes is stopped too:
 * the changelog section is what the release page shows.
 *
 * @param {object} input
 * @param {string} input.version   version in package.json
 * @param {string} input.ref       the git ref the workflow runs on (GITHUB_REF_NAME)
 * @param {string} input.changelog contents of CHANGELOG.md
 * @returns {{ tag: string, title: string, notes: string }}
 */
export function releasePlan({ version, ref, changelog }) {
  const tag = `v${version}`
  if (ref !== tag) {
    throw new Error(
      `The workflow runs on "${ref || '(no ref)'}", but package.json says ${version}: ` +
        `it must run on tag ${tag}.`
    )
  }
  const entry = changelogEntryFor(changelog, version)
  if (!entry) {
    throw new Error(`CHANGELOG.md has no "## ${version} " section: write the release notes first.`)
  }
  // The release page has its own title: the notes start below the heading.
  const notes = entry.split('\n').slice(1).join('\n').trim()
  return { tag, title: `ClaudeManager ${version}`, notes }
}
