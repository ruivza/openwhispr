import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("publish_packages", Path(__file__).with_name("publish-packages.py"))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class PublishingTests(unittest.TestCase):
    def test_only_successful_same_repository_tag_builds(self):
        run = dict(head_branch="v1.10.4", status="completed", conclusion="success", event="push",
                   name="Build tagged packages (unsigned)", path=".github/workflows/release.yml",
                   repository={"full_name": "ruivza/openwhispr"},
                   head_repository={"full_name": "ruivza/openwhispr"}, head_sha="a" * 40)
        self.assertEqual(publisher.validate_run(run, "ruivza/openwhispr", "a" * 40), "v1.10.4")
        for key, value in (("head_branch", "main"), ("conclusion", "failure"), ("event", "pull_request"),
                           ("head_sha", "b" * 40), ("path", ".github/workflows/other.yml"),
                           ("head_repository", {"full_name": "someone/fork"})):
            with self.subTest(key=key), self.assertRaises(ValueError):
                publisher.validate_run({**run, key: value}, "ruivza/openwhispr", "a" * 40)

    def test_selects_only_versioned_top_level_installers(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for platform in ("windows", "linux"):
                (root / platform).mkdir()
                (root / platform / "latest.yml").write_text("not a release asset")
            exe = root / "windows/OpenWhispr Setup 1.10.4.exe"
            deb = root / "linux/openwhispr_1.10.4_amd64.deb"
            exe.write_bytes(b"exe")
            deb.write_bytes(b"deb")
            nested = root / "windows/win-unpacked"
            nested.mkdir()
            (nested / "OpenWhispr.exe").write_bytes(b"not an installer")
            self.assertEqual(set(publisher.select_packages(root, "1.10.4")), {exe, deb})
            with self.assertRaises(ValueError):
                publisher.select_packages(root, "1.10.5")

    def test_rerun_keeps_mac_assets_and_identical_packages(self):
        with tempfile.TemporaryDirectory() as temp:
            package = Path(temp) / "package.exe"
            package.write_bytes(b"installer")
            existing = {"assets": [{"name": "mac.dmg"},
                                   {"name": package.name, "digest": "sha256:" + publisher.sha256(package)}]}
            with patch.object(publisher, "release_info", return_value=existing), patch.object(publisher, "gh") as gh:
                publisher.upload_packages("ruivza/openwhispr", "v1.10.4", [package])
                gh.assert_not_called()
                existing["assets"][1]["digest"] = "sha256:wrong"
                with self.assertRaises(ValueError):
                    publisher.upload_packages("ruivza/openwhispr", "v1.10.4", [package])

    def test_normalizes_asset_names_before_checksums(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = root / "OpenWhispr Setup 1.10.4.exe"
            package.write_bytes(b"installer")
            staged = publisher.stage_packages([package], root / "staged")
            self.assertEqual(staged[0].name, "OpenWhispr.Setup.1.10.4.exe")
            self.assertEqual(publisher.sha256(staged[0]), publisher.sha256(package))

    def test_update_metadata_names_and_hashes_match_final_assets(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            exe = root / "OpenWhispr Setup 1.10.4.exe"
            image = root / "OpenWhispr-1.10.4-linux-x64.AppImage"
            exe.write_bytes(b"unsigned NSIS installer")
            # AppImage differential-map length is stored in its final 4 bytes.
            image.write_bytes(b"appimage payload and map" + (3).to_bytes(4, "big"))
            staged = publisher.stage_packages([exe, image], root / "staged")
            manifests = publisher.update_manifests(staged, "1.10.4", root / "staged")
            self.assertEqual({p.name for p in manifests}, {"latest.yml", "latest-linux.yml"})
            for manifest in manifests:
                info = json.loads(manifest.read_text())
                target = root / "staged" / info["files"][0]["url"]
                expected = base64.b64encode(hashlib.sha512(target.read_bytes()).digest()).decode()
                self.assertEqual(info["version"], "1.10.4")
                self.assertEqual(info["files"][0]["sha512"], expected)
                self.assertEqual(info["files"][0]["size"], target.stat().st_size)
                self.assertEqual(info["path"], target.name)
                self.assertEqual(info["sha512"], expected)
            self.assertEqual(json.loads((root / "staged/latest.yml").read_text())["path"],
                             "OpenWhispr.Setup.1.10.4.exe")
            self.assertEqual(json.loads((root / "staged/latest-linux.yml").read_text())["files"][0]["blockMapSize"], 3)

    def test_missing_or_ambiguous_updater_payloads_fail_before_publishing(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for names in (("package.exe",), ("one.exe", "two.exe", "package.AppImage")):
                packages = [root / name for name in names]
                for package in packages:
                    package.write_bytes(b"payload")
                with self.subTest(names=names), self.assertRaisesRegex(ValueError, "Exactly one"):
                    publisher.update_manifests(packages, "1.10.4", root)

    def test_upstream_or_other_repositories_are_rejected_without_network_calls(self):
        with patch.object(publisher, "gh") as gh:
            for repository in ("OpenWhispr/openwhispr", "other/openwhispr"):
                with self.subTest(repository=repository), self.assertRaisesRegex(ValueError, "only to"):
                    publisher.upload_packages(repository, "v1.10.4", [])
            gh.assert_not_called()

    def test_can_refresh_only_its_own_generated_checksum_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            manifest = Path(temp) / "SHA256SUMS-windows-linux"
            manifest.write_text("updated checksums")
            existing = {"assets": [{"name": manifest.name, "digest": "sha256:old"}]}
            with patch.object(publisher, "release_info", return_value=existing), patch.object(publisher, "gh") as gh:
                publisher.upload_packages("ruivza/openwhispr", "v1.10.4", [manifest])
                gh.assert_called_once_with("release", "upload", "v1.10.4", str(manifest),
                                           "--repo", "ruivza/openwhispr", "--clobber")

    def test_adds_package_to_existing_release_without_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            package = Path(temp) / "package.exe"
            package.write_bytes(b"installer")
            with patch.object(publisher, "release_info", return_value={"assets": [{"name": "mac.dmg"}]}), \
                    patch.object(publisher, "gh") as gh:
                publisher.upload_packages("ruivza/openwhispr", "v1.10.4", [package])
                gh.assert_called_once_with("release", "upload", "v1.10.4", str(package), "--repo", "ruivza/openwhispr")


if __name__ == "__main__":
    unittest.main()
