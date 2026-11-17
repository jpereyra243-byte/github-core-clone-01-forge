# ForgePure: GitHub-Compatible Git Forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/jpereyra243-byte/github-core-clone-01-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/jpereyra243-byte/github-core-clone-01-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A pure TypeScript, standalone GitHub-compatible git forge developed for the [make.fun](https://make.fun) bounty "Build a GitHub-compatible git forge".

## Overview
ForgePure implements the four fundamental surfaces of GitHub entirely in TypeScript without any external git binaries or third-party packages:
1. **Git Smart HTTP**: Full support for Git Protocol v2 (upload-pack v2 capability advertisement and ls-refs) and Protocol v0 (receive-pack v0 with report-status, side-band-64k, and delete-refs).
2. **REST API v3 (`/api/v3`)**: Repositories, commits, trees, blobs, contents with conflict handling (409), labels, issues, and pull requests with squash merge commits.
3. **GraphQL v4 (`/api/graphql`)**: Viewer queries, repository lookups, node relay resolution, pagination, and mutations.
4. **Model Context Protocol (MCP) (`/mcp`)**: JSON-RPC 2.0 tool endpoints for agentic operations (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`).

## License
MIT
