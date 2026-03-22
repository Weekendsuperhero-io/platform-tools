#!/usr/bin/env node

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Octokit } from "octokit";

const HELP_TEXT = `
Usage:
  pnpm run apply:baseline -- --config <file> --repo <owner/name> [--dry-run] [--concurrency <n>]
  pnpm run apply:baseline -- --config <file> --repos-file <file> [--dry-run] [--concurrency <n>]
  pnpm run apply:baseline -- --config <file> --org <org> [--match <regex>] [--dry-run] [--concurrency <n>]

Options:
  --config <file>      Path to the baseline JSON file
  --repo <owner/name>  Target repository; may be provided multiple times
  --repos-file <file>  File containing owner/name values, one per line
  --org <org>          Apply to all eligible repositories in the organization
  --match <regex>      Filter org repositories by nameWithOwner
  --concurrency <n>    Number of repositories to process at once (default: 4)
  --dry-run            Print planned API calls without executing them
  --help               Show this help text
`.trim();

const REPO_SETTING_KEYS = new Set([
  "allow_auto_merge",
  "allow_forking",
  "allow_merge_commit",
  "allow_rebase_merge",
  "allow_squash_merge",
  "allow_update_branch",
  "archived",
  "default_branch",
  "delete_branch_on_merge",
  "description",
  "has_discussions",
  "has_downloads",
  "has_issues",
  "has_projects",
  "has_wiki",
  "homepage",
  "is_template",
  "merge_commit_message",
  "merge_commit_title",
  "name",
  "private",
  "security_and_analysis",
  "squash_merge_commit_message",
  "squash_merge_commit_title",
  "visibility",
  "web_commit_signoff_required"
]);

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };

type RepositorySettingKey =
  | "allow_auto_merge"
  | "allow_forking"
  | "allow_merge_commit"
  | "allow_rebase_merge"
  | "allow_squash_merge"
  | "allow_update_branch"
  | "archived"
  | "default_branch"
  | "delete_branch_on_merge"
  | "description"
  | "has_discussions"
  | "has_downloads"
  | "has_issues"
  | "has_projects"
  | "has_wiki"
  | "homepage"
  | "is_template"
  | "merge_commit_message"
  | "merge_commit_title"
  | "name"
  | "private"
  | "security_and_analysis"
  | "squash_merge_commit_message"
  | "squash_merge_commit_title"
  | "visibility"
  | "web_commit_signoff_required";

type RepositorySettings = Partial<Record<RepositorySettingKey, JsonValue>>;

interface DefaultBranchConfig {
  name: string;
  rename_existing?: boolean;
}

interface CodeScanningDefaultSetupConfig {
  state: "configured" | "not-configured";
  query_suite?: "default" | "extended";
  mode?: "public-only" | "eligible";
}

interface SecurityConfig {
  code_security?: boolean;
  vulnerability_alerts?: boolean;
  dependabot_security_updates?: boolean;
  code_scanning_default_setup?: CodeScanningDefaultSetupConfig;
}

interface RepositoryConfig {
  settings?: RepositorySettings;
  topics?: string[];
  default_branch?: DefaultBranchConfig;
  security?: SecurityConfig;
}

interface BaselineConfig {
  apiVersion: string;
  repository?: RepositoryConfig;
  orgRulesets?: JsonObject[];
  rulesets?: JsonObject[];
}

interface CliArgs {
  configPath: string | null;
  repos: string[];
  reposFile: string | null;
  org: string | null;
  match: string | null;
  concurrency: number;
  dryRun: boolean;
  help: boolean;
}

interface OrgRepo {
  nameWithOwner: string;
  archived: boolean;
  disabled: boolean;
  fork: boolean;
  is_template?: boolean;
}

interface ExistingRuleset {
  id: number;
  name: string;
  target?: string;
  source_type?: string;
}

interface RepoMetadata {
  default_branch: string | undefined;
  visibility: "public" | "private" | "internal" | undefined;
  archived: boolean;
  disabled: boolean;
  is_empty: boolean;
}

interface RepoRunResult {
  repo: string;
  success: boolean;
  error?: string;
}

type LogFn = (message: string) => void;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP_TEXT);
    return;
  }

  if (!args.configPath) {
    throw new Error("--config is required");
  }

  const configPath = resolve(args.configPath);
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const config = parseJsonFile<BaselineConfig>(configPath, "config");
  validateConfig(config, configPath);

  const octokit = createOctokit(args.dryRun, config.apiVersion);
  await runAuthPreflight({ args, config, octokit });
  if (Array.isArray(config.orgRulesets) && config.orgRulesets.length > 0 && !args.org) {
    throw new Error("Config contains orgRulesets but --org was not provided");
  }

  if (args.org && Array.isArray(config.orgRulesets) && config.orgRulesets.length > 0) {
    await applyOrganizationRulesets({
      org: args.org,
      config,
      dryRun: args.dryRun,
      octokit
    });
  }

  const targets = await resolveTargets(args, octokit);
  if (targets.length === 0) {
    throw new Error("No target repositories resolved");
  }

  console.log(`Using config: ${configPath}`);
  console.log(`Target repositories: ${targets.length}`);
  console.log(`Concurrency: ${args.concurrency}`);

  const results = await runWithConcurrency(targets, args.concurrency, async (repo) => {
    const logger = createRepoLogger(repo);

    try {
      await applyBaselineToRepo({ repo, config, dryRun: args.dryRun, octokit, log: logger.log });
      logger.flush();
      return { repo, success: true } satisfies RepoRunResult;
    } catch (error: unknown) {
      logger.log(`ERROR: ${getErrorMessage(error)}`);
      logger.flush();
      return { repo, success: false, error: getErrorMessage(error) } satisfies RepoRunResult;
    }
  });

  const failures = results.filter((result) => !result.success);
  if (failures.length > 0) {
    throw new Error(
      `Baseline run finished with ${failures.length} failed repos: ${failures.map((result) => result.repo).join(", ")}`
    );
  }
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    configPath: null,
    repos: [],
    reposFile: null,
    org: null,
    match: null,
    concurrency: 4,
    dryRun: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--config":
        args.configPath = requireValue(argv, ++index, "--config");
        break;
      case "--repo":
        args.repos.push(requireValue(argv, ++index, "--repo"));
        break;
      case "--repos-file":
        args.reposFile = requireValue(argv, ++index, "--repos-file");
        break;
      case "--org":
        args.org = requireValue(argv, ++index, "--org");
        break;
      case "--match":
        args.match = requireValue(argv, ++index, "--match");
        break;
      case "--concurrency":
        args.concurrency = parseConcurrency(requireValue(argv, ++index, "--concurrency"));
        break;
      case "--dry-run":
        args.dryRun = true;
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

function parseConcurrency(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid concurrency value: ${value}`);
  }
  return parsed;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseJsonFile<T>(path: string, label: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${label} JSON at ${path}: ${message}`);
  }
}

function validateConfig(config: BaselineConfig, configPath: string): void {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Config at ${configPath} must be a JSON object`);
  }

  if (!config.apiVersion || typeof config.apiVersion !== "string") {
    throw new Error("Config must contain apiVersion");
  }

  if (config.repository?.settings) {
    for (const key of Object.keys(config.repository.settings)) {
      if (!REPO_SETTING_KEYS.has(key)) {
        throw new Error(`Unsupported repository.settings key: ${key}`);
      }
    }
  }

  if (config.repository?.topics && !Array.isArray(config.repository.topics)) {
    throw new Error("repository.topics must be an array of strings");
  }

  if (config.repository?.default_branch) {
    if (typeof config.repository.default_branch.name !== "string" || config.repository.default_branch.name.length === 0) {
      throw new Error("repository.default_branch.name must be a non-empty string");
    }
  }

  if (config.rulesets && !Array.isArray(config.rulesets)) {
    throw new Error("rulesets must be an array");
  }

  if (config.orgRulesets && !Array.isArray(config.orgRulesets)) {
    throw new Error("orgRulesets must be an array");
  }
}

async function applyOrganizationRulesets(options: {
  org: string;
  config: BaselineConfig;
  dryRun: boolean;
  octokit: Octokit | null;
}): Promise<void> {
  const { org, config, dryRun, octokit } = options;
  const logger = createSectionLogger(`Organization rulesets (${org})`);
  const desiredRulesets = config.orgRulesets ?? [];

  const existingRulesets: ExistingRuleset[] = dryRun || !octokit
    ? []
    : await getOrganizationRulesets({ org, apiVersion: config.apiVersion, octokit });

  for (const desiredRuleset of desiredRulesets) {
    validateRuleset(desiredRuleset);

    const desiredTarget = getString(desiredRuleset.target) ?? "branch";
    const rulesetName = getRequiredString(desiredRuleset.name, "orgRulesets[].name");
    const existing = existingRulesets.find(
      (ruleset) =>
        ruleset.name === rulesetName &&
        (ruleset.target ?? "branch") === desiredTarget &&
        (ruleset.source_type === undefined || ruleset.source_type === "Organization")
    );

    try {
      if (existing) {
        await callApi({
          method: "PUT",
          endpoint: "PUT /orgs/{org}/rulesets/{ruleset_id}",
          routeParams: { org, ruleset_id: existing.id },
          payload: desiredRuleset,
          apiVersion: config.apiVersion,
          dryRun,
          label: `Update org ruleset "${rulesetName}"`,
          octokit,
          log: logger.log
        });
      } else {
        await callApi({
          method: "POST",
          endpoint: "POST /orgs/{org}/rulesets",
          routeParams: { org },
          payload: desiredRuleset,
          apiVersion: config.apiVersion,
          dryRun,
          label: `Create org ruleset "${rulesetName}"`,
          octokit,
          log: logger.log
        });
      }
    } catch (error: unknown) {
      throw orgRulesetErrorWithContext(org, error);
    }
  }

  logger.flush();
}

function createOctokit(dryRun: boolean, apiVersion: string): Octokit | null {
  const token = resolveAuthToken();
  if (!token) {
    if (dryRun) {
      return null;
    }
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

async function runAuthPreflight(options: {
  args: CliArgs;
  config: BaselineConfig;
  octokit: Octokit | null;
}): Promise<void> {
  const { args, config, octokit } = options;
  if (args.dryRun) {
    return;
  }

  if (!octokit) {
    throw new Error("GitHub API client is not initialized");
  }

  const ghExecutable = resolveGhExecutable();
  if (ghExecutable) {
    const status = spawnSync(ghExecutable, ["auth", "status"], {
      encoding: "utf8"
    });

    if (status.status !== 0 && !process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
      throw new Error(
        [
          "gh auth status failed and no GITHUB_TOKEN/GH_TOKEN is set.",
          "Run one of:",
          "- gh auth login -h github.com",
          "- gh auth refresh -h github.com -s repo,read:org,admin:org"
        ].join("\n")
      );
    }
  } else if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
    throw new Error(
      [
        "No gh executable found and no GITHUB_TOKEN/GH_TOKEN is set.",
        "Set GITHUB_TOKEN or GH_TOKEN, or install/authenticate GitHub CLI."
      ].join("\n")
    );
  }

  if (args.org && Array.isArray(config.orgRulesets) && config.orgRulesets.length > 0) {
    await assertOrgRulesetAccess({
      org: args.org,
      apiVersion: config.apiVersion,
      octokit
    });
  }
}

async function assertOrgRulesetAccess(options: {
  org: string;
  apiVersion: string;
  octokit: Octokit;
}): Promise<void> {
  try {
    await options.octokit.request("GET /orgs/{org}/rulesets", {
      org: options.org,
      per_page: 1,
      page: 1,
      headers: {
        "X-GitHub-Api-Version": options.apiVersion
      }
    });
  } catch (error: unknown) {
    if (isHttpError(error, 403) || isHttpError(error, 404)) {
      throw new Error(
        [
          `Token cannot access organization rulesets for "${options.org}".`,
          "Ensure the auth principal is an org admin/owner and refresh scopes/permissions.",
          "For GitHub CLI classic scopes:",
          "- gh auth refresh -h github.com -s repo,read:org,admin:org",
          `Original error: ${getErrorMessage(error)}`
        ].join("\n")
      );
    }
    throw error;
  }
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
  return token ? token : null;
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

  const candidates = [...pathEntries.map((entry) => `${entry}${process.platform === "win32" ? "\\gh.exe" : "/gh"}`), ...commonInstallPaths];
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

async function resolveTargets(args: CliArgs, octokit: Octokit | null): Promise<string[]> {
  const targets = new Set<string>();

  for (const repo of args.repos) {
    validateRepoSlug(repo);
    targets.add(repo);
  }

  if (args.reposFile) {
    const reposFilePath = resolve(args.reposFile);
    if (!existsSync(reposFilePath)) {
      throw new Error(`Repos file not found: ${reposFilePath}`);
    }

    const lines = readFileSync(reposFilePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));

    for (const repo of lines) {
      validateRepoSlug(repo);
      targets.add(repo);
    }
  }

  if (args.org) {
    if (!octokit) {
      throw new Error("--org requires GitHub authentication even in dry-run mode");
    }

    const matcher = args.match ? new RegExp(args.match) : null;
    const repos = await listOrgRepos(octokit, args.org);
    for (const repo of repos) {
      if (repo.archived || repo.disabled || repo.fork || repo.is_template) {
        continue;
      }
      if (matcher && !matcher.test(repo.nameWithOwner)) {
        continue;
      }
      targets.add(repo.nameWithOwner);
    }
  }

  return [...targets].sort();
}

function validateRepoSlug(repo: string): void {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error(`Invalid repository slug: ${repo}`);
  }
}

async function listOrgRepos(octokit: Octokit, org: string): Promise<OrgRepo[]> {
  const repos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org,
    per_page: 100,
    type: "all"
  });

  return repos.map((repo) => ({
    nameWithOwner: repo.full_name,
    archived: repo.archived ?? false,
    disabled: repo.disabled ?? false,
    fork: repo.fork,
    is_template: repo.is_template ?? false
  }));
}

async function applyBaselineToRepo(options: {
  repo: string;
  config: BaselineConfig;
  dryRun: boolean;
  octokit: Octokit | null;
  log: LogFn;
}): Promise<void> {
  const { repo, config, dryRun, octokit, log } = options;
  const [owner, name] = repo.split("/");

  if (!owner || !name) {
    throw new Error(`Invalid repository slug: ${repo}`);
  }

  const metadata = !octokit
    ? null
    : await getRepositoryMetadata({ owner, repo: name, octokit });

  if (config.repository?.default_branch) {
    await ensureDefaultBranch({
      owner,
      repo: name,
      desired: config.repository.default_branch,
      metadata,
      apiVersion: config.apiVersion,
      dryRun,
      octokit,
      log
    });
  }

  const repositorySettings = { ...(config.repository?.settings ?? {}) };

  if (Object.keys(repositorySettings).length > 0) {
    await callApi({
      method: "PATCH",
      endpoint: "PATCH /repos/{owner}/{repo}",
      routeParams: { owner, repo: name },
      payload: repositorySettings,
      apiVersion: config.apiVersion,
      dryRun,
      label: "Update repository settings",
      octokit,
      log
    });
  }

  if (Array.isArray(config.repository?.topics)) {
    await callApi({
      method: "PUT",
      endpoint: "PUT /repos/{owner}/{repo}/topics",
      routeParams: { owner, repo: name },
      payload: { names: config.repository.topics },
      apiVersion: config.apiVersion,
      dryRun,
      label: "Replace repository topics",
      octokit,
      log
    });
  }

  if (config.repository?.security) {
    await applyRepositorySecurity({
      owner,
      repo: name,
      security: config.repository.security,
      metadata,
      apiVersion: config.apiVersion,
      dryRun,
      octokit,
      log
    });
  }

  if (Array.isArray(config.rulesets) && config.rulesets.length > 0) {
    const existingRulesets: ExistingRuleset[] = dryRun || !octokit
      ? []
      : await getRepositoryRulesets({ owner, name, apiVersion: config.apiVersion, octokit });

    for (const desiredRuleset of config.rulesets) {
      validateRuleset(desiredRuleset);

      const desiredTarget = getString(desiredRuleset.target) ?? "branch";
      const rulesetName = getRequiredString(desiredRuleset.name, "ruleset.name");
      const existing = existingRulesets.find(
        (ruleset) =>
          ruleset.name === rulesetName &&
          (ruleset.target ?? "branch") === desiredTarget &&
          (ruleset.source_type === undefined || ruleset.source_type === "Repository")
      );

      if (existing) {
        await callApi({
          method: "PUT",
          endpoint: "PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}",
          routeParams: { owner, repo: name, ruleset_id: existing.id },
          payload: desiredRuleset,
          apiVersion: config.apiVersion,
          dryRun,
          label: `Update ruleset "${rulesetName}"`,
          octokit,
          log
        });
      } else {
        await callApi({
          method: "POST",
          endpoint: "POST /repos/{owner}/{repo}/rulesets",
          routeParams: { owner, repo: name },
          payload: desiredRuleset,
          apiVersion: config.apiVersion,
          dryRun,
          label: `Create ruleset "${rulesetName}"`,
          octokit,
          log
        });
      }
    }
  }
}

async function getRepositoryMetadata(options: {
  owner: string;
  repo: string;
  octokit: Octokit;
}): Promise<RepoMetadata> {
  const response = await options.octokit.rest.repos.get({
    owner: options.owner,
    repo: options.repo
  });

  return {
    default_branch: response.data.default_branch ?? undefined,
    visibility: (response.data.visibility as RepoMetadata["visibility"]) ?? undefined,
    archived: response.data.archived ?? false,
    disabled: response.data.disabled ?? false,
    is_empty: response.data.pushed_at === null || (response.data.size ?? 0) === 0
  };
}

async function ensureDefaultBranch(options: {
  owner: string;
  repo: string;
  desired: DefaultBranchConfig;
  metadata: RepoMetadata | null;
  apiVersion: string;
  dryRun: boolean;
  octokit: Octokit | null;
  log: LogFn;
}): Promise<void> {
  const { owner, repo, desired, metadata, apiVersion, dryRun, octokit, log } = options;
  const desiredName = desired.name;
  const currentDefaultBranch = metadata?.default_branch;

  if (metadata?.is_empty) {
    log(`Skip default branch normalization: ${owner}/${repo} is empty`);
    return;
  }

  if (!currentDefaultBranch || currentDefaultBranch === desiredName) {
    return;
  }

  const targetBranchExists = !octokit
    ? false
    : await branchExists({ owner, repo, branch: desiredName, octokit });

  if (targetBranchExists) {
    await callApi({
      method: "PATCH",
      endpoint: "PATCH /repos/{owner}/{repo}",
      routeParams: { owner, repo },
      payload: { default_branch: desiredName },
      apiVersion,
      dryRun,
      label: `Switch default branch to "${desiredName}"`,
      octokit,
      log
    });
    return;
  }

  if (!desired.rename_existing) {
    throw new Error(
      `Repository ${owner}/${repo} does not have a "${desiredName}" branch and rename_existing is false`
    );
  }

  await callApi({
    method: "POST",
    endpoint: "POST /repos/{owner}/{repo}/branches/{branch}/rename",
    routeParams: { owner, repo, branch: currentDefaultBranch },
    payload: { new_name: desiredName },
    apiVersion,
    dryRun,
    label: `Rename default branch "${currentDefaultBranch}" to "${desiredName}"`,
    octokit,
    log
  });
}

async function branchExists(options: {
  owner: string;
  repo: string;
  branch: string;
  octokit: Octokit;
}): Promise<boolean> {
  try {
    await options.octokit.rest.repos.getBranch({
      owner: options.owner,
      repo: options.repo,
      branch: options.branch
    });
    return true;
  } catch (error: unknown) {
    if (isHttpError(error, 404)) {
      return false;
    }
    throw error;
  }
}

async function applyRepositorySecurity(options: {
  owner: string;
  repo: string;
  security: SecurityConfig;
  metadata: RepoMetadata | null;
  apiVersion: string;
  dryRun: boolean;
  octokit: Octokit | null;
  log: LogFn;
}): Promise<void> {
  const { owner, repo, security, metadata, apiVersion, dryRun, octokit, log } = options;

  if (typeof security.code_security === "boolean") {
    const codeSecurityStatus = security.code_security ? "enabled" : "disabled";

    try {
      await callApi({
        method: "PATCH",
        endpoint: "PATCH /repos/{owner}/{repo}",
        routeParams: { owner, repo },
        payload: {
          security_and_analysis: {
            code_security: {
              status: codeSecurityStatus
            }
          }
        },
        apiVersion,
        dryRun,
        label: `${security.code_security ? "Enable" : "Disable"} GitHub Code Security`,
        octokit,
        log
      });
    } catch (error: unknown) {
      if (isHttpError(error, 403) || isHttpError(error, 422)) {
        log(
          `Skip ${security.code_security ? "enabling" : "disabling"} GitHub Code Security: ${getErrorMessage(error)}`
        );
      } else {
        throw error;
      }
    }
  }

  if (security.vulnerability_alerts) {
    await callApi({
      method: "PUT",
      endpoint: "PUT /repos/{owner}/{repo}/vulnerability-alerts",
      routeParams: { owner, repo },
      payload: {},
      apiVersion,
      dryRun,
      label: "Enable vulnerability alerts and dependency graph",
      octokit,
      log
    });
  }

  if (security.dependabot_security_updates) {
    await callApi({
      method: "PUT",
      endpoint: "PUT /repos/{owner}/{repo}/automated-security-fixes",
      routeParams: { owner, repo },
      payload: {},
      apiVersion,
      dryRun,
      label: "Enable Dependabot security updates",
      octokit,
      log
    });
  }

  if (security.code_scanning_default_setup) {
    const desiredState = security.code_scanning_default_setup.state;
    const mode = security.code_scanning_default_setup.mode ?? "eligible";
    const visibility = metadata?.visibility;

    // Low-cost profile: when code security is explicitly disabled, default setup is implicitly off.
    // Skip this API call to avoid GitHub's "Code Security must be enabled" error noise.
    if (desiredState === "not-configured" && security.code_security === false) {
      log("Skip code scanning default setup: code security is disabled by policy");
      return;
    }

    if (desiredState === "configured" && mode === "public-only" && visibility && visibility !== "public") {
      log("Skip code scanning default setup: repository is not public");
      return;
    }

    try {
      await callApi({
        method: "PATCH",
        endpoint: "PATCH /repos/{owner}/{repo}/code-scanning/default-setup",
        routeParams: { owner, repo },
        payload: {
          state: desiredState,
          ...(desiredState === "configured" && security.code_scanning_default_setup.query_suite
            ? { query_suite: security.code_scanning_default_setup.query_suite }
            : {})
        },
        apiVersion,
        dryRun,
        label:
          desiredState === "configured"
            ? "Configure code scanning default setup"
            : "Disable code scanning default setup",
        octokit,
        log
      });
    } catch (error: unknown) {
      if (isHttpError(error, 403) || isHttpError(error, 422)) {
        log(`Skip code scanning default setup: ${getErrorMessage(error)}`);
        return;
      }
      throw error;
    }
  }
}

async function getRepositoryRulesets(options: {
  owner: string;
  name: string;
  apiVersion: string;
  octokit: Octokit;
}): Promise<ExistingRuleset[]> {
  const allRulesets: ExistingRuleset[] = [];
  let page = 1;

  while (true) {
    const response = await options.octokit.request("GET /repos/{owner}/{repo}/rulesets", {
      owner: options.owner,
      repo: options.name,
      per_page: 100,
      page,
      headers: {
        "X-GitHub-Api-Version": options.apiVersion
      }
    });

    if (!Array.isArray(response.data)) {
      throw new Error(`Expected rulesets array for ${options.owner}/${options.name}`);
    }

    allRulesets.push(...(response.data as ExistingRuleset[]));
    if (response.data.length < 100) {
      break;
    }

    page += 1;
  }

  return allRulesets;
}

async function getOrganizationRulesets(options: {
  org: string;
  apiVersion: string;
  octokit: Octokit;
}): Promise<ExistingRuleset[]> {
  const allRulesets: ExistingRuleset[] = [];
  let page = 1;

  try {
    while (true) {
      const response = await options.octokit.request("GET /orgs/{org}/rulesets", {
        org: options.org,
        per_page: 100,
        page,
        headers: {
          "X-GitHub-Api-Version": options.apiVersion
        }
      });

      if (!Array.isArray(response.data)) {
        throw new Error(`Expected organization rulesets array for ${options.org}`);
      }

      allRulesets.push(...(response.data as ExistingRuleset[]));
      if (response.data.length < 100) {
        break;
      }

      page += 1;
    }
  } catch (error: unknown) {
    throw orgRulesetErrorWithContext(options.org, error);
  }

  return allRulesets;
}

function validateRuleset(ruleset: JsonObject): void {
  if (!ruleset || typeof ruleset !== "object" || Array.isArray(ruleset)) {
    throw new Error("Each ruleset must be an object");
  }

  const name = getString(ruleset.name);
  if (!name) {
    throw new Error("Each ruleset must have a name");
  }

  if (!Array.isArray(ruleset.rules) || ruleset.rules.length === 0) {
    throw new Error(`Ruleset "${name}" must define at least one rule`);
  }
}

async function callApi(options: {
  method: string;
  endpoint: string;
  routeParams: Record<string, string | number>;
  payload: JsonObject | null | undefined;
  apiVersion: string;
  dryRun: boolean;
  label: string;
  octokit: Octokit | null;
  log: LogFn;
  quiet?: boolean;
}): Promise<unknown> {
  const { method, endpoint, routeParams, payload, apiVersion, dryRun, label, octokit, log, quiet = false } = options;

  if (dryRun) {
    if (!quiet) {
      log(`[dry-run] ${label}`);
      log(`  ${method} ${renderEndpoint(endpoint, routeParams)}`);
      if (payload) {
        log(indentJson(payload, 2));
      }
    }
    return null;
  }

  if (!octokit) {
    throw new Error("GitHub client is not initialized");
  }

  if (!quiet) {
    log(label);
  }

  const response = await octokit.request(endpoint, {
    ...routeParams,
    ...(payload ?? {}),
    headers: {
      "X-GitHub-Api-Version": apiVersion
    }
  });

  return response.data;
}

function renderEndpoint(endpoint: string, routeParams: Record<string, string | number>): string {
  return endpoint
    .replace(/^[A-Z]+\s+/, "")
    .replace(/\{([^}]+)\}/g, (_, key: string) => String(routeParams[key] ?? `{${key}}`));
}

function indentJson(value: JsonObject, spaces: number): string {
  return JSON.stringify(value, null, spaces)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function getString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getRequiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function isHttpError(error: unknown, status: number): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const errorWithStatus = error as Error & { status?: number };
  return errorWithStatus.status === status;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function orgRulesetErrorWithContext(org: string, error: unknown): Error {
  if (isHttpError(error, 404) || isHttpError(error, 403)) {
    return new Error(
      [
        `Organization rulesets API is not accessible for "${org}".`,
        "Common causes:",
        "- token/user is not an organization admin or owner",
        "- token lacks org administration permission/scope",
        "- organization rulesets are not available for this org plan",
        `Original error: ${getErrorMessage(error)}`
      ].join("\n")
    );
  }

  return new Error(getErrorMessage(error));
}

function createRepoLogger(repo: string): { log: LogFn; flush: () => void } {
  const lines: string[] = [];

  return {
    log: (message: string) => {
      lines.push(message);
    },
    flush: () => {
      console.log(`\n==> ${repo}`);
      for (const line of lines) {
        console.log(line);
      }
    }
  };
}

function createSectionLogger(title: string): { log: LogFn; flush: () => void } {
  const lines: string[] = [];

  return {
    log: (message: string) => {
      lines.push(message);
    },
    flush: () => {
      console.log(`\n==> ${title}`);
      for (const line of lines) {
        console.log(line);
      }
    }
  };
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await worker(items[currentIndex]!, currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
