"""Unsigned iOS input/target selection contracts; these tests do not run Xcode."""

import copy
import shlex
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[2]
SCRIPT = PROJECT / "scripts/build-ios-unsigned.sh"
SOURCE = SCRIPT.read_text(encoding="utf-8")
SELECTOR = SOURCE.split("<<'PY_SELECTION'\n", 1)[1].split("\nPY_SELECTION", 1)[0]
HELPERS = {"__name__": "ios_build_selection_test"}
exec(compile(SELECTOR, str(SCRIPT) + ":PY_SELECTION", "exec"), HELPERS)
IDENTITY = "net.example.owner-notes"


def main_settings(**changes):
    settings = {
        "PRODUCT_TYPE": "com.apple.product-type.application",
        "PRODUCT_BUNDLE_IDENTIFIER": IDENTITY,
        "PLATFORM_NAME": "iphoneos",
        "ARCHS": "arm64",
        "CODE_SIGNING_ALLOWED": "NO",
        "CODE_SIGNING_REQUIRED": "NO",
        "DEVELOPMENT_TEAM": "",
        "CODE_SIGN_IDENTITY": "",
        "PROVISIONING_PROFILE_SPECIFIER": "",
        **changes,
    }
    return [{"target": "Owner Notes", "buildSettings": settings}]


def expo_config():
    return {
        "ios": {"bundleIdentifier": IDENTITY,
                "entitlements": {"com.apple.security.application-groups": ["group." + IDENTITY]}},
        "extra": {"openWhispr": {"iosBundleIdentifier": IDENTITY,
                                 "keyboardBundleIdentifier": IDENTITY + ".keyboard",
                                 "appGroupId": "group." + IDENTITY,
                                 "scheme": IDENTITY}},
    }


class BuildSelectionTests(unittest.TestCase):
    def test_workspace_discovery_keeps_names_with_spaces_and_ignores_pods(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "Owner Notes.xcworkspace").mkdir()
            (root / "Pods.xcworkspace").mkdir()
            actual = HELPERS["workspace_path"](root)
            self.assertEqual(Path(actual), (root / "Owner Notes.xcworkspace").resolve())
            (root / "Owner Notes.xcodeproj").mkdir()
            (root / "Other.xcodeproj").mkdir()
            self.assertEqual(Path(HELPERS["project_path"](root, actual)).name, "Owner Notes.xcodeproj")

    def test_workspace_ambiguity_or_absence_fails_instead_of_guessing(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(ValueError, "Expected one"):
                HELPERS["workspace_path"](temp)
            for name in ["A.xcworkspace", "B.xcworkspace"]:
                (Path(temp) / name).mkdir()
            with self.assertRaisesRegex(ValueError, "refusing to guess"):
                HELPERS["workspace_path"](temp)

    def test_scheme_prefers_the_generated_workspace_name_over_extensions(self):
        listing = {"workspace": {"schemes": ["Keyboard", "Owner Notes", "Live Activity"]}}
        self.assertEqual(HELPERS["scheme_name"](listing, "Owner Notes.xcworkspace"), "Owner Notes")

    def test_explicit_scheme_and_only_scheme_are_supported(self):
        listing = {"workspace": {"schemes": ["App", "Owner Build"]}}
        self.assertEqual(HELPERS["scheme_name"](listing, "Name.xcworkspace", "Owner Build"), "Owner Build")
        self.assertEqual(HELPERS["scheme_name"]({"workspace": {"schemes": ["DifferentName"]}}, "App.xcworkspace"), "DifferentName")

    def test_unknown_ambiguous_or_malformed_scheme_lists_fail(self):
        with self.assertRaisesRegex(ValueError, "not present"):
            HELPERS["scheme_name"]({"workspace": {"schemes": ["App"]}}, "App.xcworkspace", "Unknown")
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            HELPERS["scheme_name"]({"workspace": {"schemes": ["A", "B"]}}, "App.xcworkspace")
        for listing in [[], {}, {"workspace": {"schemes": []}}, {"workspace": {"schemes": [1]}}, {"workspace": {"schemes": ["bad\nname"]}}]:
            with self.subTest(listing=listing), self.assertRaises(ValueError):
                HELPERS["scheme_name"](listing, "App.xcworkspace")

    def test_effective_expo_config_matches_the_owner_and_clears_team(self):
        config = expo_config()
        HELPERS["validate_config"](config, IDENTITY)
        HELPERS["validate_config"]({"expo": config}, IDENTITY)
        for path, value in [
            (("ios", "bundleIdentifier"), "com.gizmolabs.openwhispr"),
            (("ios", "appleTeamId"), "UPSTREAMTEAM"),
            (("extra", "openWhispr", "iosBundleIdentifier"), "wrong.identifier"),
            (("extra", "openWhispr", "appGroupId"), "group.wrong.identifier"),
            (("extra", "openWhispr", "keyboardBundleIdentifier"), "wrong.keyboard"),
            (("extra", "openWhispr", "scheme"), "1invalid"),
        ]:
            changed = copy.deepcopy(config)
            target = changed
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            with self.subTest(path=path), self.assertRaises(ValueError):
                HELPERS["validate_config"](changed, IDENTITY)

    def test_main_application_must_be_the_requested_device_arm64_target(self):
        HELPERS["validate_main_settings"](main_settings(), IDENTITY)
        for changes in [
            {"PRODUCT_BUNDLE_IDENTIFIER": "other.owner"},
            {"PRODUCT_TYPE": "com.apple.product-type.app-extension"},
            {"PLATFORM_NAME": "iphonesimulator"}, {"ARCHS": "x86_64"},
        ]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                HELPERS["validate_main_settings"](main_settings(**changes), IDENTITY)
        with self.assertRaises(ValueError):
            HELPERS["validate_main_settings"](main_settings() * 2, IDENTITY)

    def test_every_signing_override_is_required_and_other_targets_are_preserved(self):
        for name, value in [("CODE_SIGNING_ALLOWED", "YES"), ("CODE_SIGNING_REQUIRED", "YES"),
                            ("DEVELOPMENT_TEAM", "UPSTREAMTEAM"), ("CODE_SIGN_IDENTITY", "Apple Development"),
                            ("PROVISIONING_PROFILE_SPECIFIER", "profile")]:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "disable signing"):
                HELPERS["validate_main_settings"](main_settings(**{name: value}), IDENTITY)
        settings = main_settings() + [{"target": "Keyboard", "buildSettings": {
            "PRODUCT_TYPE": "com.apple.product-type.app-extension",
            "PRODUCT_BUNDLE_IDENTIFIER": IDENTITY + ".keyboard"}}]
        HELPERS["validate_main_settings"](settings, IDENTITY)

    def test_archive_contract_does_not_export_sign_or_remove_extensions(self):
        signing = SOURCE.split("SIGNING_ARGS=(", 1)[1].split("\n)", 1)[0]
        self.assertEqual(shlex.split(signing), ["CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO",
                                               "CODE_SIGN_IDENTITY=", "DEVELOPMENT_TEAM=", "PROVISIONING_PROFILE_SPECIFIER="])
        for required in ["prebuild --platform ios --no-install", "bundle exec pod install", "-alltargets",
                         "-configuration Release -sdk iphoneos ARCHS=arm64", "generic/platform=iOS",
                         "--build-settings", "OPENWHISPR_UNSIGNED_IOS_BUILD=1"]:
            self.assertIn(required, SOURCE)
        for forbidden in ["-exportArchive", "-allowProvisioningUpdates", "codesign --sign", "security import", "--clean", "rm -rf", "download-brand-fonts.js"]:
            self.assertNotIn(forbidden, SOURCE)

    def test_bash_syntax_when_bash_is_available(self):
        bash = shutil.which("bash")
        if bash is None and Path("C:/Program Files/Git/bin/bash.exe").exists():
            bash = "C:/Program Files/Git/bin/bash.exe"
        if bash is None:
            self.skipTest("Bash is not installed; selector tests still run")
        subprocess.run([bash, "-n", str(SCRIPT)], check=True, capture_output=True, text=True)


if __name__ == "__main__":
    unittest.main()
