# Node-RED OpenTelemetry

[![license: LGPLv3](https://img.shields.io/badge/license-LGPL--3.0--or--later-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)
[![GitHub release](https://img.shields.io/github/release/frankvdb7/node-red-contrib-opentelemetry.svg)](https://github.com/frankvdb7/node-red-contrib-opentelemetry/releases/latest)
[![GitHub Lint Workflow Status](https://img.shields.io/github/actions/workflow/status/frankvdb7/node-red-contrib-opentelemetry/nodejs.yml?label=lint)](https://github.com/frankvdb7/node-red-contrib-opentelemetry/actions/workflows/nodejs.yml)
[![GitHub Publish Workflow Status](https://img.shields.io/github/actions/workflow/status/frankvdb7/node-red-contrib-opentelemetry/publish-npmjs.yml?label=publish)](https://github.com/frankvdb7/node-red-contrib-opentelemetry/actions/workflows/publish-npmjs.yml)
[![npm](https://img.shields.io/npm/dt/@frankvdb/node-red-contrib-opentelemetry)](https://www.npmjs.com/package/@frankvdb/node-red-contrib-opentelemetry)

Full OpenTelemetry support (tracing, metrics, logs) for Node-RED.

## Key Features

### Traces

- Powered by the [OpenTelemetry JavaScript framework](https://github.com/open-telemetry/opentelemetry-js) and [Node-RED messaging hooks](https://nodered.org/docs/api/hooks/messaging):
  - Automatically creates spans on `onSend(source)` and `postDeliver(destination)` events.
  - Automatically ends spans on `onComplete` and `postDeliver(source)` events.
- Each trace includes:
  - Message ID, Flow ID, Node ID, Node Type, Node Name (if provided).
  - Hostname.
  - HTTP status code (for `http request` and `http response` nodes).
  - Exception details and status.
  - Custom attributes based on message data (using JMESPath).

### Metrics

- OTLP metrics exporter for HTTP server duration.
- Records `http.server.duration` histogram with attributes:
  - `http.response.status_code`
  - `http.request.method`
  - `url.path`

### Logs

- OTLP logs exporter for Node-RED message events.
- Captures flow traversal events as structured logs with context correlation.
- Captures Node-RED runtime logger events (`info`, `warn`, `error`, etc.) through `@node-red/util.log` handlers.

## Installation

**Requirement**: Node.js >= 22.0.0

Search for `@frankvdb/node-red-contrib-opentelemetry` in the Node-RED Palette Manager or install via npm:

``` bash
npm install @frankvdb/node-red-contrib-opentelemetry
```

Restart Node-RED after installation to pick up the runtime plugin.

## Usage

### Configuration

This module runs as a **Node-RED runtime plugin**.

Configure it via `settings.js` under `opentelemetry` (or use environment variables only). No flow node or config node is required.

```js
// settings.js
module.exports = {
  // ...
  opentelemetry: {
    url: "http://localhost:4318/v1/traces",
    metricsUrl: "http://localhost:4318/v1/metrics",
    logsUrl: "http://localhost:4318/v1/logs",
    protocol: "http", // "http" (json) or "proto" (protobuf)
    serviceName: "Node-RED",
    tracesEnabled: true,
    metricsEnabled: false,
    logsEnabled: false,
    flowEventLogsEnabled: true,
    rootPrefix: "",
    excludedNodeTypes: "debug,catch",
    includedNodeTypes: "",
    propagateHeaderNodeTypes: "http request,mqtt out",
    logLevel: "warn",
    timeout: 10,
    attributeMappings: [
      {
        isAfter: false,
        flow: "",
        nodeType: "http in",
        key: "http.method",
        path: "req.method",
      },
    ],
  },
};
```

Restart Node-RED after changing plugin settings.

Config fields (`settings.js` -> `opentelemetry`):
-   **url**: OTLP traces endpoint (e.g., `http://localhost:4318/v1/traces`).
-   **metricsUrl**: OTLP metrics endpoint (e.g., `http://localhost:4318/v1/metrics`).
-   **logsUrl**: OTLP logs endpoint (e.g., `http://localhost:4318/v1/logs`).
-   **tracesEnabled / metricsEnabled / logsEnabled**: Enable/disable signals independently.
-   **flowEventLogsEnabled**: Enable/disable flow hook event logs (`onSend`, `preDeliver`, etc.) while keeping runtime logger forwarding.
-   **protocol**: `http` (json) or `proto` (protobuf).
-   **serviceName**: Service name shown in your telemetry backend.
-   **rootPrefix**: Optional prefix for root span names.
-   **excludedNodeTypes**: Comma-separated Node-RED node types excluded from tracing.
-   **includedNodeTypes**: Comma-separated Node-RED node types allowed for tracing. Empty means include all.
-   **propagateHeaderNodeTypes**: Comma-separated node types that should propagate trace headers.
-   **logLevel**: `off`, `error`, `warn`, `info`, or `debug`.
-   **timeout**: Seconds after which an unmodified message span is closed.
-   **attributeMappings**: Custom attributes using [JMESPath](https://jmespath.org/) on `msg`.

### How It Works

At runtime the module registers Node-RED messaging hooks and tracks spans per `msg._msgid`.

1. `onSend`: starts a span for the source node when tracing is enabled for that node type.
2. `postDeliver`: starts a span for the destination node and links it to the same message trace.
3. `onComplete`: ends the active node span and updates status/error attributes when applicable.
4. Periodic cleanup closes stale message span trees after `timeout`.

`excludedNodeTypes` behavior:
- If a node type is in `excludedNodeTypes`, spans for that node type are skipped.

`includedNodeTypes` behavior:
- If `includedNodeTypes` is empty, all non-excluded node types are traced.
- If `includedNodeTypes` has values, only listed node types are traced.

`propagateHeaderNodeTypes` behavior:
- In `preDeliver`, existing trace headers are cleared for matching source node types.
- In `postDeliver`, fresh trace headers are injected for matching destination node types.
- Injection target is based on node type (for example HTTP headers or MQTT user properties).

#### Environment Variables
Supported environment variables:
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
- `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`
- `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_EXPORTER_OTLP_PROTOCOL`
- `OTEL_SERVICE_NAME`
- `OTEL_LOG_LEVEL`
- `OTEL_EXCLUDED_NODE_TYPES`
- `OTEL_INCLUDED_NODE_TYPES`
- `OTEL_PROPAGATE_HEADER_NODE_TYPES`

Environment values are applied only when the corresponding plugin setting is unset or still at the default.

## Examples

Examples are provided in the [examples/](examples/) directory:
- [OpenTelemetry.json](examples/OpenTelemetry.json): A tracing demonstration flow.
- [opentelemetry.settings.example.js](examples/opentelemetry.settings.example.js): A `settings.js` plugin config snippet.

Import the flow using **Import** (Ctrl-I), then configure the runtime plugin in `settings.js`.
For a full settings reference, see [docs/plugin-configuration.md](docs/plugin-configuration.md).

## Versioning

This project follows [Semantic Versioning](https://semver.org/). See the [releases](https://github.com/frankvdb7/node-red-contrib-opentelemetry/releases) for the changelog.

## Contributors

- **[Nioc](https://github.com/nioc/)** - _Initial work_
- **[Wodka](https://github.com/wodka/)** - _AMQP headers and `CompositePropagator` (Jaeger, W3C, B3)_
- **[Akrpic77](https://github.com/akrpic77/)** - _MQTT v5 context fields_
- **[joshendriks](https://github.com/joshendriks/)** - _Protobuf trace-exporter support_
- **[frankvdb7](https://github.com/frankvdb7/)** - _Maintenance and updates_

## License

This project is licensed under the **GNU Lesser General Public License v3.0**. See the [LICENSE](LICENSE.md) file for details.


