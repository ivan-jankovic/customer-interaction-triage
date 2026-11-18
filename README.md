# Customer Interaction Triage

A system that does the first pass over customer messages (e-mails, chats and call transcripts in Czech, Slovak and English) for Merelo, a fictional Czech internet and mobile provider: it works out what each message is about, finds the customer, routes the case to the right team, and sends it to a person whenever it is unsure. Only synthetic data is used.

The project is built spec-first: what and why in [specs/mission.md](specs/mission.md), how in [specs/tech-stack.md](specs/tech-stack.md), the order of work in [specs/roadmap.md](specs/roadmap.md), and one spec folder per phase in [specs/phases/](specs/phases/). The labelled dataset and how it was built are described in [eval/data/README.md](eval/data/README.md).

## Local setup

Requirements: Node.js 24 (see `.nvmrc`) and Docker with Compose.

```sh
npm ci
cp .env.example .env                 # local service URLs; ANTHROPIC_API_KEY only for the dataset scripts
docker compose up -d --wait          # PostgreSQL and Redis
npm run db:migrate                   # apply migrations (npm run db:rollback undoes the last one)
```

If ports 5432 or 6379 are taken, start Compose with `POSTGRES_PORT=… REDIS_PORT=…` and change the URLs in `.env` to match.

## Checks

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests. No Docker, no network, never calls a model. |
| `npm run test:integration` | Tests against the Compose services (migrations, Redis). |
| `npm run lint` | ESLint with type-aware rules. |
| `npm run format` / `format:check` | Prettier. |
| `npm run typecheck` | TypeScript 7 type check. |
| `npm run audit` | Dependency audit (audit-ci, fails on any advisory). |

CI runs all of them on every pull request.

`git blame` skips the one-off formatting commit once you run `git config blame.ignoreRevsFile .git-blame-ignore-revs`.
