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
    def reusable_run(self):
        return dict(head_branch="main", head_sha="a" * 40, status="completed", conclusion="success",
                    event="workflow_dispatch", name="Build unsigned packages",
                    path=".github/workflows/build-and-notarize.yml",
                    repository={"full_name": "ruivza/openwhispr"},
                    head_repository={"full_name": "ruivza/openwhispr"})

    def reuse_api_results(self, files):
        return [{"content": base64.b64encode(b'{"version":"1.10.3-ruivza.2"}').decode()},
                {"sha": "b" * 40}, {"merge_base_commit": {"sha": "a" * 40}, "files": files}]

    def test_reuses_successful_main_build_when_only_documentation_changed(self):
        with patch.object(publisher, "api", side_effect=self.reuse_api_results([
                {"filename": "openwhispr-mobile/CONTRIBUTING.md"}])) as api:
            self.assertEqual(publisher.validate_reused_run(self.reusable_run(), "ruivza/openwhispr"),
                             ("v1.10.3-ruivza.2", "b" * 40))
            self.assertIn("a" * 40, api.call_args_list[0].args[0])

    def test_reuse_rejects_failed_untrusted_and_non_manual_main_builds_before_network(self):
        for key, value in (("conclusion", "failure"), ("status", "in_progress"),
                           ("event", "pull_request"), ("head_branch", "develop"),
                           ("path", ".github/workflows/other.yml"), ("head_sha", "bad"),
                           ("head_repository", {"full_name": "someone/fork"})):
            with self.subTest(key=key), patch.object(publisher, "api") as api, self.assertRaises(ValueError):
                publisher.validate_reused_run({**self.reusable_run(), key: value}, "ruivza/openwhispr")
            api.assert_not_called()

    def test_reuse_rejects_source_changes_and_code_renamed_as_documentation(self):
        for files in ([{"filename": "package.json"}], [{"filename": "src/app.ts"}],
                      [{"filename": "notes.md", "previous_filename": "main.js"}],
                      [{"filename": "README.md"}] * 300):
            with self.subTest(files=files[:1]), \
                    patch.object(publisher, "api", side_effect=self.reuse_api_results(files)), \
                    self.assertRaises(ValueError):
                publisher.validate_reused_run(self.reusable_run(), "ruivza/openwhispr")

    def test_reuse_rejects_unrelated_release_history(self):
        responses = self.reuse_api_results([])
        responses[-1]["merge_base_commit"]["sha"] = "c" * 40
        with patch.object(publisher, "api", side_effect=responses), self.assertRaises(ValueError):
            publisher.validate_reused_run(self.reusable_run(), "ruivza/openwhispr")

    def test_only_successful_same_repository_tag_builds(self):
        run = dict(head_branch="v1.10.4", status="completed", conclusion="success", event="push",
                   name="Build tagged packages (unsigned)", path=".github/workflows/release.yml",
                   repository={"full_name": "ruivza/openwhispr"},
                   head_repository={"full_name": "ruivza/openwhispr"}, head_sha="a" * 40)
        self.assertEqual(publisher.validate_run(run, "ruivza/openwhispr", "a" * 40), "v1.10.4")
        for tag in ("v1.10.3-ruivza.1", "v1.10.3-ruivza.2", "v1.10.4-ruivza.1"):
            with self.subTest(tag=tag):
                self.assertEqual(publisher.validate_run({**run, "head_branch": tag}, "ruivza/openwhispr", "a" * 40), tag)
        for tag in ("v1.10.3.1", "v1.10.3-beta.1", "v1.10.3-ruivza", "v1.10.3-ruivza.0"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                publisher.validate_run({**run, "head_branch": tag}, "ruivza/openwhispr", "a" * 40)
        for key, value in (("head_branch", "main"), ("conclusion", "failure"), ("event", "pull_request"),
                           ("head_sha", "b" * 40), ("path", ".github/workflows/other.yml"),
                           ("head_repository", {"full_name": "someone/fork"})):
            with self.subTest(key=key), self.assertRaises(ValueError):
                publisher.validate_run({**run, key: value}, "ruivza/openwhispr", "a" * 40)

    def test_selects_only_versioned_windows_installers_without_linux_artifacts(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for platform in ("windows",):
                (root / platform).mkdir()
                (root / platform / "latest.yml").write_text("not a release asset")
            exe = root / "windows/OpenWhispr Setup 1.10.4.exe"
            deb = root / "windows/openwhispr_1.10.4_amd64.deb"
            exe.write_bytes(b"exe")
            deb.write_bytes(b"deb")
            nested = root / "windows/win-unpacked"
            nested.mkdir()
            (nested / "OpenWhispr.exe").write_bytes(b"not an installer")
            self.assertEqual(set(publisher.select_packages(root, "1.10.4")), {exe})
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
            self.assertEqual({p.name for p in manifests}, {"latest.yml"})
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
            self.assertFalse((root / "staged/latest-linux.yml").exists())

    def test_missing_or_ambiguous_updater_payloads_fail_before_publishing(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for names in (("package.AppImage",), ("one.exe", "two.exe", "package.AppImage")):
                packages = [root / name for name in names]
                for package in packages:
                    package.write_bytes(b"payload")
                with self.subTest(names=names), self.assertRaisesRegex(ValueError, "Exactly one"):
                    publisher.update_manifests(packages, "1.10.4", root)

    def test_fork_revision_metadata_uses_its_own_channel(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            version = "1.10.3-ruivza.1"
            packages = [root / f"OpenWhispr-{version}.exe", root / f"OpenWhispr-{version}.AppImage"]
            for package in packages:
                package.write_bytes(b"payload")
            manifests = publisher.update_manifests(packages, version, root)
            self.assertEqual({p.name for p in manifests}, {"ruivza.yml"})
            for manifest in manifests:
                self.assertEqual(json.loads(manifest.read_text())["version"], version)

    def test_only_fork_revision_releases_are_created_as_prereleases(self):
        for tag in ("v1.10.4", "v1.10.3-ruivza.1"):
            with self.subTest(tag=tag), \
                    patch.object(publisher, "release_info", side_effect=[None, {"assets": []}]), \
                    patch.object(publisher, "gh") as gh:
                publisher.upload_packages("ruivza/openwhispr", tag, [])
                arguments = gh.call_args.args
                self.assertEqual(arguments[:3], ("release", "create", tag))
                self.assertEqual("--prerelease" in arguments, "-ruivza." in tag)

    def test_upstream_or_other_repositories_are_rejected_without_network_calls(self):
        with patch.object(publisher, "gh") as gh:
            for repository in ("OpenWhispr/openwhispr", "other/openwhispr"):
                with self.subTest(repository=repository), self.assertRaisesRegex(ValueError, "only to"):
                    publisher.upload_packages(repository, "v1.10.4", [])
            gh.assert_not_called()

    def test_can_refresh_only_its_own_generated_checksum_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            manifest = Path(temp) / "SHA256SUMS-windows"
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

    def test_main_downloads_and_publishes_windows_only(self):
        tag = "v1.10.3-ruivza.1"
        commit = "a" * 40
        run = dict(head_branch=tag, head_sha=commit, status="completed", conclusion="success", event="push",
                   name="Build tagged packages (unsigned)", path=".github/workflows/release.yml",
                   repository={"full_name": "ruivza/openwhispr"}, head_repository={"full_name": "ruivza/openwhispr"})
        downloads = []
        published = []

        def download(*args):
            self.assertEqual(args[:3], ("run", "download", "123"))
            downloads.append(args[args.index("--name") + 1])
            destination = Path(args[args.index("--dir") + 1])
            destination.mkdir()
            (destination / f"OpenWhispr-{tag[1:]}.exe").write_bytes(b"installer")

        def upload(repository, release_tag, packages):
            self.assertEqual((repository, release_tag), ("ruivza/openwhispr", tag))
            published.extend(p.name for p in packages)

        with patch.dict(publisher.os.environ, RELEASE_REPOSITORY="ruivza/openwhispr", BUILD_RUN_ID="123"), \
                patch.object(publisher, "api", side_effect=[run, {"sha": commit}, {"sha": commit}]), \
                patch.object(publisher, "gh", side_effect=download), \
                patch.object(publisher, "upload_packages", side_effect=upload):
            publisher.main()
        self.assertEqual(downloads, ["windows-unsigned-build"])
        self.assertEqual(set(published), {f"OpenWhispr-{tag[1:]}.exe", "SHA256SUMS-windows", "ruivza.yml"})

    def test_main_reuses_existing_artifact_without_starting_a_build(self):
        tag = "v1.10.3-ruivza.2"
        calls = []

        def download(*args):
            calls.append(args)
            self.assertEqual(args[:3], ("run", "download", "38694847321"))
            destination = Path(args[args.index("--dir") + 1])
            destination.mkdir()
            (destination / f"OpenWhispr-{tag[1:]}.exe").write_bytes(b"existing installer")

        with patch.dict(publisher.os.environ, RELEASE_REPOSITORY="ruivza/openwhispr", BUILD_RUN_ID="38694847321"), \
                patch.object(publisher, "api", side_effect=[self.reusable_run(),
                                                          *self.reuse_api_results([{"filename": "README.md"}]),
                                                          {"sha": "b" * 40}]), \
                patch.object(publisher, "gh", side_effect=download), \
                patch.object(publisher, "upload_packages") as upload:
            publisher.main()
        self.assertEqual(len(calls), 1)
        self.assertEqual(upload.call_args.args[:2], ("ruivza/openwhispr", tag))


if __name__ == "__main__":
    unittest.main()
