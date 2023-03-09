# Node-RED OpenTelemetry

[![license: AGPLv3](https://img.shields.io/badge/license-AGPLv3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

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

![Example](https://github.com/nioc/node-red-contrib-opentelemetry/blob/master/docs/Screenshot_01.png "Example")

## Installation

Search `node-red-contrib-opentelemetry` within the palette manager or install with npm from the command-line (within your user data directory):
``` bash
npm install node-red-contrib-opentelemetry
```

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

## License

This project is licensed under the GNU Affero General Public License v3.0 - see the [LICENSE](LICENSE.md) file for details
