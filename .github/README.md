# Reusable GitHub Workflows

This directory contains reusable workflows that can be called from other repositories as thin shims.

## Available Workflows

| Workflow       | File                          | Purpose                                                  |
| -------------- | ----------------------------- | -------------------------------------------------------- |
| Rust CI        | `reusable-rust-ci.yml`        | Shared Rust CI checks, docs, and optional target builds  |
| Rust Release   | `reusable-rust-release.yml`   | Shared Rust release validation, packaging, release, and crates publish |

## Quick Start

### 1. Rust CI (Reusable)

Add this to your consuming repo at `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci:
    uses: weekendsuperhero-io/platform-tools/.github/workflows/reusable-rust-ci.yml@main
    with:
      check-os-json: '["ubuntu-latest","macos-latest","windows-latest"]'
      rust-cache-provider: github
      docs-os: ubuntu-latest
      linux-packages: "libdbus-1-dev pkg-config"
      build-matrix-json: "[]"
```

`eventkit-rs` style target builds in CI:

```yaml
jobs:
  ci:
    uses: weekendsuperhero-io/platform-tools/.github/workflows/reusable-rust-ci.yml@main
    with:
      check-os-json: '["macos-latest"]'
      rust-cache-provider: warpbuild
      docs-os: macos-latest
      build-matrix-json: >-
        [
          {"os":"macos-latest","target":"x86_64-apple-darwin","cargo_args":"--release"},
          {"os":"macos-latest","target":"aarch64-apple-darwin","cargo_args":"--release"}
        ]
```

### 2. Rust Release (Reusable)

Add this to your consuming repo at `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags:
      - "v*"

jobs:
  release:
    uses: weekendsuperhero-io/platform-tools/.github/workflows/reusable-rust-release.yml@main
    with:
      validate-runs-on: ubuntu-latest
      rust-cache-provider: github
      validate-linux-packages: "libdbus-1-dev pkg-config"
      # Optional override if binary cannot be inferred from Cargo.toml
      # binary-name: agentmail
      binary-matrix-json: >-
        [
          {"name":"linux-x86_64","os":"ubuntu-latest","target":"x86_64-unknown-linux-gnu"},
          {"name":"linux-aarch64","os":"ubuntu-24.04-arm","target":"aarch64-unknown-linux-gnu"},
          {"name":"macos-x86_64","os":"macos-latest","target":"x86_64-apple-darwin"},
          {"name":"macos-aarch64","os":"macos-latest","target":"aarch64-apple-darwin"},
          {"name":"windows-x86_64","os":"windows-latest","target":"x86_64-pc-windows-msvc"}
        ]
      enable-macos-universal: true
      # Optional overrides if your artifact names differ:
      # macos-universal-arm64-artifact: macos-aarch64
      # macos-universal-x86_64-artifact: macos-x86_64
      publish-crates-io: true
      cargo-publish-command: cargo publish -p agentmail
    secrets: inherit
```

## Configuration Options

### Rust CI Workflow

| Input                             | Default                                      | Description                                              |
| --------------------------------- | -------------------------------------------- | -------------------------------------------------------- |
| `rust-toolchain`                  | `stable`                                     | Rust version/toolchain                                   |
| `rust-cache-provider`             | `github`                                     | Rust cache backend provider (`github` or `warpbuild`)    |
| `check-os-json`                   | `["ubuntu-latest"]`                          | Runner matrix for fmt/clippy/build/test                  |
| `docs-os`                         | `ubuntu-latest`                              | Runner for docs job                                      |
| `linux-packages`                  | _(empty)_                                    | Linux apt packages installed where needed                |
| `fmt-command`                     | `cargo fmt --all -- --check`                | Format check command                                     |
| `clippy-command`                  | `cargo clippy --all-targets --all-features -- -D warnings` | Clippy command                               |
| `build-command`                   | `cargo build --all-features`                | Build command                                            |
| `test-command`                    | `cargo test --all-features`                 | Test command                                             |
| `run-docs`                        | `true`                                       | Enable docs job                                          |
| `docs-command`                    | `cargo doc --no-deps --all-features`        | Docs command (`RUSTDOCFLAGS=-D warnings` is applied)     |
| `build-matrix-json`               | `[]`                                         | Optional target build matrix (JSON array)                |
| `build-matrix-default-cargo-args` | `--release`                                  | Fallback cargo args for build matrix entries             |

### Rust Release Workflow

| Input                               | Default                     | Description                                                |
| ----------------------------------- | --------------------------- | ---------------------------------------------------------- |
| `manifest-path`                     | `Cargo.toml`                | Manifest path used to infer binary name                    |
| `binary-name`                       | _(auto)_                    | Optional explicit binary base name (without `.exe`)        |
| `validate-runs-on`                  | `ubuntu-latest`             | Runner for release validation                              |
| `rust-cache-provider`               | `github`                   | Rust cache backend provider (`github` or `warpbuild`)      |
| `validate-linux-packages`           | _(empty)_                   | Linux apt packages for validation                          |
| `binary-matrix-json`                | `[]`                        | Release matrix (required per item: `os`, `target`; optional: `name`, `binary`, `archive`, `cargo_args`) |
| `build-linux-packages`              | _(empty)_                   | Linux apt packages for binary build jobs                   |
| `build-matrix-default-cargo-args`   | `--release`                 | Fallback cargo args for matrix entries                     |
| `enable-macos-universal`            | `false`                     | Build universal macOS binary with `lipo`                  |
| `macos-universal-binary`            | _(auto)_                    | Optional override for universal binary name               |
| `macos-universal-arm64-artifact`    | `macos-aarch64`             | Artifact name containing arm64 archive                    |
| `macos-universal-arm64-archive`     | _(auto)_                    | Optional arm64 archive override (`<binary>-<artifact>.tar.gz`) |
| `macos-universal-x86_64-artifact`   | `macos-x86_64`              | Artifact name containing x86_64 archive                   |
| `macos-universal-x86_64-archive`    | _(auto)_                    | Optional x86_64 archive override (`<binary>-<artifact>.tar.gz`) |
| `macos-universal-output-archive`    | _(auto)_                    | Optional universal archive override (`<binary>-macos-universal.tar.gz`) |
| `create-github-release`             | `true`                      | Publish GitHub release from uploaded artifacts             |
| `release-assets-glob`               | _(empty)_                   | Optional newline-separated filename globs                  |
| `publish-crates-io`                 | `false`                     | Publish to crates.io                                       |
| `cargo-publish-command`             | `cargo publish`             | Publish command override                                   |
| `release-name`                      | _(empty)_                   | Optional release title override                            |
| `generate-release-notes`            | `true`                      | Enable generated GitHub release notes                      |
| `release-draft`                     | `false`                     | Create draft release                                       |
| `release-prerelease`                | `false`                     | Mark release as prerelease                                 |

`create-github-release` uses a GitHub App token when `JULES_PR_CLIENT_ID` and `JULES_PR_PRIVATE_KEY` are provided; otherwise it falls back to `github.token`.

## Required Secrets

Rust release workflow requires:

| Secret                  | Required | Description                                            |
| ----------------------- | -------- | ------------------------------------------------------ |
| `CARGO_REGISTRY_TOKEN`  | Only when `publish-crates-io=true` | crates.io API token for `cargo publish` |
| `JULES_PR_CLIENT_ID`    | Optional | GitHub App ID/client ID used for GitHub release writes |
| `JULES_PR_PRIVATE_KEY`  | Optional | GitHub App private key PEM paired with `JULES_PR_CLIENT_ID` |

Caller workflows can either pass named secrets explicitly (`secrets: { ... }`) or use `secrets: inherit`.
`secrets: inherit` is set in the caller job that uses the reusable workflow and is supported for repositories in the same organization or enterprise.
`GITHUB_TOKEN` is automatically available to workflows via `github.token`; no explicit secret declaration is required in the reusable workflow.
For GitHub App auth, the release workflow uses `JULES_PR_CLIENT_ID` + `JULES_PR_PRIVATE_KEY`. The names are left from the retired Jules bot; the App they identify creates the GitHub Release.
Client secret alone is not sufficient; you need the app private key.
Permissions are separate from secrets: set explicit `permissions` in both caller and reusable workflows for least privilege.

## Architecture

```mermaid
flowchart TD
  subgraph Consuming["Consuming Repository"]
    C3[".github/workflows/ci.yml"]
    C4[".github/workflows/release.yml"]
  end

  subgraph Source["Source Repository"]
    R3[".github/workflows/reusable-rust-ci.yml"]
    R4[".github/workflows/reusable-rust-release.yml"]
  end

  C3 -- workflow_call --> R3
  C4 -- workflow_call --> R4
```
