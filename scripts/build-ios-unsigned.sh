#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MOBILE_DIR="$PROJECT_DIR/openwhispr-mobile"
OUTPUT_DIR="${OUTPUT_DIR:-$PROJECT_DIR/build/ios-unsigned}"

usage() {
    cat <<'HELP'
Usage: bash scripts/build-ios-unsigned.sh [--output-dir DIR]

Build a Release iPhoneOS arm64 archive and an unsigned IPA for local re-signing.
Requires macOS, full Xcode, Node 24, Python 3.11+, and prepared npm/Bundler dependencies.
Required: OPENWHISPR_IOS_BUNDLE_IDENTIFIER, your own reverse-domain bundle identifier.
Optional: OPENWHISPR_SCHEME (URL scheme, defaults to your bundle identifier),
          OPENWHISPR_IOS_SCHEME (an existing Xcode scheme; discovered when unambiguous).
This script does not install certificates, sign, export, upload, or publish the app.
HELP
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --output-dir)
            [ "$#" -ge 2 ] && [ -n "$2" ] || { usage >&2; exit 1; }
            OUTPUT_DIR="$2"; shift 2 ;;
        --help|-h) usage; exit 0 ;;
        *) usage >&2; exit 1 ;;
    esac
done

: "${OPENWHISPR_IOS_BUNDLE_IDENTIFIER:?Set OPENWHISPR_IOS_BUNDLE_IDENTIFIER to your own bundle identifier}"
[[ "$OPENWHISPR_IOS_BUNDLE_IDENTIFIER" =~ ^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$ ]] || {
    echo "Error: use a reverse-domain bundle identifier beginning with a letter." >&2; exit 1;
}
[ "$(uname -s)" = Darwin ] || { echo "Error: building iOS requires macOS and full Xcode." >&2; exit 1; }
for tool in node python3 bundle xcodebuild git tee; do
    command -v "$tool" >/dev/null || { echo "Error: missing $tool." >&2; exit 1; }
done
[ "$(node -p 'process.versions.node.split(".")[0]')" = 24 ] || {
    echo "Error: the mobile project requires Node 24." >&2; exit 1;
}
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else "Python 3.11+ is required")'
[ -f "$MOBILE_DIR/node_modules/expo/bin/cli" ] || {
    echo "Error: prepare mobile dependencies with npm ci --ignore-scripts, patch-package, and test:security first." >&2; exit 1;
}

export OPENWHISPR_APP_ENV=production
export OPENWHISPR_UNSIGNED_IOS_BUILD=1
export OPENWHISPR_SCHEME="${OPENWHISPR_SCHEME:-$OPENWHISPR_IOS_BUNDLE_IDENTIFIER}"
export BUNDLE_GEMFILE="$MOBILE_DIR/Gemfile"
export CI=1
export EXPO_NO_TELEMETRY=1

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd -P)"
LOG_DIR="$OUTPUT_DIR/logs"
mkdir -p "$LOG_DIR"
WORK_DIR="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/openwhispr-ios-unsigned.XXXXXX")"
ARCHIVE_PATH="$WORK_DIR/OpenWhispr.xcarchive"
EXPO_CLI="$MOBILE_DIR/node_modules/expo/bin/cli"

trap 'status=$?; if [ "$status" -ne 0 ]; then echo "iOS build failed. Logs: $LOG_DIR; intermediate files: $WORK_DIR" >&2; fi' EXIT

# Pure selection/validation code is also exercised by the cross-platform tests.
select_input() {
    python3 - "$@" <<'PY_SELECTION'
import json
import re
import sys
from pathlib import Path


def workspace_path(ios_root):
    candidates = sorted(p for p in Path(ios_root).glob("*.xcworkspace") if p.is_dir() and p.name != "Pods.xcworkspace")
    if len(candidates) != 1:
        raise ValueError("Expected one generated app workspace; refusing to guess among multiple workspaces")
    return str(candidates[0].resolve())


def project_path(ios_root, workspace):
    candidates = sorted(p for p in Path(ios_root).glob("*.xcodeproj") if p.is_dir() and p.name != "Pods.xcodeproj")
    matching = [p for p in candidates if p.stem == Path(workspace).stem]
    if len(matching) == 1:
        return str(matching[0].resolve())
    if len(candidates) == 1:
        return str(candidates[0].resolve())
    raise ValueError("Cannot identify the app project for the generated workspace")


def scheme_name(listing, workspace, requested=""):
    if not isinstance(listing, dict) or not isinstance(listing.get("workspace"), dict):
        raise ValueError("xcodebuild did not return a workspace scheme list")
    schemes = listing.get("workspace", {}).get("schemes")
    if not isinstance(schemes, list) or not schemes or any(not isinstance(s, str) or not s or "\n" in s or "\r" in s for s in schemes):
        raise ValueError("xcodebuild did not return a valid workspace scheme list")
    if requested:
        if requested not in schemes:
            raise ValueError("OPENWHISPR_IOS_SCHEME is not present in the generated workspace")
        return requested
    if Path(workspace).stem in schemes:
        return Path(workspace).stem
    if len(schemes) == 1:
        return schemes[0]
    raise ValueError("Ambiguous schemes: set OPENWHISPR_IOS_SCHEME to the main application scheme")


def validate_config(config, bundle_id):
    if not isinstance(config, dict):
        raise ValueError("Expo config must be a JSON object")
    config = config.get("expo", config)
    if not isinstance(config, dict):
        raise ValueError("Expo config must be a JSON object")
    ios = config.get("ios", {})
    environment = config.get("extra", {}).get("openWhispr", {})
    if not isinstance(ios, dict) or not isinstance(environment, dict):
        raise ValueError("Expo config is missing its iOS identity")
    if ios.get("bundleIdentifier") != bundle_id or environment.get("iosBundleIdentifier") != bundle_id:
        raise ValueError("Expo config did not resolve the requested bundle identifier")
    if ios.get("appleTeamId"):
        raise ValueError("Unsigned Expo config must not select an Apple development team")
    group = "group." + bundle_id
    if environment.get("appGroupId") != group or ios.get("entitlements", {}).get("com.apple.security.application-groups") != [group]:
        raise ValueError("Expo config must use the App Group derived from the requested bundle identifier")
    if environment.get("keyboardBundleIdentifier") != bundle_id + ".keyboard":
        raise ValueError("Expo config must retain the matching keyboard extension")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9+.-]*", environment.get("scheme", "")):
        raise ValueError("The app URL scheme is invalid")


def validate_main_settings(settings, bundle_id):
    if not isinstance(settings, list) or any(not isinstance(item, dict) or not isinstance(item.get("buildSettings"), dict) for item in settings):
        raise ValueError("xcodebuild did not return an array of build settings")
    apps = [item.get("buildSettings", {}) for item in settings if isinstance(item, dict) and item.get("buildSettings", {}).get("PRODUCT_TYPE") == "com.apple.product-type.application"]
    if len(apps) != 1 or apps[0].get("PRODUCT_BUNDLE_IDENTIFIER") != bundle_id:
        raise ValueError("Selected scheme must build exactly the requested main application")
    main = apps[0]
    if main.get("PLATFORM_NAME") != "iphoneos" or "arm64" not in main.get("ARCHS", "").split():
        raise ValueError("Selected scheme must target physical iOS devices with arm64")
    if main.get("CODE_SIGNING_ALLOWED") != "NO" or main.get("CODE_SIGNING_REQUIRED") != "NO" or main.get("DEVELOPMENT_TEAM") or main.get("CODE_SIGN_IDENTITY") or main.get("PROVISIONING_PROFILE_SPECIFIER"):
        raise ValueError("Build settings must disable signing and clear all signing identities")


if __name__ == "__main__":
    try:
        action, *args = sys.argv[1:]
        if action == "workspace":
            print(workspace_path(*args))
        elif action == "project":
            print(project_path(*args))
        else:
            data = json.loads(Path(args[0]).read_text(encoding="utf-8"))
            if action == "scheme":
                print(scheme_name(data, *args[1:]))
            elif action == "config":
                validate_config(data, *args[1:])
            elif action == "settings":
                validate_main_settings(data, *args[1:])
            else:
                raise ValueError("Unknown iOS build selection action")
    except (ValueError, TypeError, KeyError, OSError) as error:
        sys.exit(f"Error: {error}")
PY_SELECTION
}

run_logged() {
    local name="$1"
    shift
    "$@" 2>&1 | tee "$LOG_DIR/$name.log"
}

cd "$MOBILE_DIR"
# A public unsigned build uses the existing Space Grotesk fallback. Do not
# download private/licensed assets or silently publish files from a local cache.
if [ -d assets/fonts/yowza ] && find -H assets/fonts/yowza \( -iname '*.otf' -o -iname '*.ttf' \) -print -quit | grep -q .; then
    echo "Error: use a fresh checkout without licensed Yowza font files for this public unsigned build." >&2
    exit 1
fi

echo "Validating Expo configuration and generating iOS project..."
node "$EXPO_CLI" config --type prebuild --json > "$LOG_DIR/expo-config.json" 2> "$LOG_DIR/expo-config.stderr.log"
select_input config "$LOG_DIR/expo-config.json" "$OPENWHISPR_IOS_BUNDLE_IDENTIFIER"
run_logged prebuild node "$EXPO_CLI" prebuild --platform ios --no-install
run_logged bundle-check bundle check
cd "$MOBILE_DIR/ios"
echo "Installing CocoaPods and Swift Package dependencies..."
run_logged pods bundle exec pod install

WORKSPACE="$(select_input workspace "$MOBILE_DIR/ios")"
XCODE_PROJECT="$(select_input project "$MOBILE_DIR/ios" "$WORKSPACE")"
xcodebuild -list -json -workspace "$WORKSPACE" > "$LOG_DIR/workspace-list.json" 2> "$LOG_DIR/workspace-list.stderr.log"
SCHEME="$(select_input scheme "$LOG_DIR/workspace-list.json" "$WORKSPACE" "${OPENWHISPR_IOS_SCHEME:-}")"

SIGNING_ARGS=(
    CODE_SIGNING_ALLOWED=NO
    CODE_SIGNING_REQUIRED=NO
    'CODE_SIGN_IDENTITY='
    'DEVELOPMENT_TEAM='
    'PROVISIONING_PROFILE_SPECIFIER='
)
DEVICE_ARGS=(-configuration Release -sdk iphoneos ARCHS=arm64 ONLY_ACTIVE_ARCH=NO)

# Query the selected scheme to reject an extension/test/simulator-only scheme.
xcodebuild -showBuildSettings -json -workspace "$WORKSPACE" -scheme "$SCHEME" \
    -destination 'generic/platform=iOS' "${DEVICE_ARGS[@]}" "${SIGNING_ARGS[@]}" \
    > "$LOG_DIR/schemeBuildSettings.json" 2> "$LOG_DIR/schemeBuildSettings.stderr.log"
select_input settings "$LOG_DIR/schemeBuildSettings.json" "$OPENWHISPR_IOS_BUNDLE_IDENTIFIER"
# -alltargets also records the keyboard and Live Activity entitlements; scheme
# build settings alone may report only the main app.
xcodebuild -showBuildSettings -json -project "$XCODE_PROJECT" -alltargets \
    "${DEVICE_ARGS[@]}" "${SIGNING_ARGS[@]}" \
    > "$LOG_DIR/showBuildSettings.json" 2> "$LOG_DIR/showBuildSettings.stderr.log"

XCODE_VERSION="$(xcodebuild -version)"
printf '%s\n' "$XCODE_VERSION" > "$LOG_DIR/xcode-version.txt"
echo "Archiving $SCHEME for physical iOS devices without signing..."
run_logged archive xcodebuild archive -workspace "$WORKSPACE" -scheme "$SCHEME" \
    -destination 'generic/platform=iOS' -archivePath "$ARCHIVE_PATH" \
    -derivedDataPath "$WORK_DIR/DerivedData" -resultBundlePath "$LOG_DIR/archive.xcresult" \
    "${DEVICE_ARGS[@]}" "${SIGNING_ARGS[@]}"

COMMIT="$(git -C "$PROJECT_DIR" rev-parse HEAD)"
python3 "$SCRIPT_DIR/lib/ios-unsigned.py" package \
    --archive "$ARCHIVE_PATH" --output-dir "$OUTPUT_DIR" \
    --bundle-id "$OPENWHISPR_IOS_BUNDLE_IDENTIFIER" --commit "$COMMIT" \
    --build-settings "$LOG_DIR/showBuildSettings.json" --xcode-version "$XCODE_VERSION"
echo "Unsigned device artifacts are ready in $OUTPUT_DIR. Local signing is required before installation."
