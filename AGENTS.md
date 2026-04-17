This file provides instructions for AI agents working with this repository.

## Project Overview

This project is a Node-RED runtime plugin for OpenTelemetry (Traces, Metrics, Logs).

## Getting Started

1.  **Install dependencies:** Run `npm install` to install the required dependencies.
2.  **Run tests:** Use `npm test` to run the test suite.

## Development Guidelines

*   Runtime plugin source code is located in `src/plugins/`.
*   Tests are in the `test/` directory.
*   The project uses the built-in Node.js test runner (`node --test`).
*   The command to run tests with a coverage report is `npm run test:cov`.
*   Avoid unintended modifications to `package.json` and `package-lock.json` when running commands.
*   This package is plugin-only; do not add Node-RED config node or palette node registration.
*   Register runtime plugins via `RED.plugins.registerPlugin(id, definition)` with lifecycle in `onadd`/`onremove`.
*   Runtime plugin settings are read from `RED.settings.opentelemetry`.

## Testing Notes

*   Tests for Node-RED hooks require mocking the global `RED` object, including its `nodes`, `hooks`, `settings`, and `plugins` properties, to simulate the plugin runtime environment.
*   Runtime plugin tests should mock `RED.plugins.registerPlugin(...)` and invoke plugin lifecycle through `onadd`/`onremove` (or through the test harness wrappers around `onSettings`/`onClose`).
*   The test suite stubs external dependencies. For example, `@node-red/util` is mocked by `test/stubs/node-red-util.cjs`.
