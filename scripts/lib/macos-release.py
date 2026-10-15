#!/usr/bin/env python3
"""Validate CI archives and sign an Electron app inside out on the release Mac."""

import argparse
import base64
import hashlib
import json
import plistlib
import shlex
import shutil
import subprocess
import tarfile
from pathlib import Path, PurePosixPath


MACH_O = {bytes.fromhex(value) for value in (
    "feedface", "cefaedfe", "feedfacf", "cffaedfe",
    "cafebabe", "bebafeca", "cafebabf", "bfbafeca",
)}
APP_NAME = "OpenWhispr.app"
PROJECT = Path(__file__).resolve().parents[2]


def validate_run(run, commit, tag):
    if run.get("headSha") != commit or run.get("status") != "completed" or run.get("conclusion") != "success":
        raise ValueError("Actions run must have succeeded for the exact local commit")
    if run.get("workflowName") != "Build tagged packages (unsigned)":
        raise ValueError("Use a run of Build tagged packages (unsigned)")
    if run.get("event") not in ("push", "workflow_dispatch"):
        raise ValueError("Only tag pushes and manual tagged builds can be released")
    if run["event"] == "push" and run.get("headBranch") != tag:
        raise ValueError("Actions run must belong to the selected version tag")


def validate_archive(archive, version, commit, arch):
    if arch != "arm64":
        raise ValueError("Only Apple Silicon arm64 releases are supported")
    members = archive.getmembers()
    entries = {}
    links = {}
    for member in members:
        path = PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts or "\\" in member.name or not path.parts:
            raise ValueError("Unsafe archive path")
        name = str(path)
        if path.parts[0] not in (APP_NAME, "release.json") or name in entries:
            raise ValueError("Unexpected or duplicate archive entry")
        if not (member.isfile() or member.isdir() or member.issym()):
            raise ValueError("Archive contains a hard link or special file")
        if path.parts[0] == "release.json" and (name != "release.json" or not member.isfile()):
            raise ValueError("Invalid release metadata entry")
        entries[name] = member
        if member.issym():
            if not member.linkname or PurePosixPath(member.linkname).is_absolute() or "\\" in member.linkname:
                raise ValueError("Unsafe symlink target")
            links[name] = member.linkname
    if APP_NAME not in entries or not entries[APP_NAME].isdir():
        raise ValueError("Missing application directory")
    for name in entries:
        if name == "release.json":
            continue
        # Never extract a file through a symlink, regardless of member order.
        if any(str(parent) in links for parent in PurePosixPath(name).parents):
            raise ValueError("Archive entry is nested beneath a symlink")
        pending, resolved, followed = list(PurePosixPath(name).parts), [], set()
        while pending:
            part = pending.pop(0)
            if part == ".":
                continue
            if part == "..":
                if len(resolved) <= 1:
                    raise ValueError("Archive symlink leaves app bundle")
                resolved.pop()
                continue
            resolved.append(part)
            current = "/".join(resolved)
            if current in links:
                if current in followed:
                    raise ValueError("Archive contains a symlink cycle")
                followed.add(current)
                resolved.pop()
                pending = list(PurePosixPath(links[current]).parts) + pending
        if not resolved or resolved[0] != APP_NAME:
            raise ValueError("Archive path leaves app bundle")
    if "release.json" not in entries:
        raise ValueError("Missing release metadata")
    if entries["release.json"].size > 65536:
        raise ValueError("Release metadata is too large")
    with archive.extractfile(entries["release.json"]) as source:
        metadata = json.load(source)
    if any(metadata.get(key) != value for key, value in {
        "version": version, "commit": commit, "arch": arch,
    }.items()):
        raise ValueError("Artifact version, commit, or architecture does not match the release")
    return members


def extract_archive(source, destination, version, commit, arch):
    if destination.exists():
        raise ValueError("Extraction destination must not already exist")
    with tarfile.open(source, "r:gz") as archive:
        members = validate_archive(archive, version, commit, arch)
        destination.mkdir(parents=True)
        # Restore regular files before creating any symlinks. Do not restore
        # ownership, setuid bits, or metadata from the build machine.
        for member in members:
            target = destination / member.name
            if member.issym():
                continue
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as src, target.open("xb") as dst:
                    shutil.copyfileobj(src, dst)
                target.chmod(member.mode & 0o777)
        for member in members:
            if member.issym():
                target = destination / member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(member.linkname)


def bundle_info(bundle):
    for name in ("Contents/Info.plist", "Resources/Info.plist", "Info.plist"):
        path = bundle / name
        if path.is_file():
            return plistlib.loads(path.read_bytes())
    raise ValueError(f"Missing Info.plist: {bundle}")


def signing_plan(app, version):
    info = bundle_info(app)
    if info.get("CFBundleIdentifier") != "com.gizmolabs.openwhispr" or info.get("CFBundleShortVersionString") != version:
        raise ValueError("Application identifier or version does not match the release")
    bundles, executables, loose_code = {app}, set(), set()
    files = list(app.rglob("*"))
    for path in files:
        if not path.resolve().is_relative_to(app):
            raise ValueError(f"Path leaves application: {path}")
        if path.is_symlink():
            continue
        if path.is_dir() and path.suffix in (".app", ".appex", ".xpc", ".framework", ".bundle"):
            try:
                nested = bundle_info(path)
            except ValueError:
                if path.suffix == ".bundle":
                    continue
                raise
            if nested.get("CFBundleExecutable"):
                bundles.add(path)
    for bundle in bundles:
        name = bundle_info(bundle).get("CFBundleExecutable", "")
        if not name or Path(name).name != name:
            raise ValueError(f"Invalid bundle executable: {bundle}")
        executable = bundle / ("Contents/MacOS" if (bundle / "Contents").is_dir() else "") / name
        if not executable.is_file() or not executable.resolve().is_relative_to(app):
            raise ValueError(f"Missing bundle executable: {executable}")
        executables.add(executable.resolve())
    for path in files:
        if path.is_file() and not path.is_symlink() and path.resolve() not in executables:
            with path.open("rb") as source:
                if source.read(4) in MACH_O:
                    loose_code.add(path)
    return sorted(bundles | loose_code, key=lambda path: (-len(path.parts), str(path)))


def sign_app(app, version, identity, dry_run=False):
    app = app.resolve()
    entitlements = PROJECT / "resources/mac/entitlements.mac.plist"
    if plistlib.loads(entitlements.read_bytes()).get("com.apple.security.get-task-allow"):
        raise ValueError("Release entitlements must not enable get-task-allow")
    for path in signing_plan(app, version):
        command = ["codesign", "--force", "--sign", identity, "--timestamp", "--options", "runtime",
                   "--entitlements", str(entitlements), "--generate-entitlement-der", str(path)]
        print(shlex.join(command), flush=True)
        if not dry_run:
            subprocess.run(command, check=True)
    if not dry_run:
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)


def write_update_manifest(archive, version, arch):
    """Describe the final signed/stapled ZIP, never a CI unsigned archive."""
    if arch != "arm64":
        raise ValueError("Only Apple Silicon arm64 releases are supported")
    expected_name = f"OpenWhispr-{version}-mac-{arch}.zip"
    if archive.name != expected_name or not archive.is_file() or archive.is_symlink():
        raise ValueError("Expected a final versioned macOS update ZIP: " + expected_name)
    digest = hashlib.sha512()
    with archive.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    checksum = base64.b64encode(digest.digest()).decode("ascii")
    info = {"version": version,
            "files": [{"url": archive.name, "sha512": checksum, "size": archive.stat().st_size}],
            "path": archive.name, "sha512": checksum}
    # JSON is valid YAML; this requires no extra runtime on the signing Mac.
    # manifest = archive.with_name(f"latest-{arch}-mac.yml")
    channel = "ruivza" if "-ruivza." in version else "latest"
    manifest = archive.with_name(f"{channel}-{arch}-mac.yml")
    manifest.write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("validate-run")
    run.add_argument("file", type=Path)
    run.add_argument("commit")
    run.add_argument("tag")
    extract = commands.add_parser("extract")
    extract.add_argument("archive", type=Path)
    extract.add_argument("destination", type=Path)
    extract.add_argument("version")
    extract.add_argument("commit")
    # extract.add_argument("arch", choices=("arm64", "x64"))
    extract.add_argument("arch", choices=("arm64",))
    sign = commands.add_parser("sign")
    sign.add_argument("app", type=Path)
    sign.add_argument("--version", required=True)
    sign.add_argument("--identity", required=True)
    sign.add_argument("--dry-run", action="store_true")
    manifest = commands.add_parser("manifest")
    manifest.add_argument("archive", type=Path)
    manifest.add_argument("version")
    # manifest.add_argument("arch", choices=("arm64", "x64"))
    manifest.add_argument("arch", choices=("arm64",))
    args = parser.parse_args()
    if args.command == "validate-run":
        validate_run(json.loads(args.file.read_text()), args.commit, args.tag)
    elif args.command == "extract":
        extract_archive(args.archive, args.destination, args.version, args.commit, args.arch)
    elif args.command == "manifest":
        write_update_manifest(args.archive, args.version, args.arch)
    else:
        sign_app(args.app, args.version, args.identity, args.dry_run)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, RuntimeError, tarfile.TarError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))
