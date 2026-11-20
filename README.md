# coreforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/upinhuy/coreforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/upinhuy/coreforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

CoreForge is a GitHub-compatible git forge in a single dependency-free Node
program (standard library only, no `git` binary, no install step). It serves
four surfaces from one in-memory store:

- **Git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 (`ls-refs`,
  `fetch` with shallow/deepen, sideband framing) and v0, plus `git-receive-pack`
  with per-ref `report-status` (fast-forward enforcement, mixed ok/ng reports,
  branch/tag create and delete). The git object model — SHA-1 ids, trees,
  commits, annotated tags, packfiles with OFS/REF delta resolution and thin
  packs — is implemented in-process, so a real `git clone` / `git push` cycle
  works end to end.
- **REST v3** under `/api/v3` — users, repositories (create/list/patch/delete
  with `Link`-header pagination), the contents API (which also births branches
  and commits), git refs, branches, labels, issues with comments, and pull
  requests with file diffs and squash/merge merges (a conflicted merge is a
  405). Bearer-token auth; another owner's repository is a 404, never a 403.
- **GraphQL v4** at `/api/graphql` — viewer, repositories, issues and pull
  requests with cursor connections, `node(id:)` over opaque global ids,
  introspection, batched operations, and the `createIssue`, `closeIssue`,
  `createPullRequest`, `mergePullRequest` and `addComment` mutations.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP: `server/discover`
  (2026-07-28) with a legacy `initialize` fallback, and tools (`create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `get_issue`,
  `create_pull_request`, `merge_pull_request`) that act on the same store as
  REST, so objects read back identically on every surface.

Validated locally against the bounty's own conformance suite: all 120 checks
pass (git 30, repos 15, issues 15, pulls 20, GraphQL 20, MCP 15, protocol 5),
and the four benchmark workloads (push / clone / read / write) complete.

## Run it

```sh
node --experimental-strip-types main.ts
```

The entrypoint expects the trial lifecycle: it reads `MAKEFUN_ENV_URL`,
binds an ephemeral port, registers it with the env, and serves until the env
says the trial is done. API calls authenticate with the process's
`MAKEFUN_SHOP_TOKEN` as a Bearer token. To poke at it by hand, run it with a
stub env (`POST /register`, `GET /done` answering `{"done": false}`) and the
token of your choice, then use `git clone http://localhost:<port>/<you>/<repo>.git`
and the REST/GraphQL/MCP endpoints above.

---

<sub>Entered on [make.fun](https://make.fun/?ref=hv9zk8y5&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
