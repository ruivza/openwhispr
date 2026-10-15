const test = require('node:test');
const assert = require('node:assert/strict');
const createConfig = require('../../app.config');

function withEnvironment(values, run) {
  const keys = new Set([
    ...Object.keys(process.env).filter((key) => key.startsWith('OPENWHISPR_')),
    ...Object.keys(values),
  ]);
  const previous = new Map([...keys].map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, values);
    return run();
  } finally {
    for (const key of keys) {
      if (previous.get(key) === undefined) delete process.env[key];
      else process.env[key] = previous.get(key);
    }
  }
}

test('unsigned builds use one own identity, preserve both extensions and disable signing team/OTA', () => {
  withEnvironment(
    {
      OPENWHISPR_UNSIGNED_IOS_BUILD: '1',
      OPENWHISPR_IOS_BUNDLE_IDENTIFIER: 'com.example.personalwhispr',
    },
    () => {
      const config = createConfig();
      assert.equal(config.ios.appleTeamId, undefined);
      assert.equal(config.ios.bundleIdentifier, 'com.example.personalwhispr');
      assert.deepEqual(config.ios.entitlements['com.apple.security.application-groups'], [
        'group.com.example.personalwhispr',
      ]);
      const extensions = config.extra.eas.build.experimental.ios.appExtensions;
      assert.deepEqual(
        extensions.map((extension) => extension.bundleIdentifier),
        ['com.example.personalwhispr.keyboard', 'com.example.personalwhispr.activity'],
      );
      for (const extension of extensions) {
        assert.deepEqual(extension.entitlements['com.apple.security.application-groups'], [
          'group.com.example.personalwhispr',
        ]);
      }
      assert.equal(config.updates.enabled, false);
    },
  );
});

test('unsigned builds reject upstream identities and mismatched shared containers', () => {
  for (const values of [
    {},
    { OPENWHISPR_IOS_BUNDLE_IDENTIFIER: 'com.gizmolabs.openwhispr.dev' },
    { OPENWHISPR_IOS_BUNDLE_IDENTIFIER: 'com.example.app/invalid' },
    { OPENWHISPR_IOS_BUNDLE_IDENTIFIER: 'com.example.app', OPENWHISPR_APP_GROUP_ID: 'group.other' },
    {
      OPENWHISPR_IOS_BUNDLE_IDENTIFIER: 'com.example.app',
      OPENWHISPR_KEYBOARD_BUNDLE_IDENTIFIER: 'com.other.keyboard',
    },
  ]) {
    withEnvironment({ ...values, OPENWHISPR_UNSIGNED_IOS_BUILD: '1' }, () => {
      assert.throws(createConfig, /own bundle identifier/);
    });
  }
});

test('ordinary configuration retains its original team metadata', () => {
  withEnvironment({}, () => assert.equal(createConfig().ios.appleTeamId, 'T832773L2J'));
});
