This file provides instructions for AI agents working with this repository.

## Project Overview

This project is a Node-RED module for OpenTelemetry (Traces, Metrics, Logs).

## Getting Started

1.  **Install dependencies:** Run `npm install` to install the required dependencies.
2.  **Run tests:** Use `npm test` to run the test suite.

## Development Guidelines

*   Source code is located in the `src/` directory.
*   Tests are in the `test/` directory.
*   The project uses the built-in Node.js test runner (`node --test`).
*   The command to run tests with a coverage report is `npm test -- --experimental-test-coverage`.
*   Avoid unintended modifications to `package.json` and `package-lock.json` when running commands.

## Testing Notes

*   Tests for Node-RED hooks require mocking the global `RED` object, including its `nodes` and `hooks` properties, to simulate the Node-RED environment.
*   When testing Node-RED event handlers that are extracted from a node instance, `Function.prototype.call()` or `Function.prototype.bind()` must be used to preserve the correct `this` context.
*   The test suite stubs external dependencies. For example, `@node-red/util` is mocked by `test/stubs/node-red-util.cjs`.
