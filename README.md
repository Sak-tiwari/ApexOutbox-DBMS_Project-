# ApexOutbox-DBMS_Project-
An automated business platform powered by Crawlee, Node.js, and TypeScript for web scraping. It features a custom sales pipeline state machine and a Redis/BullMQ outbox engine to automate lead ingestion, client onboarding, PDF invoicing, and email delivery.




# Business Automation System — Phase 4

## Overview
Phase 4 automates client onboarding, invoice creation,
PDF generation, and transactional email processing.

## Technologies
- Node.js and TypeScript
- Express.js for the API
- MongoDB and Mongoose
- Redis and BullMQ for background jobs
- PDFKit for invoice PDF generation
- Nodemailer for email delivery
- Zod for input validation

## Main Components
- `src/phase4/api.ts` — onboarding API endpoint
- `src/phase4/onboarding.ts` — input validation and idempotency key
- `src/phase4/models.ts` — client and invoice database models
- `src/phase4/invoice.ts` — invoice PDF generation
- `src/phase4/email.ts` — email delivery and demo mode
- `src/phase4/queue.ts` — background job queue
- `src/phase4/outbox.ts` — durable outbox event model
- `src/phase4/dispatcher.ts` — dispatches outbox events to BullMQ
- `src/phase4/worker.ts` — processes invoice jobs
- `src/phase4/types.ts` — shared TypeScript interfaces

## Workflow
1. A lead is marked Closed-Won in the sales pipeline.
2. The onboarding API validates client information.
3. Client and invoice records are created or retrieved.
4. An outbox event is recorded for processing.
5. The dispatcher publishes the event to BullMQ.
6. The worker generates the invoice PDF.
7. The worker attempts to email the invoice.

## Environment Configuration
Copy `.env.example` to `.env` in the local development
environment and configure MongoDB, Redis, and optional
SMTP credentials. Never commit real secrets.

## Development Commands
Install dependencies with `npm install`.

Build TypeScript with `npm run build`.

Start the API with `npm run start:api`.

Start the dispatcher with `npm run start:dispatcher`.

Start the worker with `npm run start:worker`.

MongoDB and Redis must be available before starting
the application.

## Important Limitations
This is a development prototype and requires integration
with the shared Phase 1–3 application.

Before production use, implement and test:
- Atomic invoice and outbox transactions
- Outbox recovery after worker crashes
- Authentication and authorization
- Reliable email timeout reconciliation
- Durable PDF storage
- Integration, retry, and duplicate-processing tests

