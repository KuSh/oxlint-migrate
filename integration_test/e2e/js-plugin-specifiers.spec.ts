import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { loadESLintConfig } from '../../bin/config-loader.js';
import migrateConfig from '../../src/index.js';
import {
  deriveRulePrefix,
  UNRESOLVED_PLUGIN_SPECIFIER,
} from '../../src/jsPlugins.js';
import { DefaultReporter } from '../../src/reporter.js';
import type { OxlintConfig } from '../../src/types.js';
import {
  lintWithConfig,
  runOxlintWithConfig,
  withoutUnresolvedPlugins,
} from '../oxlint-runner.js';

// Full CLI path for JS plugins: load an ESLint config the way `bin/oxlint-migrate`
// does, migrate it, then hand the result to the real oxlint to prove it loads.
const fixtureDir = path.join(
  import.meta.dirname,
  '../fixtures/js-plugin-specifiers'
);

// The generated config is written here and handed to oxlint, so it is also the
// directory the plugin specifiers have to be relative to. `.temp` is already in the
// repository's ignore list.
const checkDir = path.join(fixtureDir, '.temp');

const migrateFixture = async (relativePath: string): Promise<OxlintConfig> => {
  const { config, pluginSpecifiers } = await loadESLintConfig(
    path.join(fixtureDir, relativePath),
    { specifierBaseDir: checkDir }
  );

  return migrateConfig(config.default, undefined, {
    reporter: new DefaultReporter(),
    jsPlugins: true,
    jsPluginSpecifiers: pluginSpecifiers,
  });
};

afterAll(() => {
  rmSync(checkDir, { recursive: true, force: true });
});

describe('migrating plugins with known specifiers', () => {
  let config: OxlintConfig;

  beforeAll(async () => {
    config = await migrateFixture('eslint.config.mjs');
  });

  test('registers local plugins under the alias, pointing at their file', () => {
    expect(config.jsPlugins).toContainEqual({
      name: 'mylocal',
      specifier: '../plugins/named.js',
    });
    expect(config.jsPlugins).toContainEqual({
      name: 'anon',
      specifier: '../plugins/anonymous.js',
    });
  });

  test('keeps the rule names the ESLint config used', () => {
    expect(config.rules?.['mylocal/no-named']).toBe('error');
    expect(config.rules?.['anon/no-anonymous']).toBe('warn');
    expect(config.rules?.['moka/no-exclusive-tests']).toBe('error');
  });

  test('registers npm plugins by package name', () => {
    expect(config.jsPlugins).toContainEqual({
      name: 'regexp',
      specifier: 'eslint-plugin-regexp',
    });
    expect(config.jsPlugins).toContainEqual({
      name: 'moka',
      specifier: 'eslint-plugin-mocha',
    });
    expect(config.jsPlugins).toContainEqual({
      name: '@stylistic',
      specifier: '@stylistic/eslint-plugin',
    });
  });

  test('every plugin rule has a matching jsPlugins entry', () => {
    const namespaces = new Set(
      (config.jsPlugins ?? []).map((entry) =>
        typeof entry === 'string' ? deriveRulePrefix(entry) : entry.name
      )
    );

    for (const rule of Object.keys(config.rules ?? {})) {
      const slash = rule.lastIndexOf('/');
      if (slash === -1) {
        continue; // core ESLint rule, implemented natively
      }
      const prefix = rule.slice(0, slash);
      if (namespaces.has(prefix)) {
        continue;
      }
      // Anything left has to be a plugin oxlint implements in Rust.
      expect(config.plugins ?? []).toContain(prefix);
    }
  });

  test('flags the plugins the config builds itself', () => {
    // `inline` has no module behind it, under either of the two aliases it is
    // registered with, so there is no specifier to write and the user has to supply
    // one. The rules are migrated regardless.
    expect(config.jsPlugins).toContainEqual({
      name: 'inline',
      specifier: UNRESOLVED_PLUGIN_SPECIFIER,
    });
    expect(config.jsPlugins).toContainEqual({
      name: 'local',
      specifier: UNRESOLVED_PLUGIN_SPECIFIER,
    });
    expect(config.rules?.['inline/no-inline']).toBe('error');
    expect(config.rules?.['local/no-inline']).toBe('error');
  });

  test('oxlint loads the generated config', () => {
    const result = runOxlintWithConfig(
      withoutUnresolvedPlugins(config),
      checkDir
    );

    expect(
      result.ok,
      `oxlint rejected the migrated config:\n${result.output}`
    ).toBe(true);
  });
});

describe('migrating a config that sits below the oxlint config', () => {
  let config: OxlintConfig;

  beforeAll(async () => {
    // Loaded once for the whole describe: Node caches module resolutions per
    // importer, so a second load of the same config would not reach the resolve
    // hook and would report no specifiers at all.
    config = await migrateFixture('nested/eslint.config.mjs');
  });

  test('rewrites the local plugin path for the output directory', () => {
    expect(config.jsPlugins).toStrictEqual([
      { name: 'mylocal', specifier: '../plugins/named.js' },
    ]);
    expect(runOxlintWithConfig(config, checkDir).ok).toBe(true);
  });

  test('reports the local plugin rule under the alias it was migrated to', () => {
    // `plugins/named.js` reports every identifier called `named`. Seeing that
    // diagnostic proves oxlint resolved the specifier, loaded the local plugin and
    // matched the migrated rule name to it.
    const output = lintWithConfig(config, checkDir, 'const named = 1;\n');

    expect(output).toContain('mylocal(no-named)');
  });
});
