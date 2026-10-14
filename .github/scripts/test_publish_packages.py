import importlib.util
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
