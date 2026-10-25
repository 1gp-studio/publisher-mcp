const excluded = /^(?:node_modules|dist|build|out|vendor|coverage|target)$/i;
const secret = /^(?:credentials.*|secrets.*|.*\.(?:pem|key))$/i;
const releaseBuildConfig = /^(?:\.browserslistrc|\.swcrc|\.(?:babelrc|postcssrc)(?:\.(?:json|[cm]?js))?)$/i;

// These are source-controlled build inputs. Credential-bearing files such as .env,
// .npmrc and .yarnrc are deliberately absent, even when local freshness hashes them.
export function isReleaseBuildConfig(name) {
  return releaseBuildConfig.test(name);
}

// Keep release comparisons and GitHub's untracked-source check on the same boundary.
// Build output and the separately uploaded promotion kit do not need to be committed.
export function isReleaseSourcePath(path) {
  const parts = path.split(/[\\/]/);
  return parts[0]?.toLowerCase() !== '1gp-kit' && !parts.some((part, index) =>
    excluded.test(part) || secret.test(part) ||
    // A recognized config can be the final file, never a way into a hidden directory.
    part.startsWith('.') && (index !== parts.length - 1 || !isReleaseBuildConfig(part)));
}
