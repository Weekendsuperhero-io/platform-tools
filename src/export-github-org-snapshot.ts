#!/usr/bin/env node

import { writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { Octokit } from "octokit";

const HELP_TEXT = `
Usage:
  pnpm run snapshot:org -- --org <org> [--out <file>] [--api-version <date>]

Options:
  --org <org>             Organization slug to snapshot
  --out <file>            Output JSON path (default: config/<org>.snapshot.org.json)
  --api-version <date>    GitHub API version header (default: 2026-03-10)
  --help                  Show this help text
`.trim();

interface CliArgs {
  org: string | null;
  outPath: string | null;
  apiVersion: string;
  help: boolean;
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };

const ORG_SETTINGS_KEYS = [
  "name",
  "description",
  "billing_email",
  "email",
  "blog",
  "company",
  "location",
  "twitter_username",
  "has_organization_projects",
  "has_repository_projects",
  "default_repository_permission",
  "members_can_create_repositories",
  "members_can_create_public_repositories",
  "members_can_create_private_repositories",
  "members_can_create_internal_repositories",
  "members_allowed_repository_creation_type",
  "members_can_create_pages",
  "members_can_create_public_pages",
  "members_can_create_private_pages",
  "members_can_fork_private_repositories",
  "web_commit_signoff_required",
  "default_repository_branch",
  "advanced_security_enabled_for_new_repositories",
  "dependabot_alerts_enabled_for_new_repositories",
  "dependabot_security_updates_enabled_for_new_repositories",
  "dependency_graph_enabled_for_new_repositories",
  "secret_scanning_enabled_for_new_repositories",
  "secret_scanning_push_protection_enabled_for_new_repositories",
  "secret_scanning_validity_checks_enabled"
] as const;

const SECURITY_CONFIGURATION_KEYS = [
  "name",
  "description",
  "advanced_security",
  "code_security",
  "secret_protection",
  "dependency_graph",
  "dependency_graph_autosubmit_action",
  "dependency_graph_autosubmit_action_options",
  "dependabot_alerts",
  "dependabot_security_updates",
  "dependabot_delegated_alert_dismissal",
  "code_scanning_options",
  "code_scanning_default_setup",
  "code_scanning_default_setup_options",
  "code_scanning_delegated_alert_dismissal",
  "secret_scanning",
  "secret_scanning_push_protection",
  "secret_scanning_delegated_bypass",
  "secret_scanning_delegated_bypass_options",
  "secret_scanning_validity_checks",
  "secret_scanning_non_provider_patterns",
  "secret_scanning_generic_secrets",
  "secret_scanning_delegated_alert_dismissal",
  "secret_scanning_extended_metadata",
  "private_vulnerability_reporting",
  "enforcement"
] as const;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP_TEXT);
    return;
  }

  if (!args.org) {
    throw new Error("--org is required");
  }

  const outputPath = resolve(args.outPath ?? `config/${args.org}.snapshot.org.json`);
  const octokit = createOctokit(args.apiVersion);

  const orgResponse = await octokit.request("GET /orgs/{org}", {
    org: args.org,
    headers: {
      "X-GitHub-Api-Version": args.apiVersion
    }
  });
  const orgData = asJsonObject(orgResponse.data);

  const settingsSnapshot = pickKeys(orgData, ORG_SETTINGS_KEYS);
  const rulesets = await getOrganizationRulesetsDetailed({ octokit, org: args.org, apiVersion: args.apiVersion });
  const actions = await getOrganizationActionsSnapshot({
    octokit,
    org: args.org,
    apiVersion: args.apiVersion,
    orgId: getRequiredNumber(orgData.id, "org.id")
  });
  const securityConfigurations = await getOrganizationSecurityConfigurationsSnapshot({
    octokit,
    org: args.org,
    apiVersion: args.apiVersion
  });

  const output: JsonObject = {
    apiVersion: args.apiVersion,
    org: {
      settings: settingsSnapshot,
      rulesets,
      actions,
      security_configurations: securityConfigurations
    }
  };

  const dirPath = dirname(outputPath);
  if (!existsSync(dirPath)) {
    throw new Error(`Output directory does not exist: ${dirPath}`);
  }

  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Wrote org snapshot: ${outputPath}`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    org: null,
    outPath: null,
    apiVersion: "2026-03-10",
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--org":
        args.org = requireValue(argv, ++index, "--org");
        break;
      case "--out":
        args.outPath = requireValue(argv, ++index, "--out");
        break;
      case "--api-version":
        args.apiVersion = requireValue(argv, ++index, "--api-version");
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

async function getOrganizationRulesetsDetailed(options: {
  octokit: Octokit;
  org: string;
  apiVersion: string;
}): Promise<JsonValue[]> {
  const list = await paginateArray(options.octokit, "GET /orgs/{org}/rulesets", {
    org: options.org,
    per_page: 100,
    headers: {
      "X-GitHub-Api-Version": options.apiVersion
    }
  });

  const results: JsonValue[] = [];
  for (const item of list) {
    const id = getRequiredNumber(asJsonObject(item).id, "ruleset.id");
    const detailResponse = await options.octokit.request("GET /orgs/{org}/rulesets/{ruleset_id}", {
      org: options.org,
      ruleset_id: id,
      headers: {
        "X-GitHub-Api-Version": options.apiVersion
      }
    });

    const detail = asJsonObject(detailResponse.data);
    results.push(
      pickObject(detail, ["name", "target", "enforcement", "bypass_actors", "conditions", "rules"])
    );
  }

  return results;
}

async function getOrganizationActionsSnapshot(options: {
  octokit: Octokit;
  org: string;
  orgId: number;
  apiVersion: string;
}): Promise<JsonObject> {
  const actions: JsonObject = {};

  const permissions = asJsonObject(
    await requestData(options.octokit, "GET /orgs/{org}/actions/permissions", {
      org: options.org,
      headers: {
        "X-GitHub-Api-Version": options.apiVersion
      }
    })
  );
  actions.permissions = pickObject(permissions, ["enabled_repositories", "allowed_actions", "sha_pinning_required"]);

  if (permissions.allowed_actions === "selected") {
    const selectedActions = asJsonObject(
      await requestData(options.octokit, "GET /orgs/{org}/actions/permissions/selected-actions", {
        org: options.org,
        headers: {
          "X-GitHub-Api-Version": options.apiVersion
        }
      })
    );
    actions.selected_actions = pickObject(selectedActions, [
      "github_owned_allowed",
      "verified_allowed",
      "patterns_allowed"
    ]);
  }

  const artifactRetention = asJsonObject(
    await requestData(options.octokit, "GET /orgs/{org}/actions/permissions/artifact-and-log-retention", {
      org: options.org,
      headers: {
        "X-GitHub-Api-Version": options.apiVersion
      }
    })
  );
  actions.artifact_and_log_retention = pickObject(artifactRetention, ["days"]);

  const forkApproval = asJsonObject(
    await requestData(options.octokit, "GET /orgs/{org}/actions/permissions/fork-pr-contributor-approval", {
      org: options.org,
      headers: {
        "X-GitHub-Api-Version": options.apiVersion
      }
    })
  );
  actions.fork_pr_contributor_approval = pickObject(forkApproval, ["approval_policy"]);

  const forkPrivateRepos = asJsonObject(
    await requestData(options.octokit, "GET /orgs/{org}/actions/permissions/fork-pr-workflows-private-repos", {
      org: options.org,
      headers: {
        "X-GitHub-Api-Version": options.apiVersion
      }
    })
  );
  actions.fork_pr_private_repos = pickObject(forkPrivateRepos, [
    "run_workflows_from_fork_pull_requests",
    "send_write_tokens_to_workflows",
    "send_secrets_and_variables",
    "require_approval_for_fork_pr_workflows"
  ]);

  const workflowPermissions = asJsonObject(
    await requestData(options.octokit, "GET /orgs/{org}/actions/permissions/workflow", {
      org: options.org,
      headers: {
        "X-GitHub-Api-Version": options.apiVersion
      }
    })
  );
  actions.workflow_permissions = pickObject(workflowPermissions, [
    "default_workflow_permissions",
    "can_approve_pull_request_reviews"
  ]);

  const selfHostedPolicy = asJsonObject(
    await requestData(options.octokit, "GET /orgs/{org}/actions/permissions/self-hosted-runners", {
      org: options.org,
      headers: {
        "X-GitHub-Api-Version": options.apiVersion
      }
    })
  );
  const selfHostedOutput = pickObject(selfHostedPolicy, ["enabled_repositories"]);

  if (selfHostedPolicy.enabled_repositories === "selected") {
    const selectedReposResponse = asJsonObject(
      await requestData(options.octokit, "GET /orgs/{org}/actions/permissions/self-hosted-runners/repositories", {
        org: options.org,
        headers: {
          "X-GitHub-Api-Version": options.apiVersion
        }
      })
    );

    const repositories = Array.isArray(selectedReposResponse.repositories)
      ? selectedReposResponse.repositories
      : [];

    const selectedRepositories = repositories
      .map((repo) => {
        const item = asJsonObject(repo);
        return typeof item.full_name === "string" ? item.full_name : null;
      })
      .filter((name): name is string => typeof name === "string")
      .sort();

    selfHostedOutput.selected_repositories = selectedRepositories;
  }

  actions.self_hosted_runners = selfHostedOutput;

  const cache: JsonObject = {};
  const cacheStorage = await requestDataOptional(
    options.octokit,
    "GET /organizations/{org}/actions/cache/storage-limit",
    {
      org: options.orgId,
      headers: {
        "X-GitHub-Api-Version": options.apiVersion
      }
    }
  );
  if (cacheStorage) {
    const storageObj = asJsonObject(cacheStorage);
    if (typeof storageObj.max_cache_size_gb === "number") {
      cache.max_cache_size_gb = storageObj.max_cache_size_gb;
    }
  }

  const cacheRetention = await requestDataOptional(
    options.octokit,
    "GET /organizations/{org}/actions/cache/retention-limit",
    {
      org: options.orgId,
      headers: {
        "X-GitHub-Api-Version": options.apiVersion
      }
    }
  );
  if (cacheRetention) {
    const retentionObj = asJsonObject(cacheRetention);
    if (typeof retentionObj.max_cache_retention_days === "number") {
      cache.max_cache_retention_days = retentionObj.max_cache_retention_days;
    }
  }

  if (Object.keys(cache).length > 0) {
    actions.cache = cache;
  }

  const runnerGroupsResponse = asJsonObject(
    await requestData(options.octokit, "GET /orgs/{org}/actions/runner-groups", {
      org: options.org,
      per_page: 100,
      headers: {
        "X-GitHub-Api-Version": options.apiVersion
      }
    })
  );

  const rawRunnerGroups = Array.isArray(runnerGroupsResponse.runner_groups)
    ? runnerGroupsResponse.runner_groups
    : [];

  const runnerGroups: JsonValue[] = [];
  for (const rawGroup of rawRunnerGroups) {
    const group = asJsonObject(rawGroup);
    const groupId = getRequiredNumber(group.id, "runner_group.id");

    const outputGroup = pickObject(group, [
      "name",
      "visibility",
      "allows_public_repositories",
      "restricted_to_workflows",
      "selected_workflows",
      "network_configuration_id"
    ]);

    if (group.visibility === "selected") {
      const reposResponse = asJsonObject(
        await requestData(options.octokit, "GET /orgs/{org}/actions/runner-groups/{runner_group_id}/repositories", {
          org: options.org,
          runner_group_id: groupId,
          per_page: 100,
          headers: {
            "X-GitHub-Api-Version": options.apiVersion
          }
        })
      );

      const repos = Array.isArray(reposResponse.repositories) ? reposResponse.repositories : [];
      const selectedRepositories = repos
        .map((repo) => {
          const item = asJsonObject(repo);
          return typeof item.full_name === "string" ? item.full_name : null;
        })
        .filter((name): name is string => typeof name === "string")
        .sort();

      outputGroup.selected_repositories = selectedRepositories;
    }

    runnerGroups.push(outputGroup);
  }

  actions.runner_groups = runnerGroups;

  return actions;
}

async function getOrganizationSecurityConfigurationsSnapshot(options: {
  octokit: Octokit;
  org: string;
  apiVersion: string;
}): Promise<JsonValue[]> {
  const list = await paginateArray(options.octokit, "GET /orgs/{org}/code-security/configurations", {
    org: options.org,
    per_page: 100,
    headers: {
      "X-GitHub-Api-Version": options.apiVersion
    }
  });

  const results: JsonValue[] = [];
  for (const item of list) {
    const id = getRequiredNumber(asJsonObject(item).id, "security_configuration.id");
    const detail = asJsonObject(
      await requestData(options.octokit, "GET /orgs/{org}/code-security/configurations/{configuration_id}", {
        org: options.org,
        configuration_id: id,
        headers: {
          "X-GitHub-Api-Version": options.apiVersion
        }
      })
    );

    results.push(pickKeys(detail, SECURITY_CONFIGURATION_KEYS));
  }

  return results;
}

async function requestData(
  octokit: Octokit,
  endpoint: string,
  params: Record<string, string | number | boolean | JsonValue>
): Promise<unknown> {
  const response = await octokit.request(endpoint, params);
  return response.data;
}

async function requestDataOptional(
  octokit: Octokit,
  endpoint: string,
  params: Record<string, string | number | boolean | JsonValue>
): Promise<unknown | null> {
  try {
    const response = await octokit.request(endpoint, params);
    return response.data;
  } catch (error: unknown) {
    if (isHttpError(error, 403) || isHttpError(error, 404)) {
      return null;
    }
    throw error;
  }
}

async function paginateArray(
  octokit: Octokit,
  endpoint: string,
  params: Record<string, string | number | boolean | JsonValue>
): Promise<unknown[]> {
  const results: unknown[] = [];
  let page = 1;

  while (true) {
    const response = await octokit.request(endpoint, {
      ...params,
      page,
      per_page: 100
    });

    if (!Array.isArray(response.data)) {
      throw new Error(`Expected array from ${endpoint}`);
    }

    results.push(...response.data);
    if (response.data.length < 100) {
      break;
    }

    page += 1;
  }

  return results;
}

function createOctokit(apiVersion: string): Octokit {
  const token = resolveAuthToken();
  if (!token) {
    throw new Error(
      "No GitHub token found. Set GITHUB_TOKEN or GH_TOKEN, or authenticate gh so `gh auth token` works."
    );
  }

  return new Octokit({
    auth: token,
    request: {
      headers: {
        "X-GitHub-Api-Version": apiVersion
      }
    }
  });
}

function resolveAuthToken(): string | null {
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) {
    return envToken;
  }

  const ghExecutable = resolveGhExecutable();
  if (!ghExecutable) {
    return null;
  }

  const result = spawnSync(ghExecutable, ["auth", "token"], {
    encoding: "utf8"
  });

  if (result.status !== 0) {
    return null;
  }

  const token = result.stdout.trim();
  return token.length > 0 ? token : null;
}

function resolveGhExecutable(): string | null {
  const explicitPath = process.env.GH_PATH;
  if (explicitPath) {
    return canExecuteGh(explicitPath) ? explicitPath : null;
  }

  if (canExecuteGh("gh")) {
    return "gh";
  }

  const pathEntries = (process.env.PATH ?? "")
    .split(process.platform === "win32" ? ";" : ":")
    .filter(Boolean);

  const commonInstallPaths = process.platform === "win32"
    ? [
        "C:\\Program Files\\GitHub CLI\\gh.exe",
        "C:\\Program Files (x86)\\GitHub CLI\\gh.exe"
      ]
    : [
        "/opt/homebrew/bin/gh",
        "/usr/local/bin/gh",
        "/usr/bin/gh"
      ];

  const candidates = [
    ...pathEntries.map((entry) => `${entry}${process.platform === "win32" ? "\\gh.exe" : "/gh"}`),
    ...commonInstallPaths
  ];

  for (const candidate of candidates) {
    if (canExecuteGh(candidate)) {
      return candidate;
    }
  }

  return null;
}

function canExecuteGh(candidate: string): boolean {
  if (candidate !== "gh" && !existsSync(candidate)) {
    return false;
  }

  const result = spawnSync(candidate, ["--version"], {
    encoding: "utf8"
  });

  return result.status === 0;
}

function asJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as JsonObject;
}

function pickKeys<T extends readonly string[]>(source: JsonObject, keys: T): JsonObject {
  const output: JsonObject = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function pickObject(source: JsonObject, keys: string[]): JsonObject {
  const output: JsonObject = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function getRequiredNumber(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return value;
}

function isHttpError(error: unknown, status: number): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const withStatus = error as Error & { status?: number };
  return withStatus.status === status;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
