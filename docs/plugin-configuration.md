# Plugin Configuration

This package runs as a Node-RED runtime plugin.  
Configure it in `settings.js` under the `opentelemetry` key.

## Example

```js
module.exports = {
	// ...
	opentelemetry: {
		url: "http://localhost:4318/v1/traces",
		metricsUrl: "http://localhost:4318/v1/metrics",
		logsUrl: "http://localhost:4318/v1/logs",
		protocol: "http",
		serviceName: "Node-RED",
		tracesEnabled: true,
		metricsEnabled: false,
		logsEnabled: false,
		rootPrefix: "",
		ignoredNodeTypes: "debug,catch",
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

Restart Node-RED after changing these settings.

## Fields

- `url`: OTLP traces endpoint.
- `metricsUrl`: OTLP metrics endpoint.
- `logsUrl`: OTLP logs endpoint.
- `protocol`: `http` (json) or `proto` (protobuf).
- `serviceName`: OpenTelemetry service name.
- `tracesEnabled`: Enable trace export.
- `metricsEnabled`: Enable metric export.
- `logsEnabled`: Enable log export.
- `rootPrefix`: Prefix added to root span names.
- `ignoredNodeTypes`: Comma-separated node types excluded from tracing.
- `propagateHeaderNodeTypes`: Comma-separated node types for context propagation.
- `logLevel`: `off`, `error`, `warn`, `info`, or `debug`.
- `timeout`: Span cleanup timeout (seconds).
- `attributeMappings`: Custom span attributes from `msg` via JMESPath.

## Environment Variables

Environment values are used when the matching plugin setting is missing or still default.

- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
- `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`
- `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_EXPORTER_OTLP_PROTOCOL`
- `OTEL_SERVICE_NAME`
- `OTEL_LOG_LEVEL`
- `IGNORED_NODE_TYPES`
