const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const mobileRoot = path.resolve(__dirname, '../..');

function loadProductionModule(relativePath, modules = {}) {
  const module = { exports: {} };
  const dependencies = [];
  const filename = path.join(mobileRoot, relativePath);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const errors = compiled.diagnostics.filter(
    (entry) => entry.category === ts.DiagnosticCategory.Error,
  );
  assert.equal(
    errors.length,
    0,
    ts.formatDiagnostics(errors, {
      getCanonicalFileName: (value) => value,
      getCurrentDirectory: () => mobileRoot,
      getNewLine: () => '\n',
    }),
  );
  vm.runInNewContext(
    compiled.outputText,
    {
      module,
      exports: module.exports,
      __dirname: path.dirname(filename),
      process: {
        env: {
          EXPO_PUBLIC_SENTRY_DSN: 'https://synthetic@sentry.example/1',
          EXPO_PUBLIC_APPSFLYER_DEV_KEY: 'synthetic-test-key',
          EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: 'synthetic-revenuecat-key',
          EXPO_PUBLIC_SUPERWALL_IOS_API_KEY: 'synthetic-superwall-key',
        },
      },
      __DEV__: false,
      require(name) {
        dependencies.push(name);
        assert.ok(Object.hasOwn(modules, name), `Unexpected runtime dependency: ${name}`);
        return modules[name];
      },
    },
    { filename },
  );
  return { exports: module.exports, dependencies };
}

test('configured SDK credentials cannot load Sentry or collect crashes/logs/replays', () => {
  const loaded = loadProductionModule('src/lib/sentry.ts');
  loaded.exports.initSentry();
  loaded.exports.initSentry();
  const { Sentry } = loaded.exports;
  assert.equal(Sentry.captureException(new Error('synthetic exception')), '');
  assert.equal(Sentry.captureMessage('synthetic diagnostic', 'warning'), '');
  assert.equal(Sentry.addBreadcrumb({ message: 'synthetic breadcrumb' }), undefined);
  const component = () => null;
  assert.equal(Sentry.wrap(component), component);
  assert.deepEqual(loaded.dependencies, []);
});

test('AppsFlyer never starts or queues/sends events after ATT approval or app resume', async () => {
  const loaded = loadProductionModule('src/lib/appsflyer.ts');
  const appsFlyer = loaded.exports;
  appsFlyer.initAppsFlyer();
  appsFlyer.setAppsFlyerTrackingAuthorizationStatus('authorized');
  await appsFlyer.refreshAppsFlyerTrackingAuthorization();
  appsFlyer.logAppsFlyerEvent('synthetic_event', { consent: true });
  appsFlyer.logTutorialCompletion({ keyboardInstalled: true, microphonePermissionGranted: true });
  appsFlyer.logTranscriptionCompleted({ source: 'keyboard', provider: 'cloud' });
  appsFlyer.logPaywallViewed('account_billing_open');
  appsFlyer.logSubscription('synthetic.monthly', 'account_billing_open');
  appsFlyer.initAppsFlyer();
  await appsFlyer.refreshAppsFlyerTrackingAuthorization();
  assert.deepEqual(loaded.dependencies, []);
});

test('tracking compatibility methods never load or prompt the native ATT SDK', async () => {
  const loaded = loadProductionModule('src/lib/trackingTransparency.ts');
  assert.equal(await loaded.exports.getTrackingAuthorizationStatus(), 'notSupported');
  assert.equal(await loaded.exports.requestTrackingAuthorization(), 'notSupported');
  assert.deepEqual(loaded.dependencies, []);
});

function createHooks() {
  const state = [];
  const refs = [];
  const effects = [];
  let stateIndex = 0;
  let refIndex = 0;
  return {
    beginRender() {
      stateIndex = 0;
      refIndex = 0;
    },
    runEffects() {
      effects.splice(0).forEach((effect) => effect());
    },
    module: {
      useState(initial) {
        const index = stateIndex++;
        if (!(index in state)) state[index] = initial;
        return [
          state[index],
          (value) => {
            state[index] = value;
          },
        ];
      },
      useRef(initial) {
        const index = refIndex++;
        if (!(index in refs)) refs[index] = { current: initial };
        return refs[index];
      },
      useCallback(callback) {
        return callback;
      },
      useEffect(effect) {
        effects.push(effect);
      },
    },
  };
}

const jsxRuntime = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
};

test('a saved ATT onboarding step advances without tracking modules and can retry a failed save', async () => {
  const hooks = createHooks();
  let transitions = 0;
  const loaded = loadProductionModule('src/screens/onboarding/steps/TrackingPermissionStep.tsx', {
    react: hooks.module,
    'react/jsx-runtime': jsxRuntime,
    'react-native': { View: 'View' },
    '@/hooks/useOnboardingStep': {
      useOnboardingStep(step) {
        assert.equal(step, 'tracking-permission');
        return {
          async goNext() {
            transitions++;
            if (transitions === 1) throw new Error('synthetic storage failure');
          },
        };
      },
    },
    '@/components/onboarding/OnboardingShell': { OnboardingShell: 'OnboardingShell' },
    '@/lib/onboardingErrors': { describeOnboardingError: (_error, fallback) => fallback },
  });
  hooks.beginRender();
  const firstRender = loaded.exports.TrackingPermissionStep();
  assert.equal(firstRender.type, 'View');
  hooks.runEffects();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transitions, 1);
  hooks.beginRender();
  const retryRender = loaded.exports.TrackingPermissionStep();
  assert.equal(retryRender.props.ctaLabel, 'Retry');
  assert.equal(retryRender.props.subtitle, 'Could not save progress.');
  await retryRender.props.onCta();
  assert.equal(transitions, 2);
});

// Original purchase-enabled expectation retained for reference.
// test('RevenueCat preserves StoreKit observer mode without optional diagnostics/device identifiers', () => {
//   let configured;
//   const purchases = {
//     configure: (options) => {
//       configured = options;
//     },
//   };
//   const loaded = loadProductionModule('src/lib/revenuecat.ts', {
//     'react-native': { Platform: { OS: 'ios' } },
//     'react-native-purchases': {
//       __esModule: true,
//       default: purchases,
//       PURCHASES_ARE_COMPLETED_BY_TYPE: { MY_APP: 'MY_APP' },
//       STOREKIT_VERSION: { STOREKIT_2: 'STOREKIT_2' },
//     },
//     '@/lib/sentry': { Sentry: { captureException: () => undefined } },
//   });
//   loaded.exports.configureRevenueCat();
//   assert.equal(configured.apiKey, 'synthetic-revenuecat-key');
//   assert.equal(configured.diagnosticsEnabled, false);
//   assert.equal(configured.automaticDeviceIdentifierCollectionEnabled, false);
//   assert.equal(configured.purchasesAreCompletedBy.type, 'MY_APP');
//   assert.equal(configured.purchasesAreCompletedBy.storeKitVersion, 'STOREKIT_2');
// });
//
test('RevenueCat never loads a purchase SDK or configures identity even with a saved key', async () => {
  const loaded = loadProductionModule('src/lib/revenuecat.ts');
  loaded.exports.configureRevenueCat();
  assert.equal(await loaded.exports.identifyRevenueCatUser('synthetic-user'), false);
  assert.equal(await loaded.exports.syncRevenueCatPurchases(), false);
  assert.equal(await loaded.exports.recordRevenueCatPurchase('synthetic-product'), false);
  assert.equal(await loaded.exports.showAppStoreManageSubscriptions(), false);
  assert.equal(await loaded.exports.getAppStorefrontCountryCode(), null);
  await loaded.exports.resetRevenueCatUser();
  assert.deepEqual(loaded.dependencies, []);
});
// Original purchase-enabled expectation retained for reference.
// test('Superwall keeps purchase UI while disabling SDK events and optional identifiers', () => {
//   const hooks = createHooks();
//   const loaded = loadProductionModule('src/components/superwall/OpenWhisprSuperwallProvider.tsx', {
//     react: { ...hooks.module, useMemo: (factory) => factory() },
//     'react/jsx-runtime': jsxRuntime,
//     'react-native': { Platform: { OS: 'ios' } },
//     'expo-superwall': { SuperwallProvider: 'SuperwallProvider' },
//     '@/lib/sentry': { Sentry: { captureException: () => undefined } },
//     './SuperwallEntitlementBridge': { SuperwallEntitlementBridge: 'SuperwallEntitlementBridge' },
//     './SuperwallGateProvider': {
//       DisabledSuperwallGateProvider: 'DisabledSuperwallGateProvider',
//       EnabledSuperwallGateProvider: 'EnabledSuperwallGateProvider',
//     },
//   });
//   const view = loaded.exports.OpenWhisprSuperwallProvider({ children: 'synthetic child' });
//   assert.equal(view.type, 'SuperwallProvider');
//   assert.equal(view.props.options.eventTrackingBehavior, 'none');
//   assert.equal(view.props.options.passIdentifiersToPlayStore, false);
//   assert.equal(view.props.options.enableExperimentalDeviceVariables, false);
//   assert.equal(view.props.options.testModeBehavior, 'never');
// });
//
test('Superwall compatibility provider renders children without loading the purchase SDK', () => {
  const loaded = loadProductionModule('src/components/superwall/OpenWhisprSuperwallProvider.tsx', {
    'react/jsx-runtime': jsxRuntime,
  });
  const view = loaded.exports.OpenWhisprSuperwallProvider({ children: 'local child' });
  assert.equal(view.props.children, 'local child');
  assert.deepEqual(loaded.dependencies, ['react/jsx-runtime']);
});
// Original purchase-enabled expectation retained for reference.
// test('Superwall reconciles entitlement status without sending usage or audience attributes', async () => {
//   const hooks = createHooks();
//   const usage = {
//     billingUserId: 'synthetic-billing-user',
//     isSubscribed: true,
//     wordsUsed: 100,
//     wordsRemaining: 900,
//     plan: 'pro',
//   };
//   const statuses = [];
//   let attributeUpdates = 0;
//   const load = async () => ({ status: 'skipped' });
//   const loaded = loadProductionModule('src/components/superwall/SuperwallEntitlementBridge.tsx', {
//     react: { ...hooks.module, useMemo: (factory) => factory() },
//     'expo-superwall': {
//       useSuperwall: (selector) => selector({ isConfigured: true, configurationError: null }),
//       useSuperwallEvents: () => undefined,
//       useUser: () => ({
//         user: { appUserId: usage.billingUserId },
//         identify: async () => undefined,
//         signOut: async () => undefined,
//         setSubscriptionStatus: async (status) => {
//           statuses.push(status);
//         },
//         update: async () => {
//           attributeUpdates++;
//         },
//       }),
//     },
//     '@/store/useAuthStore': {
//       useAuthStore: (selector) =>
//         selector({ user: { id: 'synthetic-user' }, isGuest: false, isInitialized: true }),
//     },
//     '@/store/useUsageStore': {
//       useUsageStore: Object.assign((selector) => selector({ usage, load }), {
//         getState: () => ({ load }),
//       }),
//     },
//     '@/lib/superwall': {
//       buildSuperwallSubscriptionStatus: () => ({ status: 'ACTIVE', entitlements: [{ id: 'pro' }] }),
//       serializeSuperwallSubscriptionStatus: (status) => JSON.stringify(status),
//     },
//     '@/lib/sentry': {
//       Sentry: { captureException: () => undefined, addBreadcrumb: () => undefined },
//     },
//     '@/lib/billingReconciliation': { reconcileStoreBilling: async () => undefined },
//   });
//   hooks.beginRender();
//   loaded.exports.SuperwallEntitlementBridge();
//   hooks.runEffects();
//   await new Promise((resolve) => setImmediate(resolve));
//   hooks.beginRender();
//   loaded.exports.SuperwallEntitlementBridge();
//   hooks.runEffects();
//   await new Promise((resolve) => setImmediate(resolve));
//   assert.equal(statuses.length, 1);
//   assert.equal(statuses[0].status, 'ACTIVE');
//   assert.equal(attributeUpdates, 0);
// });
//
test('Superwall entitlement bridge neither loads SDK nor fabricates an entitlement', () => {
  const loaded = loadProductionModule('src/components/superwall/SuperwallEntitlementBridge.tsx');
  assert.equal(loaded.exports.SuperwallEntitlementBridge(), null);
  assert.deepEqual(loaded.dependencies, []);
});
test('Privacy & Data hides analytics controls even when old settings enable them', () => {
  const hooks = createHooks();
  const configUpdates = [];
  const loaded = loadProductionModule('src/screens/PrivacyDataScreen.tsx', {
    react: hooks.module,
    'react/jsx-runtime': jsxRuntime,
    '@/components/ui/SettingsSection': {
      SettingsRow: 'SettingsRow',
      SettingsSection: 'SettingsSection',
    },
    '@/components/ui/SettingsScreen': { SettingsScreen: 'SettingsScreen' },
    '@/components/ui/SettingsSwitch': { SettingsSwitch: 'SettingsSwitch' },
    '@/store/useConfigStore': {
      useConfigStore: (selector) =>
        selector({
          config: { usageAnalyticsEnabled: true, cloudBackupEnabled: true },
          updateConfig: (updates) => configUpdates.push(updates),
        }),
    },
    '@/store/useAuthStore': {
      useAuthStore: (selector) => selector({ user: { id: 'synthetic-user' }, isGuest: false }),
    },
    '@/store/useNotesStore': {
      useNotesStore: (selector) =>
        selector({
          voiceProfiles: [],
          loadVoiceProfiles: () => undefined,
          deleteAllVoiceProfiles: () => undefined,
        }),
    },
    '@/store/useUsageStore': {
      useUsageStore: (selector) => selector({ usage: null, load: () => undefined }),
    },
    '@/sync/useSyncStore': {
      useSyncStore: () => ({
        status: 'idle',
        lastSyncAt: null,
        subscriptionRequired: false,
        policyBlocked: false,
      }),
    },
    '@/sync/syncEngine': { requestSync: () => undefined },
    '@/lib/utils': { safeHaptics: () => undefined, formatRelativeTime: () => '' },
    '@/lib/alerts': { confirmDestructive: () => undefined },
  });
  const view = loaded.exports.default();
  const rows = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node.type === 'SettingsRow') rows.push(node);
    visit(node.props?.children);
  }
  visit(view);
  assert.equal(
    rows.some((row) => row.props.title === 'Usage Analytics'),
    false,
  );
  const cloudBackup = rows.find((row) => row.props.title === 'Cloud Backup');
  // assert.ok(cloudBackup);
  // cloudBackup.props.rightElement.props.onValueChange(false);
  // assert.equal(configUpdates.length, 1);
  // assert.equal(configUpdates[0].cloudBackupEnabled, false);
  assert.equal(cloudBackup, undefined, 'official cloud-backup controls are retired');
  assert.equal(configUpdates.length, 0);
});

test('resolved Expo config disables official OTA and telemetry while preserving native features', () => {
  const baseConfig = JSON.parse(fs.readFileSync(path.join(mobileRoot, 'app.base.json'), 'utf8'));
  // Check both tuple and string plugin declarations, including an extra tuple form of AppsFlyer.
  baseConfig.expo.plugins.push(['react-native-appsflyer', { synthetic: true }]);
  const environments = loadProductionModule('config/openwhispr-environments.js').exports;
  const loaded = loadProductionModule('app.config.js', {
    fs: { existsSync: () => false },
    path,
    './app.base.json': baseConfig,
    './config/openwhispr-environments': environments,
  });
  const config = loaded.exports();
  const pluginNames = config.plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
  for (const name of [
    '@sentry/react-native/expo',
    'react-native-appsflyer',
    'expo-tracking-transparency',
  ]) {
    assert.equal(
      pluginNames.includes(name),
      false,
      `${name} must stay out of generated native config`,
    );
  }
  for (const name of [
    'expo-apple-authentication',
    'expo-router',
    'expo-sqlite',
    './plugins/keyboard-extension/withKeyboardExtension',
  ]) {
    assert.equal(pluginNames.includes(name), true, `${name} must remain enabled`);
  }
  // assert.equal(config.updates.url, baseConfig.expo.updates.url);
  assert.equal(config.updates.enabled, false);
  assert.equal(config.updates.checkAutomatically, 'NEVER');
  assert.equal(config.updates.url, baseConfig.expo.updates.url, 'upstream project metadata is preserved but inactive');
  assert.equal(config.runtimeVersion.policy, baseConfig.expo.runtimeVersion.policy);
});

test('Metro uses standard Expo config without importing Sentry build instrumentation', () => {
  const standardConfig = { resolver: { assetExts: ['png'] } };
  const loaded = loadProductionModule('metro.config.js', {
    'nativewind/metro': {
      withNativeWind: (config, options) => ({ ...config, cssInput: options.input }),
    },
    'expo/metro-config': {
      getDefaultConfig(directory) {
        assert.equal(directory, mobileRoot);
        return standardConfig;
      },
    },
  });
  assert.equal(loaded.exports.resolver.assetExts.includes('bin'), true);
  assert.equal(loaded.exports.resolver.assetExts.includes('mil'), true);
  assert.equal(loaded.exports.cssInput, './global.css');
  assert.equal(loaded.dependencies.includes('@sentry/react-native/metro'), false);
});
