# Node-RED OpenTelemetry

[![license: LGPLv3](https://img.shields.io/badge/license-LGPL--3.0--or--later-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)
[![GitHub release](https://img.shields.io/github/release/nioc/node-red-contrib-opentelemetry.svg)](https://github.com/nioc/node-red-contrib-opentelemetry/releases/latest)
[![GitHub Lint Workflow Status](https://img.shields.io/github/actions/workflow/status/nioc/node-red-contrib-opentelemetry/commit.yml?label=lint)](https://github.com/nioc/node-red-contrib-opentelemetry/actions/workflows/commit.yml)
[![GitHub Publish Workflow Status](https://img.shields.io/github/actions/workflow/status/nioc/node-red-contrib-opentelemetry/publish.yml?label=publish)](https://github.com/nioc/node-red-contrib-opentelemetry/actions/workflows/publish.yml)
[![npm](https://img.shields.io/npm/dt/node-red-contrib-opentelemetry)](https://www.npmjs.com/package/node-red-contrib-opentelemetry)

Distributed tracing with OpenTelemetry SDK and Prometheus metrics exporter for Node-RED

## Key features

### Traces

- based on [OpenTelemetry JavaScript framework](https://github.com/open-telemetry/opentelemetry-js) and [Node-RED messaging hooks](https://nodered.org/docs/api/hooks/messaging):
  - create spans on `onSend(source)` and `postDeliver(destination)` events,
  - end spans on `onComplete` and `postDeliver(source)` events.
- **one trace per flow execution**: every node a message reaches is a span below a single run
  span, whatever the message identifier changes along the way (see [Traces and runs](#traces-and-runs)),
- continues the caller trace when the entry node receives a [W3C trace context](https://www.w3.org/TR/trace-context/#design-overview)
  (`http in` headers, `mqtt in` v5 user properties, `amqp-in` headers),
- trace includes:
  - run id,
  - message id,
  - flow id,
  - node id,
  - node type,
  - node name (if filled),
  - hostname,
  - optional `http status code` (for request node type),
  - optional `exception`,
  - optional custom attributes based on message data.

![Example spans in JaegerUI](https://raw.githubusercontent.com/nioc/node-red-contrib-opentelemetry/master/docs/Screenshot_01.png "Example spans")

![Example spans to metrics in Grafana](https://raw.githubusercontent.com/nioc/node-red-contrib-opentelemetry/master/docs/Screenshot_02.png "Example spans to metrics")

### Traces and runs

A trace stands for one execution of your flow. The first node to emit a message opens a **run
span**, every node the message reaches becomes a child span, and the run span ends when the last
of those node spans ends.

Node-RED gives a fresh `_msgid` to every message object a node emits (a `function` node
returning `{payload: ...}` instead of the message it received, a `split` node, a `join` node,
...). To keep those in the same trace, the run is carried on the message in the
`otelRootMsgId` property, which you will therefore see on messages in the debug sidebar.

Two situations deliberately produce more than one trace, following the
[messaging semantic conventions](https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/):

- a node that acknowledges a message and emits later (`delay`, `trigger`, a rate limiter) hands
  over to a new run, linked to the one it came from with a span link
  (`node_red.link.type: continuation`),
- a message published to a broker and consumed by another flow is a run of its own, correlated
  through the propagated trace context.

Nodes that never report completion (`tcp in`, `server-events`, ...) get their span closed once
the message they created has been dispatched. A run left unfinished past the configured
`timeout` is closed by a sweep, and the node spans still open are ended and flagged with
`node_red.span.incomplete` instead of being dropped.

### Metrics

- export of request metrics from `http in` nodes (for Prometheus scraping):
  - method,
  - route,
  - status,
  - ip
  - duration.

``` bash
curl http://localhost:1881/metrics
# HELP target_info Target metadata
# TYPE target_info gauge
target_info{service_name="Node-RED",telemetry_sdk_language="nodejs",telemetry_sdk_name="opentelemetry",telemetry_sdk_version="1.30.0"} 1
# HELP http_request_duration Response time for incoming http requests in milliseconds
# UNIT http_request_duration ms
# TYPE http_request_duration histogram
http_request_duration_count{method="POST",route="/api/test",status="201",ip="127.0.0.1"} 5
http_request_duration_sum{method="POST",route="/api/test",status="201",ip="127.0.0.1"} 620
http_request_duration_bucket{method="POST",route="/api/test",status="201",ip="127.0.0.1",le="0"} 0
http_request_duration_bucket{method="POST",route="/api/test",status="201",ip="127.0.0.1",le="25"} 0
http_request_duration_bucket{method="POST",route="/api/test",status="201",ip="127.0.0.1",le="50"} 4
http_request_duration_bucket{method="POST",route="/api/test",status="201",ip="127.0.0.1",le="75"} 4
http_request_duration_bucket{method="POST",route="/api/test",status="201",ip="127.0.0.1",le="100"} 4
http_request_duration_bucket{method="POST",route="/api/test",status="201",ip="127.0.0.1",le="250"} 4
http_request_duration_bucket{method="POST",route="/api/test",status="201",ip="127.0.0.1",le="500"} 4
http_request_duration_bucket{method="POST",route="/api/test",status="201",ip="127.0.0.1",le="1000"} 5
http_request_duration_bucket{method="POST",route="/api/test",status="201",ip="127.0.0.1",le="2000"} 5
http_request_duration_bucket{method="POST",route="/api/test",status="201",ip="127.0.0.1",le="+Inf"} 5
```

## Installation

Search `node-red-contrib-opentelemetry` within the palette manager or install with npm from the command-line (within your user data directory):
``` bash
npm install node-red-contrib-opentelemetry
```

As with every [node installation](https://nodered.org/docs/user-guide/runtime/adding-nodes), you will need to restart Node-RED for it to pick-up the new nodes.

## Usage

### Traces

- Add OTEL node **once** (to any flow),
- Setup the node:
  - set OTEL [exporter](https://opentelemetry.io/docs/instrumentation/js/exporters/) url (example for Jaeger: `http://localhost:4318/v1/traces`),
  - choose an OTLP transport protocol (`http/json` or `http/protobuf`),
  - define a service name (will be displayed as span service),
  - define an optional root span prefix (will be added in Node-RED root span name),
  - define nodes that should not send traces (using comma-separated list like `debug,catch`),
  - define nodes that should propagate [W3C trace context](https://www.w3.org/TR/trace-context/#design-overview) (in http request headers, using comma-separated list like `http request,my-custom-node`),
  - define time in seconds after which a run with no activity is considered abandoned and closed,
  - define custom attributes you want to send (optionally).

### Metrics

- Add Prometheus node **once** (to any flow),
- Setup the node:
  - set Prometheus export port and endpoint (example: `1881` and `/metrics`),
  - define a service name (will be displayed in export),
  - define a instrument name (will be displayed in export),
- Add middleware to your `settings.js` file:
  ``` js
    // import the prometheus middleware
    const { prometheusMiddleware } = require('node-red-contrib-opentelemetry/lib/prometheus-exporter.js')
    // ...
    // then add it to the existing httpNodeMiddleware attribute
    httpNodeMiddleware: prometheusMiddleware,
    // ...
  ```

## Versioning

node-red-contrib-opentelemetry is maintained under the [semantic versioning](https://semver.org/) guidelines.

See the [releases](https://github.com/nioc/node-red-contrib-opentelemetry/releases) on this repository for changelog.

## Contributors

- **[Nioc](https://github.com/nioc/)** - _Initial work_
- **[Wodka](https://github.com/wodka/)** - _AMQP headers and `CompositePropagator` (Jaeger, W3C, B3)_
- **[Akrpic77](https://github.com/akrpic77/)** - _MQTT v5 context fields_
- **[joshendriks](https://github.com/joshendriks/)** - _Protobuf trace-exporter support_

See also the full list of [contributors](https://github.com/nioc/node-red-contrib-opentelemetry/graphs/contributors) to this project.

## Direct dependencies

- **[@opentelemetry](https://github.com/open-telemetry/opentelemetry-js)** (Apache-2.0)
- **[jmespath](https://github.com/jmespath/jmespath.js)** (Apache-2.0)
- **[on-finished](https://github.com/jshttp/on-finished)** (MIT)

## License

This project is licensed under the GNU Lesser General Public License v3.0 - see the [LICENSE](LICENSE.md) file for details
