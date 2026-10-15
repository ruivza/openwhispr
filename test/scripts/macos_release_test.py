"""Release input validation and Electron signing order, without signing credentials."""

import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import plistlib
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


PROJECT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("macos_release", PROJECT / "scripts/lib/macos-release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)
COMMIT = "a" * 40
VERSION = "1.10.3"


def archive_bytes(extra=(), metadata=None):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        app = tarfile.TarInfo("OpenWhispr.app")
        app.type = tarfile.DIRTYPE
        archive.addfile(app)
        executable = tarfile.TarInfo("OpenWhispr.app/Contents/MacOS/OpenWhispr")
        executable.mode = 0o755
        executable.size = 4
        archive.addfile(executable, io.BytesIO(bytes.fromhex("cffaedfe")))
        payload = json.dumps(metadata or {"version": VERSION, "commit": COMMIT, "arch": "arm64"}).encode()
        info = tarfile.TarInfo("release.json")
        info.size = len(payload)
        archive.addfile(info, io.BytesIO(payload))
        for info, content in extra:
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
    return buffer.getvalue()


def symlink(name, target):
    info = tarfile.TarInfo(name)
    info.type = tarfile.SYMTYPE
    info.linkname = target
    return info, b""


class ArchiveTests(unittest.TestCase):
    def validate(self, extra=(), metadata=None):
        with tarfile.open(fileobj=io.BytesIO(archive_bytes(extra, metadata)), mode="r:gz") as archive:
            return release.validate_archive(archive, VERSION, COMMIT, "arm64")

    def test_preserves_regular_payload_and_executable_mode(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "app.tar.gz"
            source.write_bytes(archive_bytes())
            destination = Path(temp) / "extracted"
            release.extract_archive(source, destination, VERSION, COMMIT, "arm64")
            self.assertEqual((destination / "OpenWhispr.app/Contents/MacOS/OpenWhispr").read_bytes(), bytes.fromhex("cffaedfe"))
            with self.assertRaisesRegex(ValueError, "already exist"):
                release.extract_archive(source, destination, VERSION, COMMIT, "arm64")

    def test_accepts_framework_symlink_chain(self):
        self.validate([
            symlink("OpenWhispr.app/Contents/Frameworks/Electron.framework/Versions/Current", "A"),
            symlink("OpenWhispr.app/Contents/Frameworks/Electron.framework/Electron", "Versions/Current/Electron"),
        ])

    def test_rejects_wrong_provenance(self):
        for key, value in (("version", "9.9.9"), ("commit", "b" * 40), ("arch", "x64")):
            metadata = {"version": VERSION, "commit": COMMIT, "arch": "arm64", key: value}
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "does not match"):
                self.validate(metadata=metadata)

    def test_rejects_x64_even_when_archive_metadata_matches(self):
        metadata = {"version": VERSION, "commit": COMMIT, "arch": "x64"}
        with tarfile.open(fileobj=io.BytesIO(archive_bytes(metadata=metadata)), mode="r:gz") as archive:
            with self.assertRaisesRegex(ValueError, "Only Apple Silicon arm64"):
                release.validate_archive(archive, VERSION, COMMIT, "x64")

    def test_rejects_traversal_absolute_and_duplicate_entries(self):
        for name in ("../outside", "/outside", "OpenWhispr.app/../outside", "OpenWhispr.app\\outside", "release.json"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.validate([(tarfile.TarInfo(name), b"payload")])

    def test_rejects_symlink_escape_and_cycle(self):
        cases = [
            [symlink("OpenWhispr.app/link", "../../outside")],
            [symlink("OpenWhispr.app/link", "/outside")],
            [symlink("OpenWhispr.app/a", "b"), symlink("OpenWhispr.app/b", "a")],
            [symlink("OpenWhispr.app/a", "dir"), symlink("OpenWhispr.app/b", "a/../../outside")],
        ]
        for extra in cases:
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.validate(extra)

    def test_rejects_extracting_through_symlink(self):
        extra = [symlink("OpenWhispr.app/link", "Contents"), (tarfile.TarInfo("OpenWhispr.app/link/file"), b"x")]
        with self.assertRaisesRegex(ValueError, "beneath a symlink"):
            self.validate(extra)

    def test_rejects_special_files_and_hardlinks(self):
        for kind in (tarfile.FIFOTYPE, tarfile.CHRTYPE, tarfile.LNKTYPE):
            member = tarfile.TarInfo("OpenWhispr.app/special")
            member.type = kind
            member.linkname = "OpenWhispr.app/Contents/MacOS/OpenWhispr"
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, "special file"):
                self.validate([(member, b"")])


class RunTests(unittest.TestCase):
    def test_requires_successful_exact_tagged_build(self):
        valid = {"headSha": COMMIT, "headBranch": "v" + VERSION, "status": "completed", "conclusion": "success",
                 "event": "push", "workflowName": "Build tagged packages (unsigned)"}
        release.validate_run(valid, COMMIT, "v" + VERSION)
        release.validate_run({**valid, "event": "workflow_dispatch", "headBranch": "main"}, COMMIT, "v" + VERSION)
        for key, value in (("headSha", "b" * 40), ("headBranch", "main"), ("status", "in_progress"),
                           ("conclusion", "failure"), ("event", "pull_request"), ("workflowName", "Other")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                release.validate_run({**valid, key: value}, COMMIT, "v" + VERSION)


class LauncherProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name).resolve()
        self.git("init", "--quiet")
        self.git("config", "user.name", "Release fixture")
        self.git("config", "user.email", "fixture@example.test")
        hooks = self.repo / "empty-hooks"
        hooks.mkdir()
        self.git("config", "core.hooksPath", str(hooks))
        (self.repo / "package.json").write_text(json.dumps({"version": VERSION}))
        (self.repo / "source.js").write_text("original application code\n")
        (self.repo / "openwhispr-mobile").mkdir()
        self.documentation = self.repo / "openwhispr-mobile/CONTRIBUTING.md"
        self.documentation.write_text("original documentation\n")
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", "original successful main build")
        self.build_commit = self.git("rev-parse", "HEAD").strip()
        self.documentation.write_text("updated documentation\n")
        self.git("commit", "--quiet", "-am", "documentation before release")
        self.release_commit = self.git("rev-parse", "HEAD").strip()
        self.metadata = {
            "repository": {"full_name": "ruivza/openwhispr"},
            "head_repository": {"full_name": "ruivza/openwhispr"},
            "status": "completed", "conclusion": "success",
            "head_sha": self.build_commit, "head_branch": "main",
            "event": "workflow_dispatch", "name": "Build unsigned packages",
            "path": ".github/workflows/build-and-notarize.yml",
        }
        launcher = (PROJECT / "scripts/release-local.sh").read_text()
        self.validator = launcher.split("<<'PY_BUILD_PROVENANCE'\n", 1)[1].split("\nPY_BUILD_PROVENANCE", 1)[0]

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, text=True, stderr=subprocess.PIPE)

    def validate(self, changes=None, version=VERSION):
        metadata = {**self.metadata, **(changes or {})}
        file = self.repo / "run-api.json"
        file.write_text(json.dumps(metadata))
        return subprocess.run([sys.executable, "-c", self.validator, str(file), self.release_commit,
                               "v" + version, version], cwd=self.repo, capture_output=True, text=True)

    def test_reuses_real_build_sha_when_only_mobile_documentation_changed(self):
        result = self.validate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), self.build_commit)
        self.assertNotEqual(result.stdout.strip(), self.release_commit)

    def test_rejects_untrusted_failed_nonmanual_or_other_branch_runs(self):
        cases = [
            {"repository": {"full_name": "OpenWhispr/openwhispr"}},
            {"head_repository": {"full_name": "someone/openwhispr"}},
            {"status": "in_progress"}, {"conclusion": "failure"},
            {"event": "pull_request"}, {"event": "push"}, {"head_branch": "develop"},
            {"name": "Other workflow"}, {"path": ".github/workflows/other.yml"},
            {"head_sha": "not-a-commit"},
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                self.assertNotEqual(self.validate(changes).returncode, 0)

    def test_rejects_runtime_source_changes(self):
        (self.repo / "source.js").write_text("different application code\n")
        self.git("commit", "--quiet", "-am", "runtime change")
        self.release_commit = self.git("rev-parse", "HEAD").strip()
        result = self.validate()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("outside documentation", result.stderr)

    def test_markdown_outside_documentation_paths_is_not_exempt(self):
        path = self.repo / ".github/workflows/runtime.md"
        path.parent.mkdir(parents=True)
        path.write_text("workflow input is not a documentation exemption")
        self.git("add", ".github")
        self.git("commit", "--quiet", "-m", "non-documentation markdown")
        self.release_commit = self.git("rev-parse", "HEAD").strip()
        self.assertNotEqual(self.validate().returncode, 0)

    def test_source_renamed_into_documentation_cannot_hide_its_original_path(self):
        (self.repo / "docs").mkdir()
        self.git("mv", "source.js", "docs/source.md")
        self.git("commit", "--quiet", "-m", "rename application source as documentation")
        self.release_commit = self.git("rev-parse", "HEAD").strip()
        result = self.validate()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("outside documentation", result.stderr)

    def test_rejects_mismatched_build_version(self):
        result = self.validate(version="9.9.9")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("version does not match", result.stderr)

    def test_preserves_tagged_build_mode(self):
        result = self.validate({"head_sha": self.release_commit, "head_branch": "v" + VERSION,
                                "event": "push", "name": "Build tagged packages (unsigned)",
                                "path": ".github/workflows/release.yml"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), self.release_commit)

    def test_reused_archive_keeps_original_build_provenance(self):
        metadata = {"version": VERSION, "commit": self.build_commit, "arch": "arm64"}
        with tarfile.open(fileobj=io.BytesIO(archive_bytes(metadata=metadata)), mode="r:gz") as archive:
            release.validate_archive(archive, VERSION, self.build_commit, "arm64")
        with tarfile.open(fileobj=io.BytesIO(archive_bytes(metadata=metadata)), mode="r:gz") as archive:
            with self.assertRaisesRegex(ValueError, "does not match"):
                release.validate_archive(archive, VERSION, self.release_commit, "arm64")


class SigningArtifactTests(unittest.TestCase):
    def select(self, artifacts, prepared_run=None):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / "artifacts.json"
            file.write_text(json.dumps({"artifacts": artifacts}))
            launcher = (PROJECT / "scripts/release-local.sh").read_text()
            validator = launcher.split("<<'PY_SIGNING_ARTIFACT'\n", 1)[1].split("\nPY_SIGNING_ARTIFACT", 1)[0]
            output = io.StringIO()
            with patch.object(sys, "argv", ["selector", str(file), "macos-arm64-signing-123", "123", "ruivza/openwhispr"]), \
                    patch.object(subprocess, "check_output", return_value=json.dumps(prepared_run)) as gh, \
                    contextlib.redirect_stdout(output):
                exec(compile(validator, "signing-artifact-selector", "exec"), {})
            return output.getvalue().strip(), gh.call_args_list

    def artifact(self, run_id=456):
        return {"name": "macos-arm64-signing-123", "expired": False, "workflow_run": {"id": run_id}}

    def prepared_run(self):
        return {"status": "completed", "conclusion": "success", "event": "workflow_dispatch",
                "name": "Prepare macOS signing artifact", "path": ".github/workflows/prepare-macos-signing.yml",
                "repository": {"full_name": "ruivza/openwhispr"},
                "head_repository": {"full_name": "ruivza/openwhispr"}}

    def test_uses_tar_only_artifact_from_original_build(self):
        selected, calls = self.select([self.artifact(123)])
        self.assertEqual(selected, "123")
        self.assertEqual(calls, [])

    def test_uses_verified_repacked_artifact_while_retaining_original_build_id(self):
        selected, calls = self.select([self.artifact()], self.prepared_run())
        self.assertEqual(selected, "456")
        self.assertEqual(calls[0].args[0], ["gh", "api", "repos/ruivza/openwhispr/actions/runs/456"])

    def test_never_falls_back_to_large_legacy_artifact(self):
        for artifacts in ([], [{**self.artifact(), "name": "macos-arm64-unsigned-build"}],
                          [{**self.artifact(), "expired": True}]):
            with self.subTest(artifacts=artifacts), self.assertRaisesRegex(SystemExit, "No application rebuild"):
                self.select(artifacts)

    def test_rejects_failed_or_untrusted_repacking_runs(self):
        for key, value in (("status", "in_progress"), ("conclusion", "failure"), ("event", "push"),
                           ("name", "Other workflow"), ("path", ".github/workflows/other.yml"),
                           ("head_repository", {"full_name": "someone/fork"})):
            with self.subTest(key=key), self.assertRaises(SystemExit):
                self.select([self.artifact()], {**self.prepared_run(), key: value})


class SigningTests(unittest.TestCase):
    def bundle(self, path, identifier, executable, framework=False):
        info_dir = path / ("Resources" if framework else "Contents")
        info_dir.mkdir(parents=True)
        (info_dir / "Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": identifier, "CFBundleExecutable": executable,
            "CFBundleShortVersionString": VERSION,
        }))
        binary = path / executable if framework else path / "Contents/MacOS" / executable
        binary.parent.mkdir(parents=True, exist_ok=True)
        binary.write_bytes(bytes.fromhex("cffaedfe"))
        return binary

    def test_signs_native_modules_helpers_and_frameworks_before_outer_app(self):
        with tempfile.TemporaryDirectory() as temp:
            app = Path(temp).resolve() / "OpenWhispr.app"
            main = self.bundle(app, "com.gizmolabs.openwhispr", "OpenWhispr")
            helper = app / "Contents/Frameworks/OpenWhispr Helper.app"
            helper_exe = self.bundle(helper, "com.gizmolabs.openwhispr.helper", "OpenWhispr Helper")
            framework = app / "Contents/Frameworks/Electron.framework"
            framework_exe = self.bundle(framework, "com.github.Electron.framework", "Electron", True)
            native = app / "Contents/Resources/app.asar.unpacked/native.node"
            native.parent.mkdir(parents=True)
            native.write_bytes(bytes.fromhex("cffaedfe"))
            plan = release.signing_plan(app, VERSION)
            self.assertEqual(plan[-1], app)
            self.assertEqual(set(plan), {app, helper, framework, native})
            self.assertNotIn(main, plan)
            self.assertNotIn(helper_exe, plan)
            self.assertNotIn(framework_exe, plan)
            with self.assertRaisesRegex(ValueError, "version"):
                release.signing_plan(app, "9.9.9")


class UpdateManifestTests(unittest.TestCase):
    def test_fork_revision_keeps_arm64_channel(self):
        with tempfile.TemporaryDirectory() as temp:
            version = "1.10.3-ruivza.1"
            # for arch in ("arm64", "x64"):
            for arch in ("arm64",):
                archive = Path(temp) / f"OpenWhispr-{version}-mac-{arch}.zip"
                archive.write_bytes(b"signed app")
                manifest = release.write_update_manifest(archive, version, arch)
                self.assertEqual(manifest.name, f"ruivza-{arch}-mac.yml")
                self.assertEqual(json.loads(manifest.read_text())["version"], version)

    def test_arm64_manifest_describes_the_final_zip_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            # for arch in ("arm64", "x64"):
            for arch in ("arm64",):
                archive = root / f"OpenWhispr-{VERSION}-mac-{arch}.zip"
                archive.write_bytes(b"final signed and stapled app zip " + arch.encode())
                manifest = release.write_update_manifest(archive, VERSION, arch)
                self.assertEqual(manifest.name, f"latest-{arch}-mac.yml")
                info = json.loads(manifest.read_text())
                expected = base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
                self.assertEqual(info["version"], VERSION)
                self.assertEqual(info["files"], [{"url": archive.name, "sha512": expected, "size": archive.stat().st_size}])
                self.assertEqual(info["path"], archive.name)
                self.assertEqual(info["sha512"], expected)

    def test_x64_metadata_is_no_longer_published(self):
        with tempfile.TemporaryDirectory() as temp:
            archive = Path(temp) / f"OpenWhispr-{VERSION}-mac-x64.zip"
            archive.write_bytes(b"old Intel app")
            with self.assertRaisesRegex(ValueError, "Only Apple Silicon arm64"):
                release.write_update_manifest(archive, VERSION, "x64")
            self.assertEqual(list(Path(temp).glob("*.yml")), [])

    def test_cli_rejects_x64_before_reading_release_artifacts(self):
        for args in [
            ["manifest", "unused.zip", VERSION, "x64"],
            ["extract", "unused.tar.gz", "unused-output", VERSION, COMMIT, "x64"],
        ]:
            with self.subTest(command=args[0]):
                result = subprocess.run([sys.executable, str(PROJECT / "scripts/lib/macos-release.py"), *args],
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, 2)
                self.assertIn("invalid choice: 'x64'", result.stderr)

    def test_unsigned_or_wrong_architecture_archive_names_are_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ("notarize-arm64.zip", f"OpenWhispr-{VERSION}-mac-x64.zip", f"OpenWhispr-{VERSION}-mac-arm64.dmg"):
                archive = root / name
                archive.write_bytes(b"not the final update zip")
                with self.subTest(name=name), self.assertRaisesRegex(ValueError, "final versioned"):
                    release.write_update_manifest(archive, VERSION, "arm64")


if __name__ == "__main__":
    unittest.main()
