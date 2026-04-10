#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(THIS_FILE), "..");
const API_VERSION = "2026-03-10";
const PROFILE_ORDER = [
  "public-max",
  "private-team-free",
  "private-team-paid",
  "private-team-requires-ghec"
];

const checkOnly = process.argv.includes("--check");

typecheck();

const repoRepository = readJson("config/sources/repo.shared.json");
const orgRulesets = readJson("config/sources/org.default-rulesets.json");
const orgSettings = readJson("config/sources/org.settings.json");
const orgActions = readJson("config/sources/org.actions.json");
const orgPackages = readJson("config/sources/org.packages.json");
const orgSecurityConfigurationsByProfile = readJson("config/sources/org.security-configurations.json");
const securityProfiles = readJson("config/sources/security-profiles.json");

const generatedFiles = [];

for (const profileName of PROFILE_ORDER) {
  const profile = securityProfiles[profileName];
  if (!isObject(profile)) {
    throw new Error(`Missing profile definition for "${profileName}" in config/sources/security-profiles.json`);
  }

  if (!isObject(profile.security)) {
    throw new Error(
      `Profile "${profileName}" must define a "security" object in config/sources/security-profiles.json`
    );
  }

  generatedFiles.push(
    ...buildProfileFiles({
      outputName: profileName,
      repoRepository,
      orgRulesets,
      orgSettings,
      orgActions,
      orgPackages,
      orgSecurityConfigurations: getProfileSecurityConfigurations(orgSecurityConfigurationsByProfile, profileName),
      security: profile.security
    })
  );
}

const privateTeamFreeSecurity = getProfileSecurity(securityProfiles, "private-team-free");
const baselineRepositoryConfig = buildRepositoryConfig(repoRepository, privateTeamFreeSecurity);
const baselineOrgConfig = buildOrgConfig(
  orgRulesets,
  orgSettings,
  orgActions,
  orgPackages,
  getProfileSecurityConfigurations(orgSecurityConfigurationsByProfile, "private-team-free")
);

generatedFiles.push(
  {
    path: "config/baseline.repo.example.json",
    content: {
      apiVersion: API_VERSION,
      repo: {
        repository: baselineRepositoryConfig
      }
    }
  },
  {
    path: "config/baseline.org.example.json",
    content: {
      apiVersion: API_VERSION,
      org: baselineOrgConfig
    }
  },
  {
    path: "config/baseline.example.json",
    content: {
      apiVersion: API_VERSION,
      repo: {
        repository: baselineRepositoryConfig
      },
      org: baselineOrgConfig
    }
  },
  ...buildProfileFiles({
    outputName: "security-low-cost",
    repoRepository,
    orgRulesets,
    orgSettings,
    orgActions,
    orgPackages,
    orgSecurityConfigurations: getProfileSecurityConfigurations(orgSecurityConfigurationsByProfile, "private-team-free"),
    security: privateTeamFreeSecurity
  })
);

const driftedFiles = [];

for (const file of generatedFiles) {
  const absolutePath = resolve(ROOT, file.path);
  const serialized = serializeJson(file.content);

  if (checkOnly) {
    const current = readRaw(absolutePath);
    if (current !== serialized) {
      driftedFiles.push(file.path);
    }
    continue;
  }

  writeFileSync(absolutePath, serialized, "utf8");
  process.stdout.write(`generated ${file.path}\n`);
}

if (checkOnly) {
  if (driftedFiles.length > 0) {
    process.stderr.write("Generated configs are out of date:\n");
    for (const path of driftedFiles) {
      process.stderr.write(`- ${path}\n`);
    }
    process.stderr.write("Run: node scripts/generate-configs.mjs\n");
    process.exitCode = 1;
  } else {
    process.stdout.write("All generated configs are up to date.\n");
  }
}

function typecheck() {
  if (typeof process !== "object" || !Array.isArray(process.argv)) {
    throw new Error("Unexpected runtime environment");
  }
}

function readJson(relativePath) {
  const absolutePath = resolve(ROOT, relativePath);
  try {
    return JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON: ${relativePath}: ${message}`);
  }
}

function readRaw(absolutePath) {
  try {
    return readFileSync(absolutePath, "utf8");
  } catch {
    return "";
  }
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function buildProfileFiles(options) {
  const {
    outputName,
    repoRepository,
    orgRulesets,
    orgSettings,
    orgActions,
    orgPackages,
    orgSecurityConfigurations,
    security
  } = options;
  const repositoryConfig = buildRepositoryConfig(repoRepository, security);
  const orgConfig = buildOrgConfig(orgRulesets, orgSettings, orgActions, orgPackages, orgSecurityConfigurations);

  return [
    {
      path: `config/${outputName}.repo.json`,
      content: {
        apiVersion: API_VERSION,
        repo: {
          repository: repositoryConfig
        }
      }
    },
    {
      path: `config/${outputName}.org.json`,
      content: {
        apiVersion: API_VERSION,
        org: orgConfig
      }
    },
    {
      path: `config/${outputName}.json`,
      content: {
        apiVersion: API_VERSION,
        repo: {
          repository: repositoryConfig
        },
        org: orgConfig
      }
    }
  ];
}

function buildRepositoryConfig(repoRepository, security) {
  return {
    ...clone(repoRepository),
    security: clone(security)
  };
}

function buildOrgConfig(orgRulesets, orgSettings, orgActions, orgPackages, orgSecurityConfigurations) {
  return {
    rulesets: clone(orgRulesets),
    settings: clone(orgSettings),
    actions: clone(orgActions),
    packages: clone(orgPackages),
    security_configurations: clone(orgSecurityConfigurations)
  };
}

function getProfileSecurity(profiles, name) {
  const profile = profiles[name];
  if (!isObject(profile) || !isObject(profile.security)) {
    throw new Error(`Missing profile security for "${name}"`);
  }
  return profile.security;
}

function getProfileSecurityConfigurations(profiles, name) {
  if (Array.isArray(profiles[name])) {
    const configurations = profiles[name];
    for (const [index, configuration] of configurations.entries()) {
      if (!isObject(configuration)) {
        throw new Error(`Org security configuration "${name}" at index ${index} must be an object`);
      }
    }
    return configurations;
  }

  if (!isObject(profiles) || !isObject(profiles.templates) || !isObject(profiles.profiles)) {
    throw new Error(
      "org.security-configurations source must define either profile arrays or a { templates, profiles } object"
    );
  }

  const profileTemplateKeys = profiles.profiles[name];
  if (!Array.isArray(profileTemplateKeys)) {
    throw new Error(`Missing org security configuration profile mapping for "${name}"`);
  }

  return profileTemplateKeys.map((templateKey, index) => {
    if (typeof templateKey !== "string" || templateKey.length === 0) {
      throw new Error(`Invalid template key in org security profile "${name}" at index ${index}`);
    }

    const template = profiles.templates[templateKey];
    if (!isObject(template)) {
      throw new Error(`Missing org security configuration template "${templateKey}" for profile "${name}"`);
    }

    return clone(template);
  });
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
