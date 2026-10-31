# 07 - Licence inventory (starter)

Engineering guidance only, not legal advice. Licences below are what the projects advertise; verify the exact
installed versions and transitive dependencies before any release (Phase 5 gate), for example with
`npx license-checker --summary` and by reading each package's LICENSE file.

## Direct dependencies installed in Phase 1

| Package | Purpose | Licence (as advertised) |
|---|---|---|
| express | HTTP API | MIT |
| mongoose | MongoDB models | MIT |
| zod | validation | MIT |
| bullmq | job queue | MIT |
| ioredis | Redis client | MIT |
| pino | structured logging | MIT |
| dotenv | load .env | BSD-2-Clause |
| typescript, tsx, vitest, supertest | dev tooling | Apache-2.0 / MIT |

## Planned (not yet installed)

| Package / project | Purpose | Licence (as advertised) | Note |
|---|---|---|---|
| Crawlee | scraping | Apache-2.0 | keep LICENSE and any NOTICE text |
| PDFKit | invoice PDFs | MIT | keep copyright notice |
| Invoify | design reference only | MIT | only if code is copied; then keep notice |

## Excluded / cautioned

| Project | Decision | Reason |
|---|---|---|
| Invoice Ninja | excluded | licence needs specific review for hosted use |
| EspoCRM | not used | AGPL obligations |
| Twenty CRM | reference only | mixed licensing |

## Actions
1. Keep a `THIRD_PARTY_NOTICES` file before release.
2. Re-run the licence scan whenever dependencies change.
