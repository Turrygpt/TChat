'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function publishRelease({ version, repository, target, gh, exists = fs.existsSync }) {
  const tag = `v${version}`;
  const installer = `TChat-Setup-${version}.exe`;
  const names = [installer, `${installer}.blockmap`, 'latest.yml'];
  // Listing releases distinguishes an absent release from API/auth failures.
  const pages = JSON.parse(gh(['api', `repos/${repository}/releases`, '--paginate', '--slurp']));
  const release = pages.flat().find((item) => item.tag_name === tag);
  if (release && !release.draft) {
    const missing = names.filter((name) => !release.assets.some((asset) => asset.name === name && asset.state === 'uploaded'));
    if (missing.length) {
      throw new Error(`Published release ${tag} is incomplete: ${missing.join(', ')}. Repair it with its original build artifacts; refusing to mix builds of the same version.`);
    }
    console.log(`Release ${tag} is already published with all update assets; leaving it unchanged.`);
    return;
  }

  const assets = names.map((name) => `dist/${name}`);
  for (const file of [...assets, 'dist/release-notes.md']) {
    if (!exists(file)) throw new Error(`Missing release file: ${file}`);
  }
  if (!release) {
    gh(['release', 'create', tag, '--repo', repository, '--target', target,
      '--title', `TChat ${version}`, '--notes-file', 'dist/release-notes.md', '--draft']);
  }
  // Replace the entire bundle only while hidden from the updater. A failed
  // upload leaves a draft that the next run can safely resume.
  gh(['release', 'upload', tag, ...assets, '--repo', repository, '--clobber']);
  gh(['release', 'edit', tag, '--repo', repository, '--title', `TChat ${version}`,
    '--notes-file', 'dist/release-notes.md', '--draft=false', '--latest']);
}

if (require.main === module) {
  try {
    publishRelease({
      version: require('../package.json').version,
      repository: process.env.GITHUB_REPOSITORY,
      target: process.env.GITHUB_SHA,
      gh: (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }),
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { publishRelease };
