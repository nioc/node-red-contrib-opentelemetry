# Node-RED OpenTelemetry

[![license: AGPLv3](https://img.shields.io/badge/license-AGPLv3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![GitHub release](https://img.shields.io/github/release/nioc/node-red-contrib-opentelemetry.svg)](https://github.com/nioc/node-red-contrib-opentelemetry/releases/latest)
[![GitHub Lint Workflow Status](https://img.shields.io/github/actions/workflow/status/nioc/node-red-contrib-opentelemetry/commit.yml?label=lint)](https://github.com/nioc/node-red-contrib-opentelemetry/actions/workflows/commit.yml)
[![GitHub Publish Workflow Status](https://img.shields.io/github/actions/workflow/status/nioc/node-red-contrib-opentelemetry/publish.yml?label=publish)](https://github.com/nioc/node-red-contrib-opentelemetry/actions/workflows/publish.yml)
[![npm](https://img.shields.io/npm/dt/node-red-contrib-opentelemetry)](https://www.npmjs.com/package/node-red-contrib-opentelemetry)

Distributed tracing with OpenTelemetry SDK for Node-RED.

## Key features
- based on [messaging hooks](https://nodered.org/docs/api/hooks/messaging):
  - create spans on `onSend(source)` and `postDeliver(destination)` events,
  - end spans on `onComplete` and `postDeliver(source)` events.
- trace includes:
  - message id,
  - flow id,
  - node id,
  - node type,
  - node name (if filled),
  - hostname,
  - optionally `http status code` (for request node type),
  - optionally `exception`.

![Example](https://raw.githubusercontent.com/nioc/node-red-contrib-opentelemetry/master/docs/Screenshot_01.png "Example")

## Installation

Search `node-red-contrib-opentelemetry` within the palette manager or install with npm from the command-line (within your user data directory):
``` bash
npm install node-red-contrib-opentelemetry
```

As with every [node installation](https://nodered.org/docs/user-guide/runtime/adding-nodes), you will need to restart Node-RED for it to pick-up the new nodes.

## Usage

- Add OTEL node **once** (to any flow),
- Setup the node:
  - set OTEL [exporter](https://opentelemetry.io/docs/instrumentation/js/exporters/) url (example for Jaeger: `http://localhost:4318/v1/traces`),
  - define a service name (will be displayed as span service),
  - define an optional root span prefix (will be added in Node-RED root span name),
  - define nodes that should not send traces (using comma-separated list like `debug,catch`),
  - define nodes that should propagate [W3C trace context](https://www.w3.org/TR/trace-context/#design-overview) (in http request headers, using comma-separated list like `http request,my-custom-node`),
  - define time in seconds after which an unmodified message will be ended and deleted,

## Versioning

node-red-contrib-opentelemetry is maintained under the [semantic versioning](https://semver.org/) guidelines.

See the [releases](https://github.com/nioc/node-red-contrib-opentelemetry/releases) on this repository for changelog.

## Contributors

- **[Nioc](https://github.com/nioc/)** - _Initial work_
- **[Wodka](https://github.com/wodka/)** - _AMQP headers and `CompositePropagator` (Jaeger, W3C, B3)_

See also the full list of [contributors](https://github.com/nioc/node-red-contrib-opentelemetry/graphs/contributors) to this project.

## License

This project is licensed under the GNU Affero General Public License v3.0 - see the [LICENSE](LICENSE.md) file for details
