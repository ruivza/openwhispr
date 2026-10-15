#!/usr/bin/env python3
"""Validate and package an unsigned iPhoneOS archive for local signing."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import struct
import zipfile

REPO = Path(__file__).resolve().parents[2]


def own_bundle_id(value):
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+", value) or re.match(
        r"com\.gizmolabs\.openwhispr(?:\.|$)", value, re.I
    ):
        raise ValueError("An own bundle identifier is required")
    return value


def read_plist(file):
    with file.open("rb") as stream:
        return plistlib.load(stream)


def validate_app(app, bundle_id):
    info = read_plist(app / "Info.plist")
    if info.get("CFBundleIdentifier") != bundle_id:
        raise ValueError("Archive bundle identifier does not match the requested identity")
    if info.get("CFBundleSupportedPlatforms") != ["iPhoneOS"]:
        raise ValueError("Expected an iPhoneOS device archive")
    executable = info.get("CFBundleExecutable", "")
    if not executable or Path(executable).name != executable:
        raise ValueError("Invalid bundle executable")
    with (app / executable).open("rb") as stream:
        header = stream.read(8)
    # ARCHS=arm64 makes these thin Mach-O binaries, not simulator/fat builds.
    if len(header) != 8 or struct.unpack("<II", header) != (0xFEEDFACF, 0x0100000C):
        raise ValueError("Expected a thin arm64 Mach-O executable")
    if (app / "embedded.mobileprovision").exists() or (app / "_CodeSignature").exists():
        raise ValueError("Expected an unsigned bundle without a provisioning profile")
    return info


def entitlement_manifest(settings_file, bundle_ids, ios_root):
    settings = json.loads(settings_file.read_text(encoding="utf-8"))
    result = {}
    ios_root = ios_root.resolve()
    expected_group = "group." + bundle_ids[0]
    for target in settings:
        values = target.get("buildSettings", {})
        bundle_id = values.get("PRODUCT_BUNDLE_IDENTIFIER")
        if bundle_id not in bundle_ids:
            continue
        if bundle_id in result:
            raise ValueError("Duplicate application build settings")
        source_root = Path(values.get("SRCROOT", "")).resolve()
        if source_root != ios_root:
            raise ValueError("Entitlements must come from the generated iOS project")
        relative = values.get("CODE_SIGN_ENTITLEMENTS", "")
        source = (source_root / relative).resolve()
        if not relative or not source.is_relative_to(ios_root) or not source.is_file():
            raise ValueError("Missing or invalid generated target entitlements")
        entitlements = read_plist(source)
        if entitlements.get("com.apple.security.application-groups") != [expected_group]:
            raise ValueError("The app and both extensions must share their derived App Group")
        if values.get("DEVELOPMENT_TEAM") or values.get("CODE_SIGNING_ALLOWED") != "NO":
            raise ValueError("The archive build settings must disable signing and clear the team")
        result[bundle_id] = entitlements
    if set(result) != set(bundle_ids):
        raise ValueError("Missing build settings for the app or its extensions")
    return result


def zip_tree(source, destination, prefix):
    source = source.resolve()
    with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        for item in [source, *sorted(source.rglob("*"))]:
            name = (Path(prefix) / item.relative_to(source)).as_posix()
            if item.is_symlink():
                target = os.readlink(item)
                if not item.resolve().is_relative_to(source):
                    raise ValueError("Artifact symlinks must stay inside the archived bundle")
                entry = zipfile.ZipInfo(name)
                entry.create_system = 3
                entry.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(entry, target)
            else:
                archive.write(item, name)


def package_archive(archive, output, bundle_id, commit, settings_file, ios_root=None, xcode_version=""):
    bundle_id = own_bundle_id(bundle_id)
    archive = archive.resolve()
    output = output.resolve()
    if output.is_relative_to(archive):
        raise ValueError("Output must be outside the archive")
    apps = list((archive / "Products" / "Applications").glob("*.app"))
    if len(apps) != 1:
        raise ValueError("Expected exactly one top-level application")
    app = apps[0]
    info = validate_app(app, bundle_id)
    expected_ids = [bundle_id, bundle_id + ".keyboard", bundle_id + ".activity"]
    extensions = list((app / "PlugIns").glob("*.appex"))
    actual_ids = [read_plist(extension / "Info.plist").get("CFBundleIdentifier") for extension in extensions]
    if sorted(actual_ids) != sorted(expected_ids[1:]):
        raise ValueError("The archive must retain its keyboard and Live Activity extensions")
    for extension, extension_id in zip(extensions, actual_ids):
        validate_app(extension, extension_id)
    entitlements = entitlement_manifest(settings_file, expected_ids, ios_root or REPO / "openwhispr-mobile" / "ios")
    names = ["OpenWhispr-unsigned.ipa", "OpenWhispr-unsigned.xcarchive.zip", "entitlements.json", "build-info.json", "SHA256SUMS"]
    output.mkdir(parents=True, exist_ok=True)
    if any((output / name).exists() for name in names):
        raise ValueError("Refusing to replace existing build artifacts")
    zip_tree(app, output / names[0], "Payload/" + app.name)
    zip_tree(archive, output / names[1], archive.name)
    (output / names[2]).write_text(json.dumps(entitlements, indent=2) + "\n", encoding="utf-8")
    metadata = {
        "unsigned": True, "platform": "iphoneos", "architecture": "arm64",
        "bundleIdentifier": bundle_id, "appGroup": "group." + bundle_id,
        "extensionBundleIdentifiers": expected_ids[1:], "commit": commit,
        "version": info.get("CFBundleShortVersionString"), "buildNumber": info.get("CFBundleVersion"),
        "xcodeVersion": xcode_version,
        "installation": "Requires local signing of the app and both extensions; the IPA is not directly installable.",
    }
    (output / names[3]).write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    hashes = []
    for name in names[:-1]:
        digest = hashlib.sha256()
        with (output / name).open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        hashes.append(f"{digest.hexdigest()}  {name}\n")
    (output / names[-1]).write_text("".join(hashes), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    package = commands.add_parser("package")
    for name in ["archive", "output-dir", "bundle-id", "commit", "build-settings"]:
        package.add_argument("--" + name, required=True)
    package.add_argument("--xcode-version", default="")
    args = parser.parse_args()
    package_archive(Path(args.archive), Path(args.output_dir), args.bundle_id, args.commit, Path(args.build_settings), xcode_version=args.xcode_version)
