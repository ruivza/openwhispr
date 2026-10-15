import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import plistlib
import stat
import struct
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("ios_unsigned", ROOT / "scripts/lib/ios-unsigned.py")
HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPER)
ID = "com.example.personalwhispr"


def write_plist(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(plistlib.dumps(value))


class UnsignedIosTests(unittest.TestCase):
    def setUp(self):
        cache = ROOT / "build" / "ios-tests"
        cache.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="i-", dir=cache)
        self.root = Path(self.temp.name)
        self.assertTrue(self.root.resolve().is_relative_to(cache.resolve()))
        self.addCleanup(self.temp.cleanup)
        self.archive = self.root / "OpenWhispr.xcarchive"
        self.app = self.archive / "Products/Applications/OpenWhispr.app"
        self.ios = self.root / "ios"
        self.output = self.root / "output"
        self.settings = self.root / "settings.json"
        settings = []
        for suffix, name in [("", "OpenWhispr"), (".keyboard", "Keyboard"), (".activity", "Activity")]:
            app = self.app if not suffix else self.app / f"PlugIns/{name}.appex"
            write_plist(app / "Info.plist", {
                "CFBundleIdentifier": ID + suffix,
                "CFBundleExecutable": name,
                "CFBundleSupportedPlatforms": ["iPhoneOS"],
                "CFBundleShortVersionString": "1.2.3",
                "CFBundleVersion": "1",
            })
            executable = app / name
            executable.write_bytes(struct.pack("<II", 0xFEEDFACF, 0x0100000C) + b"synthetic fixture")
            executable.chmod(0o755)
            entitlement = self.ios / f"{name}/{name}.entitlements"
            write_plist(entitlement, {"com.apple.security.application-groups": ["group." + ID]})
            settings.append({"target": name, "action": "build", "buildSettings": {
                "PRODUCT_BUNDLE_IDENTIFIER": ID + suffix,
                "TARGET_NAME": name,
                "SRCROOT": str(self.ios.resolve()),
                "CODE_SIGN_ENTITLEMENTS": str(entitlement.relative_to(self.ios)),
                "CODE_SIGNING_ALLOWED": "NO", "DEVELOPMENT_TEAM": "",
            }})
        self.settings.write_text(json.dumps(settings), encoding="utf-8")

    def package(self, bundle_id=ID):
        return HELPER.package_archive(self.archive, self.output, bundle_id, "synthetic-commit", self.settings, ios_root=self.ios)

    def test_packages_device_payload_both_extensions_metadata_and_verified_checksums(self):
        self.package()
        with zipfile.ZipFile(self.output / "OpenWhispr-unsigned.ipa") as ipa:
            self.assertIn("Payload/OpenWhispr.app/PlugIns/Keyboard.appex/Keyboard", ipa.namelist())
            self.assertIn("Payload/OpenWhispr.app/PlugIns/Activity.appex/Activity", ipa.namelist())
            self.assertNotIn(".xcarchive", "".join(ipa.namelist()))
            executable = ipa.getinfo("Payload/OpenWhispr.app/OpenWhispr")
            self.assertEqual((executable.external_attr >> 16) & 0o777,
                             stat.S_IMODE((self.app / "OpenWhispr").stat().st_mode))
        info = json.loads((self.output / "build-info.json").read_text())
        self.assertTrue(info["unsigned"])
        self.assertEqual(info["architecture"], "arm64")
        entitlements = json.loads((self.output / "entitlements.json").read_text())
        self.assertEqual(set(entitlements), {ID, ID + ".keyboard", ID + ".activity"})
        for line in (self.output / "SHA256SUMS").read_text().splitlines():
            digest, name = line.split("  ")
            self.assertEqual(digest, hashlib.sha256((self.output / name).read_bytes()).hexdigest())

    def test_rejects_wrong_identity_and_upstream_identity(self):
        for value in ["com.gizmolabs.openwhispr", "com.other.app", "invalid"]:
            with self.assertRaises(ValueError):
                self.package(value)

    def test_rejects_simulator_or_wrong_architecture(self):
        info = HELPER.read_plist(self.app / "Info.plist")
        info["CFBundleSupportedPlatforms"] = ["iPhoneSimulator"]
        write_plist(self.app / "Info.plist", info)
        with self.assertRaisesRegex(ValueError, "iPhoneOS"):
            self.package()
        info["CFBundleSupportedPlatforms"] = ["iPhoneOS"]
        write_plist(self.app / "Info.plist", info)
        (self.app / "OpenWhispr").write_bytes(struct.pack("<II", 0xFEEDFACF, 0x01000007))
        with self.assertRaisesRegex(ValueError, "arm64"):
            self.package()

    def test_rejects_missing_extension(self):
        info = self.app / "PlugIns/Activity.appex/Info.plist"
        values = HELPER.read_plist(info)
        values["CFBundleIdentifier"] = ID + ".other"
        write_plist(info, values)
        with self.assertRaisesRegex(ValueError, "extensions"):
            self.package()

    def test_accepts_xcode_alltargets_identical_app_record_without_losing_extensions(self):
        settings = json.loads(self.settings.read_text())
        # The real Xcode 26.4.1 output contains the main app twice, followed by
        # the Activity and Keyboard records; the duplicate is fully identical.
        settings.insert(1, copy.deepcopy(settings[0]))
        self.settings.write_text(json.dumps(settings))
        self.package()
        entitlements = json.loads((self.output / "entitlements.json").read_text())
        self.assertEqual(set(entitlements), {ID, ID + ".keyboard", ID + ".activity"})
        with zipfile.ZipFile(self.output / "OpenWhispr-unsigned.ipa") as ipa:
            self.assertIn("Payload/OpenWhispr.app/PlugIns/Keyboard.appex/Keyboard", ipa.namelist())
            self.assertIn("Payload/OpenWhispr.app/PlugIns/Activity.appex/Activity", ipa.namelist())

    def test_rejects_non_equivalent_duplicates_even_with_matching_app_groups(self):
        original = json.loads(self.settings.read_text())
        alternate = self.ios / "Other/Other.entitlements"
        write_plist(alternate, {"com.apple.security.application-groups": ["group." + ID]})
        changes = [
            {"target": "OtherTarget"},
            {"action": "archive"},
            {"buildSettings": {"TARGET_NAME": "OtherTarget"}},
            {"buildSettings": {"CODE_SIGN_ENTITLEMENTS": str(alternate.relative_to(self.ios))}},
            {"buildSettings": {"SDKROOT": "iphonesimulator"}},
        ]
        for change in changes:
            with self.subTest(change=change):
                settings = copy.deepcopy(original)
                duplicate = copy.deepcopy(settings[0])
                if "buildSettings" in change:
                    duplicate["buildSettings"].update(change["buildSettings"])
                else:
                    duplicate.update(change)
                settings.append(duplicate)
                self.settings.write_text(json.dumps(settings))
                with self.assertRaisesRegex(ValueError, "Conflicting application build settings"):
                    self.package()

    def test_duplicate_records_still_validate_group_source_and_signing(self):
        original = json.loads(self.settings.read_text())
        bad_entitlement = self.ios / "Other/Bad.entitlements"
        write_plist(bad_entitlement, {"com.apple.security.application-groups": ["group.other"]})
        cases = [
            ({"SRCROOT": str(self.root)}, "generated iOS project"),
            ({"CODE_SIGN_ENTITLEMENTS": str(bad_entitlement.relative_to(self.ios))}, "App Group"),
            ({"DEVELOPMENT_TEAM": "UNEXPECTED"}, "clear the team"),
            ({"CODE_SIGNING_ALLOWED": "YES"}, "disable signing"),
        ]
        for change, message in cases:
            with self.subTest(change=change):
                settings = copy.deepcopy(original)
                duplicate = copy.deepcopy(settings[0])
                duplicate["buildSettings"].update(change)
                settings.append(duplicate)
                self.settings.write_text(json.dumps(settings))
                with self.assertRaisesRegex(ValueError, message):
                    self.package()

    def test_duplicate_main_record_cannot_replace_a_missing_extension_identity(self):
        settings = json.loads(self.settings.read_text())
        settings[-1]["buildSettings"]["PRODUCT_BUNDLE_IDENTIFIER"] = "com.other.activity"
        settings.insert(1, copy.deepcopy(settings[0]))
        self.settings.write_text(json.dumps(settings))
        with self.assertRaisesRegex(ValueError, "Missing build settings"):
            self.package()

    def test_rejects_mismatched_app_group_or_signing_team(self):
        file = self.ios / "Keyboard/Keyboard.entitlements"
        write_plist(file, {"com.apple.security.application-groups": ["group.other"]})
        with self.assertRaisesRegex(ValueError, "App Group"):
            self.package()
        write_plist(file, {"com.apple.security.application-groups": ["group." + ID]})
        settings = json.loads(self.settings.read_text())
        settings[0]["buildSettings"]["DEVELOPMENT_TEAM"] = "UPSTREAM"
        self.settings.write_text(json.dumps(settings))
        with self.assertRaisesRegex(ValueError, "clear the team"):
            self.package()

    def test_refuses_embedded_profiles_and_existing_artifact_replacement(self):
        profile = self.app / "embedded.mobileprovision"
        profile.write_bytes(b"synthetic profile")
        with self.assertRaisesRegex(ValueError, "unsigned"):
            self.package()
        profile.unlink()
        self.package()
        original = (self.output / "OpenWhispr-unsigned.ipa").read_bytes()
        with self.assertRaisesRegex(ValueError, "replace"):
            self.package()
        self.assertEqual(original, (self.output / "OpenWhispr-unsigned.ipa").read_bytes())


if __name__ == "__main__":
    unittest.main()
