"""Publish package files from a verified tag build; never execute artifact contents."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True)


def api(path):
    return json.loads(gh("api", path))


def validate_run(run, repository, tag_commit):
    tag = run.get("head_branch", "")
    if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        raise ValueError("Only stable version tags can be published")
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
    for platform, endings in (("windows", (".exe",)), ("linux", (".AppImage", ".deb", ".rpm", ".tar.gz"))):
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


def release_info(repository, tag):
    try:
        return api(f"repos/{repository}/releases/tags/{tag}")
    except subprocess.CalledProcessError:
        # Creation will fail visibly for errors other than a missing Release.
        return None


def upload_packages(repository, tag, packages):
    release = release_info(repository, tag)
    if release is None:
        try:
            gh("release", "create", tag, "--repo", repository, "--verify-tag",
               "--title", "OpenWhispr " + tag[1:], "--generate-notes")
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
                raise ValueError("Existing asset has different contents: " + package.name)
            print("Already published: " + package.name, flush=True)
            continue
        print("Uploading: " + package.name, flush=True)
        gh("release", "upload", tag, str(package), "--repo", repository)


def main():
    repository = os.environ["RELEASE_REPOSITORY"]
    run_id = os.environ["BUILD_RUN_ID"]
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository) or not run_id.isdigit():
        raise ValueError("Invalid repository or build ID")
    run = api(f"repos/{repository}/actions/runs/{run_id}")
    candidate = run.get("head_branch", "")
    if not re.fullmatch(r"v\d+\.\d+\.\d+", candidate):
        raise ValueError("Build does not belong to a version tag")
    commit = api(f"repos/{repository}/commits/{candidate}")["sha"]
    tag = validate_run(run, repository, commit)
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        for platform, artifact in (("windows", "windows-unsigned-build"), ("linux", "linux-build")):
            print("Downloading " + artifact + " on the GitHub runner...", flush=True)
            gh("run", "download", run_id, "--repo", repository,
               "--name", artifact, "--dir", str(root / platform))
        packages = select_packages(root, tag[1:])
        checksums = root / "SHA256SUMS-windows-linux"
        checksums.write_text("".join(sha256(p) + "  " + p.name + "\n" for p in packages))
        if api(f"repos/{repository}/commits/{tag}")["sha"] != commit:
            raise ValueError("Remote tag changed during download")
        upload_packages(repository, tag, [*packages, checksums])


if __name__ == "__main__":
    main()
