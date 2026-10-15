# Contributing to OpenWhispr Mobile

Thanks for your interest in contributing. This guide covers everything you need to fork, build, and submit a PR.

The mobile app is maintained in `openwhispr-mobile/` inside the main OpenWhispr repository, but it has its own dependencies, lockfile, commands, CI checks, and release process. Run the commands below from `openwhispr-mobile/`.

## Prerequisites

All contributors need:

- Git
- Node.js 24.x and npm

For iOS development:

- macOS with [Xcode 26.2 or newer](https://docs.expo.dev/versions/v55.0.0/)
- Ruby and Bundler for the locked CocoaPods dependencies
- An iOS Simulator, or a physical device for device-only testing

The simulator does not require an Apple Developer account. A paid Apple Developer Program membership is required to sign a physical-device build because the keyboard and activity extensions use an App Group capability.

For Android development:

- Android Studio with Android SDK 36
- An Android emulator or physical device

Android development does not require Xcode or an Apple Developer account. The EAS CLI is only required when working with EAS builds or submissions; it is not needed for normal local development.

## First-Time Setup

```bash
git clone https://github.com/<your-fork>/openwhispr.git
cd openwhispr/openwhispr-mobile
npm install
cp .env.example .env.local
```

The example uses the hosted OpenWhispr API and leaves optional integrations disabled. Edit `.env.local` only for the features or local identity values you need. Local environment files are ignored by Git. Personal provider and on-device development need no OpenWhispr production credentials. Enter provider keys only in the app, never in source, fixtures, or `EXPO_PUBLIC_` variables.

Install the locked Ruby dependencies before the first iOS build:

```bash
bundle install
```

The app's brand font, Yowza, is commercially licensed, so its files are not in the repository. `npm install` fetches them from a private release when your GitHub account has access (`npm run download:brand-fonts` fetches them again); without access the app uses Space Grotesk and works the same. The fonts are embedded when the native project is built, so rebuild with `npm run ios` after fetching them.

If you plan to build on a physical iOS device, configure a unique local identity and signing team first. See [Physical iOS Devices and Forks](#physical-ios-devices-and-forks).

## Development Workflow

```bash
npm start              # Start the Metro/Expo dev server
npm run ios            # Build and run on iOS (uses dev client)
npm run android        # Build and run on Android
npm run typecheck      # tsc --noEmit
npm run lint           # ESLint
npm run format         # Prettier --check
npm run format:write   # Prettier --write
npm run check          # format + lint + typecheck + Expo Doctor
npm run clean          # format + lint + typecheck
```

`npm run ios` runs `expo run:ios`, which executes `expo prebuild` and compiles the native project. The keyboard extension is wired in by the config plugin at `plugins/keyboard-extension/withKeyboardExtension.js` during prebuild.

OpenWhispr uses custom native modules, so Expo Go is not a supported development environment. Use `npm run ios` or `npm run android` to create a development build.

The `android`, `ios`, and `prebuild` npm scripts use POSIX environment-variable syntax. On Windows, put `OPENWHISPR_APP_ENV=development` in `.env.local` and run `npx expo run:android` or `npx expo prebuild` directly. iOS builds still require macOS.

## Environment Variables

Use [.env.example](./.env.example) as the canonical variable reference. It groups configuration into:

- hosted API and transcription settings;
- optional Sentry, AppsFlyer, Superwall, RevenueCat, and Google Calendar integrations;
- keyboard audio behavior; and
- local bundle identifiers, URL schemes, and display names.

Variables prefixed with `EXPO_PUBLIC_` are embedded in the application bundle and must never contain secrets. Keep contributor-specific values in `.env.local`, which is ignored by Git.

Note sharing uses `https://notes.openwhispr.com` with the hosted production API. When setting a custom `EXPO_PUBLIC_API_URL`, also set `EXPO_PUBLIC_NOTES_URL` to the matching notes viewer before creating links. The viewer URL must use HTTPS, except HTTP on loopback for local development. Configure the backend's `SHARE_VIEWER_BASE_URL` to the same viewer so invitation emails open in the correct environment.

## Physical iOS Devices and Forks

The committed configuration contains OpenWhispr's production identifiers. Do not manually replace identifiers throughout the source. For a local physical-device build, set a unique identity in `.env.local`:

```dotenv
OPENWHISPR_IOS_BUNDLE_IDENTIFIER=com.example.openwhispr.dev
OPENWHISPR_SCHEME=example-openwhispr-dev
OPENWHISPR_DISPLAY_NAME=OpenWhispr Dev
OPENWHISPR_KEYBOARD_DISPLAY_NAME=OpenWhispr Dev
```

`app.config.js` derives matching bundle identifiers for the keyboard and activity extensions and an App Group named `group.<bundle identifier>`. Override `OPENWHISPR_APP_GROUP_ID` or `OPENWHISPR_KEYBOARD_BUNDLE_IDENTIFIER` only when your Apple configuration requires different values.

Verify the resolved configuration and generate the native project:

```bash
OPENWHISPR_APP_ENV=development npx expo config --type public
npm run prebuild:dev -- --clean
```

In the generated Xcode workspace, select your Apple development team for the main app, `OpenWhisprKeyboard`, and `OpenWhisprActivity` targets. Your team must own the bundle identifiers and App Group. The generated `ios/` directory is ignored by Git, so these local signing changes should not be committed.

Maintainers shipping a separate fork must also replace the organization-specific Expo owner, Apple team, EAS project, update URL, and App Store submission values in `app.base.json` and `eas.json`. Those release settings are separate from the local identity overrides above.

## GitHub unsigned iOS builds

The fork displays iOS versions as `X.Y.Z.N`, currently `1.2.3.1`. Apple metadata retains `X.Y.Z` as Version and uses `N` as Build for the main app and both extensions. `config/fork-version.json` tracks the official mobile version and fork revision; daily upstream synchronization increments that revision when mobile files change and resets it to 1 when the official mobile version increases.

The **Build unsigned iOS app** Actions workflow builds a Release arm64 device archive without Apple signing credentials or an EAS account. It is manually triggered and uploads artifacts, without publishing a release. Its first native build still needs to be run and verified on GitHub.

1. Push the reviewed changes to your fork. Open **Actions → Build unsigned iOS app → Run workflow**.
2. Enter your own bundle identifier, for example `com.yourname.openwhispr`. Keep this identity for later signing and updates. The build derives `.keyboard`, `.activity`, `group.<bundle identifier>`, and a matching URL scheme from it; the upstream Apple team is omitted only in this unsigned build mode.
3. Download the `ios-unsigned-<run>-<attempt>` artifact after a successful run. It contains the unsigned IPA, compressed Xcode archive, target entitlements, build information, and SHA-256 checksums. A separate artifact contains native build logs.
4. Sign the main app **and both extensions** locally using matching bundle identifiers, App Group, certificate, and provisioning profiles, then install the signed IPA. The unsigned IPA cannot be installed directly.

On macOS, use your own Xcode signing setup. On Windows, a tool such as Sideloadly or AltStore Classic can handle sideloading, but this fork's keyboard, App Group, and Live Activity compatibility with third-party re-signing still requires device validation. Re-signing tools that rewrite only identifiers or entitlements can leave shared-container access broken. Inspect `entitlements.json` and keep the containing-app/extension identity relationship intact; do not remove extensions to make installation succeed.

### Local signing with a Mac and developer membership

Sign in to your developer account in Xcode and keep the signing certificate and its private key in the Mac's Keychain. Before the first device build, register the chosen main bundle identifier plus its `.keyboard` and `.activity` App IDs under the same team, and associate all three with `group.<main bundle identifier>`. Prepare a matching provisioning profile for each target, including the test iPhone when the selected distribution method requires registered devices. Check the exported `entitlements.json` for any additional target capabilities required by your profiles.

Download all build artifacts to the Mac and verify them before opening the archive:

```bash
shasum -a 256 -c SHA256SUMS
ditto -x -k OpenWhispr-unsigned.xcarchive.zip .
open OpenWhispr.xcarchive
```

In Xcode's Organizer, inspect the archive and use **Distribute App** with the appropriate device distribution method and your own signing team/profiles. Apple's [manual signing workflow](https://help.apple.com/xcode/mac/current/en.lproj/devcac6ab5b3.html) assigns a profile to each target. The first archive from this unsigned workflow still needs a real Mac export/signing test; an unsigned archive is not a guarantee that every Xcode version will accept it directly for export. If Xcode rejects the unsigned archive, keep the diagnostic and validate the local signing step rather than changing identifiers or removing extensions. After a signed IPA is available, install it on the registered device through Xcode's Devices and Simulators window and complete the device trust/Developer Mode steps.

After installation, follow the signing tool's device trust and Developer Mode instructions, open the main app to grant microphone access and configure a local model or personal provider, then add the keyboard in iOS Settings. Verify keyboard handoff, shared text, and a meeting/Live Activity on the device before treating the build as ready for use. Personal-account signing may require periodic renewal; this workflow does not change Apple's signing requirements.

The underlying command on macOS is:

```bash
OPENWHISPR_IOS_BUNDLE_IDENTIFIER=com.yourname.openwhispr \
  bash scripts/build-ios-unsigned.sh --output-dir build/ios-unsigned
```

Run it from the repository root after preparing the mobile npm dependencies, reviewed patches, and Bundler dependencies as in the workflow. It uses the existing open font fallback and retains the original configuration in source. It does not sign, submit, or publish an app.

## Pull Request Checklist

Before submitting:

- [ ] `npm run check` passes
- [ ] `npm test -- --runInBand` passes
- [ ] No secrets, API keys, or credentials committed
- [ ] PR description explains the why, not just the what
- [ ] Screenshots or screen recordings included for UI changes

## Tests

The mobile test suite uses Jest. Run it locally with `npm test -- --runInBand`; the mobile CI workflow runs the same suite for mobile changes.

## Reporting Bugs and Requesting Features

Use the GitHub issue templates. For security issues, follow [SECURITY.md](./SECURITY.md) instead of opening a public issue.

## Provider development

Mobile owns its provider code: the catalog is `src/config/providerCatalog.json`, routing is `src/lib/mobileProviders.ts`, and endpoint rules are `src/lib/providerEndpoints.ts`. The catalog is a trimmed copy of the desktop registry's OpenAI and Groq entries; update it by hand when those models change.

From `openwhispr-mobile`, run:

```bash
npm test -- --runInBand
npm run typecheck
npm run lint
npm run format
EXPO_NO_DOTENV=1 SENTRY_DISABLE_AUTO_UPLOAD=true OPENWHISPR_APP_ENV=production npx expo export --platform ios --output-dir /tmp/openwhispr-mobile-export
python3 modules/background-uploader/tests/run-provider-transport-tests.py
```

The native transport regression requires macOS, Python 3, and Xcode Command Line Tools. It compiles Foundation-only Swift and uses local HTTP servers with synthetic credentials to check redirect refusal (including same-origin redirects), response redaction, the 300 s idle and 10 min total time limits, background-expiry and untrusted-certificate errors, the native 25 MB audio cap, private-host rules, and secret-free recovery metadata. Mobile CI runs it on a macOS runner. It does not replace compiling the Expo module for iOS or testing background URLSession on a device.

Build a fresh native iOS app after changing any native module or config plugin. Do not use a JavaScript-only update to introduce the provider request transport.

Provider diagnostics are explicit user actions and may incur provider charges. Tests use mocks and synthetic credentials. Before a release, check all four providers (OpenAI, Groq, OpenRouter and a Custom server) with your own provider accounts on a physical device. Never paste keys, tokens, transcript content, or raw provider responses into test artifacts or logs.
