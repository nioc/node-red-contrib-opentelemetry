// Paste this block into your Node-RED settings.js file.
// This package runs as a runtime plugin (no flow/config node required).
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
