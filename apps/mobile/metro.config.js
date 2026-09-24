// Standard Expo monorepo config (https://docs.expo.dev/guides/monorepos/) —
// needed as of Phase B (docs/15-MARKETING-SITE-PWA-SCOPING.md §6), the
// first time this app imports a workspace package (@involveme/legal-content).
// Metro's default resolver does not reliably follow npm-workspace symlinks
// outside its watched folders, so without this, resolving/watching a
// package that lives outside apps/mobile/ (packages/legal-content/, an
// npm-workspace symlink under the repo root's node_modules) is not
// guaranteed to work even though `tsc` alone would report no error.

const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..', '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
