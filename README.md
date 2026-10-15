<p align="center">
  <img src="src/assets/logo.svg" alt="OpenWhispr" width="120" />
</p>

<h1 align="center">OpenWhispr</h1>

<p align="center">
  <a href="https://github.com/OpenWhispr/openwhispr/blob/main/LICENSE"><img src="https://img.shields.io/github/license/OpenWhispr/openwhispr?style=flat" alt="License" /></a>
  <!-- <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat" alt="Platform" /> -->
  <img src="https://img.shields.io/badge/platform-macOS%20arm64%20%7C%20Windows%20x64-lightgrey?style=flat" alt="Platform" />
  <a href="https://github.com/OpenWhispr/openwhispr/releases/latest"><img src="https://img.shields.io/github/v/release/OpenWhispr/openwhispr?style=flat&sort=semver" alt="GitHub release" /></a>
  <a href="https://github.com/OpenWhispr/openwhispr/releases"><img src="https://img.shields.io/github/downloads/OpenWhispr/openwhispr/total?style=flat&color=blue" alt="Downloads" /></a>
  <a href="https://github.com/OpenWhispr/openwhispr/stargazers"><img src="https://img.shields.io/github/stars/OpenWhispr/openwhispr?style=flat" alt="GitHub stars" /></a>
</p>

<p align="center">
  The open-source and free alternative to WisprFlow and Granola.<br/>
  <!-- Privacy-first voice-to-text dictation with AI agents, meeting transcription, and notes. Cross-platform for macOS, Windows, and Linux. -->
  Privacy-first voice-to-text dictation with AI agents, meeting transcription, and notes. This fork supports Windows x64 and macOS on Apple Silicon.
</p>

<p align="center">
  <a href="https://openwhispr.com">Website</a> &middot;
  <a href="https://docs.openwhispr.com">Docs</a> &middot;
  <a href="https://github.com/OpenWhispr/openwhispr/releases/latest">Download</a> &middot;
  <a href="https://docs.openwhispr.com/api/overview">API</a> &middot;
  <a href="https://github.com/OpenWhispr/openwhispr/blob/main/CHANGELOG.md">Changelog</a>
</p>

---

OpenWhispr turns your voice into text, notes, and actions from your desktop. Press a hotkey, speak, and your words appear at your cursor. Choose between fully private offline transcription with local speech-to-text models like Orukeet, Whisper, NVIDIA Parakeet, and Cohere Transcribe — where your audio never leaves your device — or cloud processing for speed. No data collection, no telemetry, fully open source.

## Download

| Platform              | Download                                                                                                                                                                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS (Apple Silicon) | [`.dmg`](https://github.com/OpenWhispr/openwhispr/releases/latest)                                                                                                                                                                                                                        |
| Windows               | [`.exe`](https://github.com/OpenWhispr/openwhispr/releases/latest)                                                                                                                                                                                                                        |

<!-- Unsupported upstream download rows retained for reference:
| macOS (Intel) \*      | [`.dmg`](https://github.com/OpenWhispr/openwhispr/releases/latest) |
| Linux                 | [`.AppImage`](https://github.com/OpenWhispr/openwhispr/releases/latest) / [`.deb`](https://github.com/OpenWhispr/openwhispr/releases/latest) / [`.rpm`](https://github.com/OpenWhispr/openwhispr/releases/latest) / [`.tar.gz`](https://github.com/OpenWhispr/openwhispr/releases/latest) |

\* On Intel Macs, live speaker identification and voice fingerprinting are unavailable: they depend on ONNX Runtime, which [stopped shipping macOS x86_64 binaries in 1.24](https://github.com/microsoft/onnxruntime/releases/tag/v1.24.1). Meetings still record and transcribe normally, and notes search falls back to keyword matching instead of semantic search.

On macOS or x86_64 Linux, you can also install the community-maintained [Homebrew cask](https://formulae.brew.sh/cask/openwhispr):

```bash
brew install --cask openwhispr
```
-->

Linux and Intel Mac builds are discontinued in this fork. Existing source files and old release assets remain available. iOS uses the separate manual unsigned-build workflow described in the mobile documentation.

## Features

- **Voice dictation** — global hotkey to dictate into any app with automatic pasting
- **Dictation translation** — dedicated hotkey to dictate in one language and paste the text in another
- **AI agent** — talk to GPT-5, Claude, Gemini, Groq, Tinfoil, OpenRouter, or local models with a named voice assistant
- **Voice Assistant hotkey** — dedicated hotkey that sends what you say straight to your AI assistant as a command, no wake word needed and no cleanup pass; highlighted text is edited in place. With auto-paste enabled, answers paste at a focused text cursor or stream into a floating panel and copy to the clipboard when no writable cursor is available. You can also opt in to sending a screenshot of your current screen as context
- **Meeting transcription** — auto-detect Zoom, Teams, and FaceTime calls with live speaker diarization, voice fingerprinting, and Google, Microsoft, or Apple Calendar integration
- **Local speaker diarization** — on-device speaker labelling with voice fingerprint recognition across meetings, no cloud required
- **Notes** — create, organize, and search notes with folders, semantic search, cloud sync, and AI actions
- **Team spaces & sharing** — free for signed-in users; share notes on the web with link, domain, or invite-only visibility, and collaborate in team spaces with roles, invitations, and server-enforced membership
- **Audio import** — transcribe existing audio and video: drag in files, batch-upload, or paste a YouTube/audio URL, with optional speaker detection
- **Local or cloud — your choice** — all core features (transcription, AI reasoning, speaker diarization, semantic search) work with local models or cloud providers — including GPU-accelerated local Whisper on Metal, CUDA, and Vulkan (AMD/Intel)
- **Enterprise controls** — enforce organization policy, company SSO and SCIM, and centrally managed Amazon Bedrock or Azure OpenAI access without distributing cloud keys
- **Public API & MCP** — manage notes and transcriptions programmatically or connect your AI assistant via the [MCP server](https://docs.openwhispr.com/integrations/mcp)

## Quick start

```bash
git clone https://github.com/OpenWhispr/openwhispr.git
cd openwhispr
npm install
npm run dev
```

Requires Node.js 24+. See the [full documentation](https://docs.openwhispr.com/quickstart) for setup guides, platform-specific instructions, and build details.

The commands above run the desktop application, which remains at the repository root. The Expo mobile application lives in [`openwhispr-mobile`](openwhispr-mobile/) with its own dependencies, lockfile, build configuration, and release process. See the [mobile README](openwhispr-mobile/README.md) for its setup instructions.

Desktop audio imports using your own API key automatically split files above the provider's single-request limit (25 MiB, or 14 MiB for Gemini) on your device, transcribe chunks in parallel with the selected provider, and merge the results in order. Custom and self-hosted imports also split above 25 MiB. This does not require an OpenWhispr subscription; your provider's billing and quotas still apply. The shared pipeline uses four-minute MP3 chunks, up to five concurrent chunk requests, retries, cancellation, and explicit warnings for missing audio. Provider timestamps are offset to the original recording; speaker identities inferred independently in different chunks remain separate. OpenWhispr Cloud retains its existing plan limits, and mobile import limits are unchanged.

## GitHub builds and local macOS signing

### Daily upstream synchronization

**Sync upstream main** checks `OpenWhispr/openwhispr:main` daily at 20:17 UTC (Sydney 06:17 in winter / 07:17 in summer), with a manual Actions entry as well. It merges in an isolated checkout, preserves fork commits, and checks the local/BYOK, telemetry, version and supported-platform rules before updating `main`. A concurrent user push is kept; synchronization retries from the new head on its next run. The task installs test dependencies with lifecycle scripts disabled and runs targeted checks, without building application packages.

Desktop versions follow `X.Y.Z-ruivza.N`: new upstream commits increment the fork revision, and an official version increase starts at revision 1. The iOS display version follows its separate `X.Y.Z.N` line; Apple metadata uses the official three-part Version plus the fork revision as Build. iOS revisions change only when mobile files change.

Conflicts, failed checks or rejected pushes leave `main` unchanged and open/update one Issue assigned to `ruivza`. Repeated failures for the same upstream commit reuse the existing notice; a later successful synchronization closes it. GitHub delivers notifications according to your account settings. Synchronization commits include `[skip ci]`; the task never creates tags, publishes Releases or starts app-build workflows.

The built-in repository token handles ordinary updates. If GitHub rejects an upstream workflow-file change, add an optional **Actions secret** named `UPSTREAM_SYNC_TOKEN`, limited to this fork with Contents and Workflows write permissions. Keep that value in GitHub Secrets; it is never part of source code. The Issue explains any permission failure instead of replacing or force-pushing the branch.

### Desktop build artifacts

This fork's desktop workflows build Windows x64 and macOS arm64 without publisher certificates. Pushes to `main`/`develop`, pull requests, and manual runs keep the existing quality checks. Version tags and the tagged-build workflow use the same unsigned build pipeline. After a successful tag-push build, **Publish Windows packages** publishes the Windows installer to the version Release. Signed Mac DMGs are added locally after notarization. Linux and Intel Mac build jobs are disabled; Ubuntu runners remain in use for quality checks.

Download the artifacts from the completed GitHub Actions run (retained for 7 days):

- `windows-unsigned-build`: the unsigned NSIS installer and unpacked application. Windows does not require code signing to build or install this package; it may show an unknown-publisher or SmartScreen prompt.
- `macos-arm64-unsigned-build`: unsigned DMG/ZIP packages and an `*-unsigned-app.tar.gz` archive for the local release script. The archive preserves executable permissions and framework symlinks and includes the build's version, commit, and architecture.
<!-- Previous unsupported artifacts:
- `macos-x64-unsigned-build`: Intel Mac packages.
- `linux-build`: Linux packages.
-->

GitHub needs no Azure signing credentials, Apple certificate, or notarization key. The CI-specific builder configs disable signing without changing the base config used by existing local signing setups. For manual unsigned builds, use `npm run build:win -- --publish never --config electron-builder.unsigned-win.json` or `npm run build:mac -- --publish never --config electron-builder.unsigned-mac.json`.

### Sign and release from your Mac

This follows the same `release-local.sh --run ... --publish` workflow as SpeechDock. Install GitHub CLI (`gh`), Python 3.9+, Xcode command-line tools, and your Developer ID Application certificate with its private key. Log in with `gh auth login`. Use an existing notarytool Keychain profile, or create one with `xcrun notarytool store-credentials openwhispr-release`. A profile such as `speechdock-release` can be reused for the same Apple account/team; its name is not tied to an application.

The fork follows the upstream version and appends its own revision: `1.10.3-ruivza.1`, `1.10.3-ruivza.2`, then `1.10.4-ruivza.1` after merging upstream `1.10.4`. The Windows app executable's file/product versions use the numeric form `1.10.3.1`. Keep the two Windows metadata values in `electron-builder.json` in sync with each revision. The fresh fork release baseline is `1.10.3-ruivza.1`; old Releases and tags have been cleared separately. Automatic downgrades stay disabled, so a previously installed higher version still needs a manual install.

1. Set `package.json`, the lockfile, and the Windows metadata to the intended release version, then commit and push the changes. Synchronization commits contain `[skip ci]`, which also skips tag-push builds. From a clean checkout, create an empty release commit without that marker and push only its matching **new** tag; `main` stays unchanged. Existing tags/assets are never replaced.

   ```bash
   git fetch origin --tags
   git switch --detach origin/main
   RELEASE_VERSION=$(node -p "require('./package.json').version")
   git commit --allow-empty -m "release: $RELEASE_VERSION"
   git tag "v$RELEASE_VERSION"
   git push origin "v$RELEASE_VERSION"
   ```

2. Wait for **Build tagged packages (unsigned)** to finish successfully and copy its Actions run ID.
3. On your Mac, fetch and check out that exact tag, then run:

```bash
git fetch origin tag vX.Y.Z-ruivza.N
git switch --detach vX.Y.Z-ruivza.N
NOTARY_PROFILE=speechdock-release bash scripts/release-local.sh --run RUN_ID --publish
```

Use the run ID from **this OpenWhispr repository**, not an old SpeechDock run. The script verifies the remote tag, local commit, successful workflow, and artifact metadata. It signs Electron helpers, frameworks, native modules, and the app from the inside out using `resources/mac/entitlements.mac.plist`; then it notarizes and staples the app, creates and signs a DMG, notarizes/staples the DMG, and checks Gatekeeper. Only `arm64` is processed. No app compilation runs locally. The release launcher (`scripts/release-local.sh`) may be updated from a reviewed later commit to fix download or publishing behavior without rebuilding the app. The checkout, signing helper, entitlements, and other build inputs must still match the release tag.

An existing successful manual **Build unsigned packages** run from this fork's `main` may also be reused when its version matches and the release tag differs only in the documented README/CONTRIBUTING paths or Markdown under `docs/`. The launcher verifies the real workflow provenance and Git history, and validates `release.json` against the original build commit, without rewriting it. Runtime, dependency, signing-helper or workflow differences are rejected.

For `v1.10.3-ruivza.2`, reuse build `38694847321` without rebuilding. Fetch the reviewed launcher from `main`, but keep the signing helper and all other files at the tag:

```bash
git fetch origin main tag v1.10.3-ruivza.2
git switch --detach v1.10.3-ruivza.2
git restore --source=origin/main -- scripts/release-local.sh
NOTARY_PROFILE=speechdock-release bash scripts/release-local.sh --run 38694847321 --publish
```

Omit `--publish` to keep the signed packages local. The downloaded archive still identifies its original build commit; the launcher requires that commit to be an ancestor of the release tag. A shallow clone may need `git fetch --unshallow origin` before validation can succeed.

To reuse the same build for Windows, run **Publish Windows packages** manually with `run_id` set to `38694847321`. The publisher checks the successful manual main run, the version's existing tag and its documentation-only source difference before publishing the original installer and freshly generated update metadata. This publishes existing artifacts; it does not start another application build.

Without `--publish`, signed DMGs stay in a new directory under `build/local-release.*/output`. The default and `--arch arm64` both process Apple Silicon; legacy `--arch all` is an arm64 alias, and `--arch x64` is rejected. Publishing adds the signed arm64 Mac packages and `SHA256SUMS-macos` to the version Release. GitHub automatically publishes the Windows installer and `SHA256SUMS-windows` after a successful tagged build; the Mac downloads only its arm64 artifact. Either publisher can create the Release first, and neither overwrites existing assets. To publish Windows packages from an older successful tag build, run the **Publish Windows packages** workflow with its run ID. Fork revision releases use the `ruivza` update channel; the publishers generate its manifests from the final installer/ZIP bytes and upload metadata after the payloads. Fork revision tags are marked as GitHub prereleases.

If several Developer ID certificates are installed, set `SIGNING_IDENTITY` to the exact certificate name or SHA-1 shown by `security find-identity -v -p codesigning`. `NOTARY_KEYCHAIN` optionally selects the Keychain containing the notary profile. Certificate private keys and notary credentials remain on the Mac.

## Documentation

Visit **[docs.openwhispr.com](https://docs.openwhispr.com)** for:

- [Getting started](https://docs.openwhispr.com/quickstart)
- [Platform guides](https://docs.openwhispr.com/platform/macos) (macOS, Windows, Linux)
- [API reference](https://docs.openwhispr.com/api/overview)
- [MCP server setup](https://docs.openwhispr.com/integrations/mcp)
- [Troubleshooting](https://docs.openwhispr.com/troubleshooting)

Repo examples:

- [Custom ASR shim](examples/custom-asr-shim/) for Self-Hosted transcription against non-OpenAI-compatible ASR APIs

## Tech stack

React 19, TypeScript, Tailwind CSS v4, Electron 41, better-sqlite3, whisper.cpp, sherpa-onnx, shadcn/ui

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=OpenWhispr/openwhispr&type=date&legend=top-left)](https://www.star-history.com/#OpenWhispr/openwhispr&type=date&legend=top-left)

## Sponsors

<p align="center">
  <a href="https://console.neon.tech/app/?promo=openwhispr">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://neon.com/brand/neon-logo-dark-color.svg">
      <source media="(prefers-color-scheme: light)" srcset="https://neon.com/brand/neon-logo-light-color.svg">
      <img width="250" alt="Neon" src="https://neon.com/brand/neon-logo-light-color.svg">
    </picture>
  </a>
</p>

<p align="center"><a href="https://console.neon.tech/app/?promo=openwhispr">Neon</a> is the serverless Postgres platform powering OpenWhispr Cloud.</p>

## Contributing

We welcome contributions. Fork the repo, create a feature branch, and open a pull request. See the [contributing guide](https://docs.openwhispr.com/contributing) for development setup and guidelines.

## License

[MIT](LICENSE) — free for personal and commercial use.

## Acknowledgments

- **[OpenAI Whisper](https://github.com/openai/whisper)** — speech recognition model powering local and cloud transcription
- **[whisper.cpp](https://github.com/ggerganov/whisper.cpp)** — high-performance C++ implementation for local processing
- **[NVIDIA Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)** — fast multilingual ASR model
- **[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)** — cross-platform ONNX runtime for Parakeet inference
- **[Hugging Face](https://huggingface.co/)** — model hub hosting Whisper, Parakeet, and embedding model weights
- **[llama.cpp](https://github.com/ggerganov/llama.cpp)** — local LLM inference for AI text processing
- **[Electron](https://www.electronjs.org/)** — cross-platform desktop framework
- **[React](https://react.dev/)** — UI component library
- **[shadcn/ui](https://ui.shadcn.com/)** — accessible components built on Radix primitives
- **[Neon](https://console.neon.tech/app/?promo=openwhispr)** — serverless Postgres powering OpenWhispr Cloud
