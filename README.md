# Node-RED OpenTelemetry

[![license: LGPLv3](https://img.shields.io/badge/license-LGPL--3.0--or--later-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)
[![GitHub release](https://img.shields.io/github/release/nioc/node-red-contrib-opentelemetry.svg)](https://github.com/nioc/node-red-contrib-opentelemetry/releases/latest)
[![GitHub Lint Workflow Status](https://img.shields.io/github/actions/workflow/status/nioc/node-red-contrib-opentelemetry/commit.yml?label=lint)](https://github.com/nioc/node-red-contrib-opentelemetry/actions/workflows/commit.yml)
[![GitHub Publish Workflow Status](https://img.shields.io/github/actions/workflow/status/nioc/node-red-contrib-opentelemetry/publish.yml?label=publish)](https://github.com/nioc/node-red-contrib-opentelemetry/actions/workflows/publish.yml)
[![npm](https://img.shields.io/npm/dt/node-red-contrib-opentelemetry)](https://www.npmjs.com/package/node-red-contrib-opentelemetry)

Full OpenTelemetry support (tracing, metrics, logs) for Node-RED.

## Key features

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

## Installation

**Requirement**: Node.js >= 22.0.0

Search for `@frankvdb/node-red-contrib-opentelemetry` in the Node-RED Palette Manager or install via npm:

``` bash
npm install node-red-contrib-opentelemetry
```

As with every [node installation](https://nodered.org/docs/user-guide/runtime/adding-nodes), you will need to restart Node-RED for it to pick-up the new nodes.

## Usage

### Configuration

1.  Add the **OTEL** node **once** to any flow.
2.  Configure the node:
    -   **Traces URL**: OTLP endpoint for traces (e.g., `http://localhost:4318/v1/traces`).
    -   **Metrics URL**: OTLP endpoint for metrics (e.g., `http://localhost:4318/v1/metrics`).
    -   **Logs URL**: OTLP endpoint for logs (e.g., `http://localhost:4318/v1/logs`).
    -   **Enable Signals**: Checkbox to enable/disable Traces, Metrics, and Logs individually.
    -   **Protocol**: Choose `http/json` or `http/protobuf`.
    -   **Service Name**: The name displayed in your OTLP backend.
    -   **Root Prefix**: Optional prefix for the root span name.
    -   **Ignored Types**: Comma-separated list of node types to exclude from tracing.
    -   **Propagate**: Comma-separated list of node types that should propagate trace context.
    -   **Timeout**: Seconds after which an unmodified message span will be closed.
    -   **Span Attribute Mappings**: Define custom attributes using [JMESPath](https://jmespath.org/) syntax to extract data from the `msg` object.

#### Environment Variables
You can also use standard OpenTelemetry environment variables:
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
- `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`
- `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_EXPORTER_OTLP_PROTOCOL`
- `OTEL_SERVICE_NAME`

Environment values are used when the node keeps its default values for URL/protocol/service name. Explicit node settings still win.

## Examples

Example flows are provided in the [examples/](examples/) directory:
- [OpenTelemetry.json](examples/OpenTelemetry.json): A complete tracing demonstration flow.

You can import these into Node-RED using **Import** from the main menu (Ctrl-I).

## Versioning

node-red-contrib-opentelemetry is maintained under the [semantic versioning](https://semver.org/) guidelines.

See the [releases](https://github.com/nioc/node-red-contrib-opentelemetry/releases) on this repository for changelog.

## Contributors

- **[Nioc](https://github.com/nioc/)** - _Initial work_
- **[Wodka](https://github.com/wodka/)** - _AMQP headers and `CompositePropagator` (Jaeger, W3C, B3)_
- **[Akrpic77](https://github.com/akrpic77/)** - _MQTT v5 context fields_
- **[joshendriks](https://github.com/joshendriks/)** - _Protobuf trace-exporter support_
- **[frankvdb7](https://github.com/frankvdb7/)** - _Maintenance and updates_

## License

This project is licensed under the GNU Lesser General Public License v3.0 - see the [LICENSE](LICENSE.md) file for details

# Node-RED OpenTelemetry and Prometheus Module

This is a Node-RED module for instrumenting flows with OpenTelemetry and exposing metrics in the Prometheus format.
