# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Lahesing-ux/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Lahesing-ux/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge: one Node 22 process that serves git smart HTTP
(protocol v2 and v0), the GitHub REST v3 API, GitHub GraphQL v4 and the Model Context Protocol
over streamable HTTP, all from its own in-memory store. No UI, no dependencies, no git binary.

## What it serves

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}` — the env's boot probe |
| `GET /api/v3/` | the API root, with `X-OAuth-Scopes: repo, read:org` |
| `/api/v3/...` | REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files and merges |
| `POST /api/graphql` | GraphQL v4 for the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | MCP over streamable HTTP: initialize, tools/list and tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v0 and v2, shallow) and `git-receive-pack` |

Everything lives in memory: git objects are SHA-1 addressed and every tree and commit this server
writes is byte-identical to what git writes for the same data. The packfile reader resolves deltas,
the writer emits packs, and pushes are validated per ref (fast-forward checks, sideband reports).

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 node --experimental-strip-types main.ts
```

`main.ts` is the trial lifecycle: bind an ephemeral port, POST it to `$MAKEFUN_ENV_URL/register`,
poll `/done` and exit 0. `app.ts` builds the server; `store.ts` holds the object store and the
REST resources; `git-http.ts`, `rest.ts`, `graphql.ts` and `mcp.ts` answer the four surfaces.

## Layout

- `main.ts` — the entry/env lifecycle (`register`, then poll `/done`)
- `app.ts` — the HTTP router and the server
- `store.ts` — git objects, refs, repositories, issues and pull requests
- `git-http.ts` — smart HTTP: v2 ls-refs and fetch, v0 receive-pack, pkt-lines and packfiles
- `rest.ts` — REST v3 resources, contents commits and squash merges
- `graphql.ts` — GraphQL v4 documents
- `mcp.ts` — MCP streamable HTTP transport and tools

MIT licensed (see `LICENSE`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=mpjvq27x&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
