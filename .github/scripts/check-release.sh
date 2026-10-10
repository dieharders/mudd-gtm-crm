#!/usr/bin/env bash
# Can $TAG take a draft release built from $GITHUB_SHA? Exits non-zero with an ::error:: if not;
# otherwise writes release=draft (one exists, to update) or release=none to $GITHUB_OUTPUT.
#
# Run by both jobs in release.yml: "Re-run failed jobs" re-runs the release job without the
# version job, and a draft can be published in between.
#
# Needs GH_TOKEN, GH_REPO, TAG and a checkout (for git ls-remote).
set -euo pipefail

if ! is_draft=$(gh release view "$TAG" --json isDraft -q .isDraft 2>gh-error.txt); then
  # Only "not found" means there is no release. Anything else (auth, rate limit, outage) is not
  # an answer, and guessing "none" here would create a second draft.
  if ! grep -q "release not found" gh-error.txt; then
    echo "::error::Could not look up release $TAG: $(cat gh-error.txt)"
    exit 1
  fi
  is_draft=none
fi
rm -f gh-error.txt

if [ "$is_draft" = "false" ]; then
  echo "::error::$TAG is already published. Bump the version in package.json and run again with the new tag."
  exit 1
fi

# A tag with no release (pushed by hand, or left behind when a release was deleted) would carry
# the draft to its own commit, not the one built here, and publishing would ship binaries that
# don't match the tagged source. An annotated tag lists its commit as "<tag>^{}", which sorts last.
tag_sha=$(git ls-remote --tags origin "refs/tags/$TAG" "refs/tags/$TAG^{}" | sort -k2 | tail -n1 | cut -f1)
if [ -n "$tag_sha" ] && [ "$tag_sha" != "$GITHUB_SHA" ]; then
  echo "::error::Tag $TAG already exists at $tag_sha, not at the commit being built ($GITHUB_SHA). Delete the tag (git push origin :refs/tags/$TAG) or bump the version."
  exit 1
fi

if [ "$is_draft" = "true" ]; then
  echo "release=draft" >> "$GITHUB_OUTPUT"
else
  echo "release=none" >> "$GITHUB_OUTPUT"
fi
