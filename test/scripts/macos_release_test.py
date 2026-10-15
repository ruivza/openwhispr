"""Release input validation and Electron signing order, without signing credentials."""

import base64
import hashlib
import importlib.util
import io
import json
import plistlib
import tarfile
import tempfile
import unittest
from pathlib import Path


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
    def test_fork_revision_keeps_channels_separate_for_both_architectures(self):
        with tempfile.TemporaryDirectory() as temp:
            version = "1.10.3-ruivza.1"
            for arch in ("arm64", "x64"):
                archive = Path(temp) / f"OpenWhispr-{version}-mac-{arch}.zip"
                archive.write_bytes(b"signed app")
                manifest = release.write_update_manifest(archive, version, arch)
                self.assertEqual(manifest.name, f"ruivza-{arch}-mac.yml")
                self.assertEqual(json.loads(manifest.read_text())["version"], version)

    def test_each_architecture_describes_the_final_zip_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for arch in ("arm64", "x64"):
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
