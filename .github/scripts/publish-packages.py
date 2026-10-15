"""Publish package files from a verified tag build; never execute artifact contents."""

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


RELEASE_REPOSITORY = "ruivza/openwhispr"
VERSION_TAG_PATTERN = r"v\d+\.\d+\.\d+(?:-ruivza\.[1-9]\d*)?"


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True)


def api(path):
    return json.loads(gh("api", path))


def validate_run(run, repository, tag_commit):
    tag = run.get("head_branch", "")
    # if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
    #     raise ValueError("Only stable version tags can be published")
    if not re.fullmatch(VERSION_TAG_PATTERN, tag):
        raise ValueError("Only stable or ruivza revision tags can be published")
    if (run.get("status"), run.get("conclusion"), run.get("event")) != ("completed", "success", "push"):
        raise ValueError("A successful tag-push build is required")
    if run.get("name") != "Build tagged packages (unsigned)" or run.get("path") != ".github/workflows/release.yml":
        raise ValueError("Unexpected build workflow")
    for field in ("repository", "head_repository"):
        if run.get(field, {}).get("full_name") != repository:
            raise ValueError("Build must originate in this repository")
    if run.get("head_sha") != tag_commit:
        raise ValueError("Build commit does not match the remote tag")
    return tag


def select_packages(root, version):
    packages = []
    # Previously only installers were published, dropping NSIS differential maps.
    # for platform, endings in (("windows", (".exe",)), ("linux", (".AppImage", ".deb", ".rpm", ".tar.gz"))):
    for platform, endings in (("windows", (".exe", ".exe.blockmap")), ("linux", (".AppImage", ".deb", ".rpm", ".tar.gz"))):
        selected = [p for p in (root / platform).iterdir()
                    if p.is_file() and not p.is_symlink() and p.name.endswith(endings)]
        if not selected or any(version not in p.name for p in selected):
            raise ValueError("Missing or incorrectly versioned " + platform + " packages")
        packages.extend(selected)
    if len({p.name for p in packages}) != len(packages):
        raise ValueError("Duplicate release asset names")
    return sorted(packages, key=lambda p: p.name)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stage_packages(packages, destination):
    destination.mkdir()
    staged = []
    for package in packages:
        # GitHub converts spaces in uploaded asset names to dots. Normalize
        # before generating the checksum manifest and checking existing assets.
        target = destination / package.name.replace(" ", ".")
        if target.exists():
            raise ValueError("Duplicate normalized asset name: " + target.name)
        shutil.copyfile(package, target)
        staged.append(target)
    return staged


def update_manifests(packages, version, destination):
    """Build updater metadata from the final asset bytes and GitHub-safe names.

    JSON is a YAML subset understood by electron-updater's YAML loader. Using
    it keeps the isolated publishing job free of third-party parser installs.
    SHA256SUMS is for manual verification; the updater consumes these SHA512s.
    """
    manifests = []
    # for ending, channel in ((".exe", "latest.yml"), (".AppImage", "latest-linux.yml")):
    channel = "ruivza" if "-ruivza." in version else "latest"
    for ending, suffix in ((".exe", ""), (".AppImage", "-linux")):
        installers = [p for p in packages if p.name.endswith(ending)]
        if len(installers) != 1:
            raise ValueError("Exactly one current-architecture " + ending + " update is required")
        package = installers[0]
        digest = hashlib.sha512()
        with package.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        checksum = base64.b64encode(digest.digest()).decode("ascii")
        file_info = {"url": package.name, "sha512": checksum, "size": package.stat().st_size}
        # AppImages carry their differential map in the file followed by its
        # four-byte big-endian length. Keep that metadata when it is present.
        if ending == ".AppImage" and file_info["size"] > 4:
            with package.open("rb") as source:
                source.seek(-4, 2)
                blockmap_size = int.from_bytes(source.read(4), "big")
            if 0 < blockmap_size <= file_info["size"] - 4:
                file_info["blockMapSize"] = blockmap_size
        info = {"version": version,
                "files": [file_info],
                "path": package.name, "sha512": checksum}
        path = destination / f"{channel}{suffix}.yml"
        path.write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
        manifests.append(path)
    return manifests


def release_info(repository, tag):
    try:
        return api(f"repos/{repository}/releases/tags/{tag}")
    except subprocess.CalledProcessError:
        # Creation will fail visibly for errors other than a missing Release.
        return None


def upload_packages(repository, tag, packages):
    if repository != RELEASE_REPOSITORY:
        raise ValueError("This fork publishes updates only to " + RELEASE_REPOSITORY)
    release = release_info(repository, tag)
    if release is None:
        try:
            # gh("release", "create", tag, "--repo", repository, "--verify-tag",
            #    "--title", "OpenWhispr " + tag[1:], "--generate-notes")
            arguments = ["release", "create", tag, "--repo", repository, "--verify-tag",
                         "--title", "OpenWhispr " + tag[1:], "--generate-notes"]
            if "-ruivza." in tag:
                arguments.append("--prerelease")
            gh(*arguments)
        except subprocess.CalledProcessError:
            # The Mac publisher may have created this Release concurrently.
            if release_info(repository, tag) is None:
                raise
        release = release_info(repository, tag)
    assets = {asset["name"]: asset for asset in release["assets"]}
    for package in packages:
        existing = assets.get(package.name)
        if existing:
            expected = "sha256:" + sha256(package)
            digest = existing.get("digest")
            if digest is None:
                with tempfile.TemporaryDirectory() as temp:
                    gh("release", "download", tag, "--repo", repository,
                       "--pattern", package.name, "--dir", temp)
                    digest = "sha256:" + sha256(Path(temp) / package.name)
            if digest != expected:
                if package.name == "SHA256SUMS-windows-linux":
                    # This publisher owns this generated manifest. Installer
                    # contents have already been checked and are never replaced.
                    gh("release", "upload", tag, str(package), "--repo", repository, "--clobber")
                    continue
                raise ValueError("Existing asset has different contents: " + package.name)
            print("Already published: " + package.name, flush=True)
            continue
        print("Uploading: " + package.name, flush=True)
        gh("release", "upload", tag, str(package), "--repo", repository)


def main():
    repository = os.environ["RELEASE_REPOSITORY"]
    run_id = os.environ["BUILD_RUN_ID"]
    # The former generic OWNER/REPO validation allowed publishing upstream.
    # if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository) or not run_id.isdigit():
    if repository != RELEASE_REPOSITORY or not run_id.isdigit():
        raise ValueError("Invalid repository or build ID")
    run = api(f"repos/{repository}/actions/runs/{run_id}")
    candidate = run.get("head_branch", "")
    # if not re.fullmatch(r"v\d+\.\d+\.\d+", candidate):
    if not re.fullmatch(VERSION_TAG_PATTERN, candidate):
        raise ValueError("Build does not belong to a version tag")
    commit = api(f"repos/{repository}/commits/{candidate}")["sha"]
    tag = validate_run(run, repository, commit)
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        for platform, artifact in (("windows", "windows-unsigned-build"), ("linux", "linux-build")):
            print("Downloading " + artifact + " on the GitHub runner...", flush=True)
            gh("run", "download", run_id, "--repo", repository,
               "--name", artifact, "--dir", str(root / platform))
        packages = stage_packages(select_packages(root, tag[1:]), root / "packages")
        manifests = update_manifests(packages, tag[1:], root / "packages")
        checksums = root / "SHA256SUMS-windows-linux"
        checksums.write_text("".join(sha256(p) + "  " + p.name + "\n" for p in packages))
        if api(f"repos/{repository}/commits/{tag}")["sha"] != commit:
            raise ValueError("Remote tag changed during download")
        # Publish update metadata last: it must never refer to a missing payload.
        upload_packages(repository, tag, [*packages, checksums, *manifests])


if __name__ == "__main__":
    main()
