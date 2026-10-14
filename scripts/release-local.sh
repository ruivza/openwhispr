#!/bin/bash
set -euo pipefail

# Based on the local-keychain release flow used by ruivza/speechdock.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

usage() {
    cat <<'HELP'
Usage: bash scripts/release-local.sh --run RUN_ID [--repo OWNER/REPO] [--arch all|arm64|x64] [--publish]

Download a successful tagged build and sign/notarize macOS packages locally.
Default: sign both Mac architectures and keep the DMGs under build/.
--publish adds signed Mac DMGs and checksums to the version Release.
GitHub publishes Windows/Linux packages separately. Existing assets are not replaced.
--arch selects one Mac architecture for local testing; publishing requires all.

Required: NOTARY_PROFILE, a notarytool profile in this Mac's Keychain.
Optional: NOTARY_KEYCHAIN and SIGNING_IDENTITY (exact Developer ID name or SHA-1).
Requires macOS, Python 3.9+, Xcode command-line tools, git, and gh.
Check out the matching vX.Y.Z tag before running. No local app compilation is needed.
HELP
}

RUN_ID=""
REPOSITORY="ruivza/openwhispr"
ARCH="all"
PUBLISH=false
while [ "$#" -gt 0 ]; do
    case "$1" in
        --run|--repo|--arch)
            [ "$#" -ge 2 ] || { usage >&2; exit 1; }
            case "$1" in
                --run) RUN_ID="$2" ;;
                --repo) REPOSITORY="$2" ;;
                --arch) ARCH="$2" ;;
            esac
            shift 2 ;;
        --publish) PUBLISH=true; shift ;;
        --help|-h) usage; exit 0 ;;
        *) usage >&2; exit 1 ;;
    esac
done
[[ "$RUN_ID" =~ ^[0-9]+$ ]] || { echo "Error: --run requires a numeric run ID." >&2; exit 1; }
[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "Error: invalid repository." >&2; exit 1; }
case "$ARCH" in all|arm64|x64) ;; *) echo "Error: invalid architecture." >&2; exit 1 ;; esac
[ "$PUBLISH" = false ] || [ "$ARCH" = all ] || { echo "Error: publishing requires --arch all." >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || { echo "Error: run this script on your signing Mac." >&2; exit 1; }
: "${NOTARY_PROFILE:?Set NOTARY_PROFILE to your local notarytool Keychain profile}"
for tool in gh python3 git security codesign ditto hdiutil xcrun spctl lipo shasum; do
    command -v "$tool" >/dev/null || { echo "Error: missing $tool." >&2; exit 1; }
done
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else "Python 3.9+ is required")'

VERSION=$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Error: expected a stable X.Y.Z package version." >&2; exit 1; }
TAG="v$VERSION"
COMMIT=$(git rev-parse "refs/tags/$TAG^{commit}")
[[ "$(git rev-parse HEAD)" = "$COMMIT" ]] || { echo "Error: check out $TAG before signing." >&2; exit 1; }
# The launcher may receive download/publishing fixes after a tagged build.
# Keep the signing helper, entitlements, and all other build inputs at that tag.
git diff --quiet "$COMMIT" -- scripts package.json resources/mac .github/workflows \
    ':(exclude)scripts/release-local.sh' || {
    echo "Error: signing helpers, entitlements, and workflow must match $TAG." >&2; exit 1;
}
gh auth status --hostname github.com >/dev/null
[[ "$(gh api "repos/$REPOSITORY/commits/$TAG" --jq .sha)" = "$COMMIT" ]] || {
    echo "Error: local and remote tags differ." >&2; exit 1;
}

SIGNING_IDENTITY=$(security find-identity -v -p codesigning | python3 -c '
import re, sys
requested = sys.argv[1]
identities = re.findall(r"\b([A-Fa-f0-9]{40})\s+\"(Developer ID Application:[^\"]+)\"", sys.stdin.read())
matches = list(dict.fromkeys(key for key, name in identities if not requested or requested in (key, name)))
if len(matches) != 1:
    raise SystemExit("Install one Developer ID Application with its private key, or set SIGNING_IDENTITY to an exact name or SHA-1.")
print(matches[0])
' "${SIGNING_IDENTITY:-}")
AUTH_ARGS=(--keychain-profile "$NOTARY_PROFILE")
if [ -n "${NOTARY_KEYCHAIN:-}" ]; then AUTH_ARGS+=(--keychain "$NOTARY_KEYCHAIN"); fi

mkdir -p "$PROJECT_DIR/build"
WORK_DIR=$(mktemp -d "$PROJECT_DIR/build/local-release.XXXXXX")
# Keep failed runs and notarization logs for diagnosis; never replace an old build.
echo "Release workspace: $WORK_DIR"
mkdir "$WORK_DIR/output"
echo "Checking GitHub build $RUN_ID for $TAG..."
gh run view "$RUN_ID" --repo "$REPOSITORY" \
    --json headSha,headBranch,status,conclusion,event,workflowName > "$WORK_DIR/run.json"
python3 "$SCRIPT_DIR/lib/macos-release.py" validate-run "$WORK_DIR/run.json" "$COMMIT" "$TAG"

notarize() {
    local file="$1"
    local result="$2"
    echo "Submitting $(basename "$file") to Apple; waiting for notarization..."
    xcrun notarytool submit "$file" "${AUTH_ARGS[@]}" --wait --output-format json > "$result"
    python3 - "$result" <<'PY'
import json, sys
result = json.load(open(sys.argv[1]))
if result.get("status") != "Accepted":
    raise SystemExit("Notarization failed; inspect " + sys.argv[1] + " (submission " + str(result.get("id")) + ")")
PY
}

if [ "$ARCH" = all ]; then ARCHS=(arm64 x64); else ARCHS=("$ARCH"); fi
for arch in "${ARCHS[@]}"; do
    echo "[$arch] Downloading macOS build from GitHub (this may take several minutes)..."
    gh run download "$RUN_ID" --repo "$REPOSITORY" \
        --name "macos-$arch-unsigned-build" --dir "$WORK_DIR/download-$arch"
    echo "[$arch] Download complete. Validating and extracting app..."
    python3 "$SCRIPT_DIR/lib/macos-release.py" extract \
        "$WORK_DIR/download-$arch/OpenWhispr-macos-$arch-unsigned-app.tar.gz" \
        "$WORK_DIR/extracted-$arch" "$VERSION" "$COMMIT" "$arch"
    APP="$WORK_DIR/extracted-$arch/OpenWhispr.app"
    EXPECTED_ARCH="$arch"
    if [ "$arch" = x64 ]; then EXPECTED_ARCH=x86_64; fi
    [[ "$(lipo -archs "$APP/Contents/MacOS/OpenWhispr")" = "$EXPECTED_ARCH" ]] || {
        echo "Error: app binary architecture does not match $arch." >&2; exit 1;
    }
    echo "[$arch] Signing app and nested binaries..."
    python3 "$SCRIPT_DIR/lib/macos-release.py" sign "$APP" --identity "$SIGNING_IDENTITY" --version "$VERSION"

    # Notarize/staple the app before packaging, then notarize/staple the DMG.
    # This allows Gatekeeper validation even after the app is copied off the DMG.
    ditto -c -k --keepParent "$APP" "$WORK_DIR/notarize-$arch.zip"
    notarize "$WORK_DIR/notarize-$arch.zip" "$WORK_DIR/notary-app-$arch.json"
    xcrun stapler staple "$APP"
    xcrun stapler validate "$APP"
    spctl --assess --type execute --verbose=2 "$APP"

    VOLUME="$WORK_DIR/volume-$arch"
    mkdir "$VOLUME"
    ditto "$APP" "$VOLUME/OpenWhispr.app"
    ln -s /Applications "$VOLUME/Applications"
    DMG="$WORK_DIR/output/OpenWhispr-$VERSION-mac-$arch.dmg"
    hdiutil create -volname OpenWhispr -srcfolder "$VOLUME" -format UDZO -fs HFS+ "$DMG"
    hdiutil verify "$DMG"
    codesign --force --sign "$SIGNING_IDENTITY" --timestamp "$DMG"
    codesign --verify --strict "$DMG"
    notarize "$DMG" "$WORK_DIR/notary-dmg-$arch.json"
    xcrun stapler staple "$DMG"
    xcrun stapler validate "$DMG"
    spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG"
done

(cd "$WORK_DIR/output" && shasum -a 256 ./*) > "$WORK_DIR/SHA256SUMS-macos"
mv "$WORK_DIR/SHA256SUMS-macos" "$WORK_DIR/output/SHA256SUMS-macos"

if [ "$PUBLISH" = true ]; then
    [[ "$(gh api "repos/$REPOSITORY/commits/$TAG" --jq .sha)" = "$COMMIT" ]] || {
        echo "Error: remote tag changed during notarization." >&2; exit 1;
    }
    echo "Publishing signed macOS DMGs and checksums to $REPOSITORY ($TAG)..."
    if ! gh release view "$TAG" --repo "$REPOSITORY" >/dev/null 2>&1; then
        # The CI publisher may create the Release concurrently.
        gh release create "$TAG" --repo "$REPOSITORY" --verify-tag \
            --title "OpenWhispr $VERSION" --generate-notes || \
            gh release view "$TAG" --repo "$REPOSITORY" >/dev/null
    fi
    gh release upload "$TAG" "$WORK_DIR/output/"* --repo "$REPOSITORY"
else
    echo "Ready: $WORK_DIR/output"
    echo "Use --publish to upload the signed Mac packages to the version Release."
fi
