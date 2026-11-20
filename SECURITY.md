# Security policy

Customer Interaction Triage is a demonstration project. It runs only locally, with Docker Compose, and every message, customer and company in it is synthetic. There is no hosted deployment and no real customer data.

## Reporting a vulnerability

Please report security problems privately, through **Report a vulnerability** on the repository's [Security tab](https://github.com/ivan-jankovic/customer-interaction-triage/security/advisories/new), not in a public issue. Only the latest version on `main` is maintained.

## Known limits

Some weaknesses are known and documented in the README's [Limitations](README.md#limitations): the review page has one access key shared by all reviewers (per-person logins are planned in the next phase, P15), there is no login rate limit, and two prompt-injection cases are known not to be caught. Reports about these are welcome but are not new findings.
