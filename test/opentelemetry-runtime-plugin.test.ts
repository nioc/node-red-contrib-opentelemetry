// @ts-nocheck
const Module = require("node:module");
const path = require("node:path");
const stubPath = path.join(process.cwd(), "test", "stubs", "node-red-util.cjs");
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
	if (request === "@node-red/util") {
		return stubPath;
	}
	return originalResolveFilename.call(this, request, parent, isMain, options);
};
const test = require("node:test");
const assert = require("node:assert/strict");
const otelApi = require("@opentelemetry/api");
const otelLogsApi = require("@opentelemetry/api-logs");
const otelModule = require("../src/plugins/opentelemetry-runtime");
const nodeRedUtilStub = require(stubPath);

const mockRed = {
	nodes: {
		getNode: (id) => ({ name: `Flow ${id}` }),
	},
};

const {
	getMsgId,
	getSpanId,
	isPrimitive,
	parseAttribute,
	createSpan,
	endSpan,
	deleteOutdatedMsgSpans,
	setAttributeMappings,
	setTimeout: setTimeoutMs,
	getMsgSpans,
	resetState,
	logEvent,
	setLogLevel,
	resolveOpenTelemetryConfig,
	maskUrlCredentials,
	formatStartupConfigSummary,
	getSharedState,
} = otelModule.__test__;

const originalEnv = { ...process.env };

function resetEnv() {
	for (const key of Object.keys(process.env)) {
		if (!(key in originalEnv)) {
			delete process.env[key];
		}
	}
	Object.assign(process.env, originalEnv);
}

test.beforeEach(() => {
	resetState();
	resetEnv();
	nodeRedUtilStub.log.reset();
});

test.afterEach(() => {
	resetState();
	resetEnv();
	nodeRedUtilStub.log.reset();
});

function createFakeSpan(name, options = {}) {
	return {
		name,
		options,
		attributes: options.attributes || {},
		ended: false,
		endTimestamp: undefined,
		end(timestamp) {
			this.ended = true;
			this.endTimestamp = timestamp;
		},
		setAttributes(attrs) {
			this.attributes = { ...this.attributes, ...attrs };
		},
		setAttribute(key, value) {
			this.attributes[key] = value;
		},
		setStatus() {},
		recordException() {},
		updateName(newName) {
			this.updatedName = newName;
		},
	};
}

test("getMsgId prefers otelRootMsgId when present", () => {
	assert.equal(getMsgId({ _msgid: "1", otelRootMsgId: "root" }), "root");
	assert.equal(getMsgId({ _msgid: "1" }), "1");
});

test("getSpanId includes node id and respects split root id", () => {
	assert.equal(
		getSpanId({ _msgid: "1" }, { id: "node", type: "function" }),
		"1#node",
	);
	assert.equal(
		getSpanId(
			{ _msgid: "1", otelRootMsgId: "root" },
			{ id: "node", type: "split" },
		),
		"root#node",
	);
});

test("isPrimitive recognises primitive values and arrays", () => {
	assert.equal(isPrimitive("hello"), true);
	assert.equal(isPrimitive(42), true);
	assert.equal(isPrimitive(false), true);
	assert.equal(isPrimitive(["a", 1, true]), true);
	assert.equal(isPrimitive([{ foo: "bar" }]), false);
	assert.equal(isPrimitive({ foo: "bar" }), false);
});

test("parseAttribute returns undefined when no mappings configured", () => {
	assert.equal(
		parseAttribute(false, { foo: "bar" }, "flow", "type"),
		undefined,
	);
});

test("parseAttribute filters mappings by flow, node type and timing", () => {
	setAttributeMappings([
		{ flow: "", nodeType: "", isAfter: false, key: "root", path: "foo" },
		{
			flow: "flow",
			nodeType: "type",
			isAfter: false,
			key: "matching",
			path: "details.value",
		},
		{
			flow: "flow",
			nodeType: "type",
			isAfter: true,
			key: "afterOnly",
			path: "details.value",
		},
	]);
	const attributes = parseAttribute(
		false,
		{ foo: "ignored", details: { value: "kept" } },
		"flow",
		"type",
	);
	assert.deepEqual(attributes, { root: "ignored", matching: "kept" });
	const afterAttributes = parseAttribute(
		true,
		{ details: { value: 5 } },
		"flow",
		"type",
	);
	assert.deepEqual(afterAttributes, { afterOnly: 5 });
});

test("parseAttribute ignores non primitive results", () => {
	setAttributeMappings([
		{
			flow: "",
			nodeType: "",
			isAfter: false,
			key: "object",
			path: "{ value: foo }",
		},
	]);
	const attributes = parseAttribute(
		false,
		{ foo: { nested: true } },
		"flow",
		"type",
	);
	assert.deepEqual(attributes, {});
});

test("parseAttribute ignores mappings with blank key or path", () => {
	setAttributeMappings([
		{ flow: "", nodeType: "", isAfter: false, key: "", path: "foo" },
		{ flow: "", nodeType: "", isAfter: false, key: "valid", path: "foo" },
		{ flow: "", nodeType: "", isAfter: false, key: "ignored", path: " " },
	]);
	const attributes = parseAttribute(false, { foo: "value" }, "flow", "type");
	assert.deepEqual(attributes, { valid: "value" });
});

test("resolveOpenTelemetryConfig reads OTEL env values when node uses defaults", () => {
	process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318";
	process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf";
	process.env.OTEL_SERVICE_NAME = "env-service";
	const config = resolveOpenTelemetryConfig({
		url: "http://localhost:4318/v1/traces",
		protocol: "http",
		serviceName: "Node-RED",
	});
	assert.equal(config.url, "http://collector:4318/v1/traces");
	assert.equal(config.metricsUrl, "http://collector:4318/v1/metrics");
	assert.equal(config.logsUrl, "http://collector:4318/v1/logs");
	assert.equal(config.protocol, "proto");
	assert.equal(config.serviceName, "env-service");
});

test("resolveOpenTelemetryConfig gives OTEL env values precedence over explicit settings", () => {
	process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
		"http://collector:4318/v1/traces";
	process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/json";
	process.env.OTEL_SERVICE_NAME = "env-service";
	const config = resolveOpenTelemetryConfig({
		url: "http://custom:4318/v1/traces",
		protocol: "proto",
		serviceName: "custom-service",
	});
	assert.equal(config.url, "http://collector:4318/v1/traces");
	assert.equal(config.protocol, "http");
	assert.equal(config.serviceName, "env-service");
});

test("resolveOpenTelemetryConfig supports trace-specific env overrides", () => {
	process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://generic:4318";
	process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
		"http://trace-specific:4318/custom";
	process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";
	process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/protobuf";
	const config = resolveOpenTelemetryConfig({});
	assert.equal(config.url, "http://trace-specific:4318/custom");
	assert.equal(config.protocol, "proto");
});

test("resolveOpenTelemetryConfig appends signal paths to generic endpoint base path", () => {
	process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318/otlp";
	const config = resolveOpenTelemetryConfig({});
	assert.equal(config.url, "http://collector:4318/otlp/v1/traces");
	assert.equal(config.metricsUrl, "http://collector:4318/otlp/v1/metrics");
	assert.equal(config.logsUrl, "http://collector:4318/otlp/v1/logs");
});

test("resolveOpenTelemetryConfig supports per-signal protocol env overrides", () => {
	process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";
	process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/protobuf";
	process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = "http/json";
	process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "http/protobuf";
	const config = resolveOpenTelemetryConfig({ protocol: "http" });
	assert.equal(config.tracesProtocol, "proto");
	assert.equal(config.metricsProtocol, "http");
	assert.equal(config.logsProtocol, "proto");
	assert.equal(config.protocol, "proto");
});

test("resolveOpenTelemetryConfig supports grpc OTEL protocol and keeps generic endpoint as-is", () => {
	process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4317";
	process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
	const config = resolveOpenTelemetryConfig({});
	assert.equal(config.tracesProtocol, "grpc");
	assert.equal(config.metricsProtocol, "grpc");
	assert.equal(config.logsProtocol, "grpc");
	assert.equal(config.url, "http://collector:4317");
	assert.equal(config.metricsUrl, "http://collector:4317");
	assert.equal(config.logsUrl, "http://collector:4317");
});

test("resolveOpenTelemetryConfig uses config.url fallback for http/proto metrics and logs", () => {
	const config = resolveOpenTelemetryConfig({
		url: "http://collector:4318/otlp",
		protocol: "http/protobuf",
	});
	assert.equal(config.protocol, "proto");
	assert.equal(config.url, "http://collector:4318/otlp");
	assert.equal(config.metricsUrl, "http://collector:4318/otlp/v1/metrics");
	assert.equal(config.logsUrl, "http://collector:4318/otlp/v1/logs");
});

test("resolveOpenTelemetryConfig remaps generic trace path to metrics and logs when config.url is reused", () => {
	const config = resolveOpenTelemetryConfig({
		url: "http://collector:4318/v1/traces",
		protocol: "http",
	});
	assert.equal(config.url, "http://collector:4318/v1/traces");
	assert.equal(config.metricsUrl, "http://collector:4318/v1/metrics");
	assert.equal(config.logsUrl, "http://collector:4318/v1/logs");
});

test("resolveOpenTelemetryConfig grpc fallback ignores default http trace URL from config.url", () => {
	const config = resolveOpenTelemetryConfig({
		url: "http://localhost:4318/v1/traces",
		protocol: "grpc",
	});
	assert.equal(config.tracesProtocol, "grpc");
	assert.equal(config.metricsProtocol, "grpc");
	assert.equal(config.logsProtocol, "grpc");
	assert.equal(config.url, "http://localhost:4317");
	assert.equal(config.metricsUrl, "http://localhost:4317");
	assert.equal(config.logsUrl, "http://localhost:4317");
});

test("resolveOpenTelemetryConfig reads log level from env variable", () => {
	process.env.OTEL_LOG_LEVEL = "debug";
	const config = resolveOpenTelemetryConfig({});
	assert.equal(config.logLevel, "debug");
});

test("resolveOpenTelemetryConfig gives env log level precedence over explicit config", () => {
	process.env.OTEL_LOG_LEVEL = "error";
	const config = resolveOpenTelemetryConfig({ logLevel: "info" });
	assert.equal(config.logLevel, "error");
});

test("resolveOpenTelemetryConfig reads ignoredNodeTypes from env variable", () => {
	process.env.IGNORED_NODE_TYPES = "debug,catch,inject";
	const config = resolveOpenTelemetryConfig({});
	assert.equal(config.ignoredNodeTypes, "debug,catch,inject");
});

test("resolveOpenTelemetryConfig gives env ignoredNodeTypes precedence over explicit", () => {
	process.env.IGNORED_NODE_TYPES = "debug,catch,inject";
	const config = resolveOpenTelemetryConfig({ ignoredNodeTypes: "debug,catch" });
	assert.equal(config.ignoredNodeTypes, "debug,catch,inject");

	const explicit = resolveOpenTelemetryConfig({
		ignoredNodeTypes: "debug,inject",
	});
	assert.equal(explicit.ignoredNodeTypes, "debug,catch,inject");
});

test("resolveOpenTelemetryConfig preserves explicit empty ignoredNodeTypes", () => {
	delete process.env.IGNORED_NODE_TYPES;
	const config = resolveOpenTelemetryConfig({ ignoredNodeTypes: "" });
	assert.equal(config.ignoredNodeTypes, "");
});

test("resolveOpenTelemetryConfig appends signal paths for specific endpoints without path", () => {
	process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://trace:4318";
	process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = "http://metrics:4318";
	process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "http://logs:4318";
	const config = resolveOpenTelemetryConfig({});
	assert.equal(config.url, "http://trace:4318/v1/traces");
	assert.equal(config.metricsUrl, "http://metrics:4318/v1/metrics");
	assert.equal(config.logsUrl, "http://logs:4318/v1/logs");
});

test("resolveOpenTelemetryConfig preserves existing endpoint paths", () => {
	process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318/otlp";
	process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
		"http://trace-specific:4318/custom-traces";
	process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT =
		"http://metrics-specific:4318/custom-metrics";
	process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT =
		"http://logs-specific:4318/custom-logs";
	const config = resolveOpenTelemetryConfig({});
	assert.equal(config.url, "http://trace-specific:4318/custom-traces");
	assert.equal(config.metricsUrl, "http://metrics-specific:4318/custom-metrics");
	assert.equal(config.logsUrl, "http://logs-specific:4318/custom-logs");
});

test("resolveOpenTelemetryConfig keeps malformed env endpoint without throwing", () => {
	process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://[::1";
	const config = resolveOpenTelemetryConfig({});
	assert.equal(config.url, "http://[::1");
	assert.equal(config.metricsUrl, "http://[::1");
	assert.equal(config.logsUrl, "http://[::1");
});

test("resolveOpenTelemetryConfig enables metrics and logs when OTLP endpoint env is provided", () => {
	process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318";
	const config = resolveOpenTelemetryConfig({});
	assert.equal(config.tracesEnabled, true);
	assert.equal(config.metricsEnabled, true);
	assert.equal(config.logsEnabled, true);
});

test("resolveOpenTelemetryConfig respects OTEL_*_EXPORTER none to disable signals", () => {
	process.env.OTEL_TRACES_EXPORTER = "none";
	process.env.OTEL_METRICS_EXPORTER = "none";
	process.env.OTEL_LOGS_EXPORTER = "none";
	const config = resolveOpenTelemetryConfig({
		tracesEnabled: true,
		metricsEnabled: true,
		logsEnabled: true,
	});
	assert.equal(config.tracesEnabled, false);
	assert.equal(config.metricsEnabled, false);
	assert.equal(config.logsEnabled, false);
});

test("resolveOpenTelemetryConfig appends signal paths for explicit base node URLs", () => {
	const config = resolveOpenTelemetryConfig({
		url: "http://trace-explicit:4318",
		metricsUrl: "http://metrics-explicit:4318",
		logsUrl: "http://logs-explicit:4318",
	});
	assert.equal(config.url, "http://trace-explicit:4318/v1/traces");
	assert.equal(config.metricsUrl, "http://metrics-explicit:4318/v1/metrics");
	assert.equal(config.logsUrl, "http://logs-explicit:4318/v1/logs");
});

test("resolveOpenTelemetryConfig keeps explicit custom paths for node URLs", () => {
	const config = resolveOpenTelemetryConfig({
		url: "http://trace-explicit:4318/custom-traces",
		metricsUrl: "http://metrics-explicit:4318/custom-metrics",
		logsUrl: "http://logs-explicit:4318/custom-logs",
	});
	assert.equal(config.url, "http://trace-explicit:4318/custom-traces");
	assert.equal(config.metricsUrl, "http://metrics-explicit:4318/custom-metrics");
	assert.equal(config.logsUrl, "http://logs-explicit:4318/custom-logs");
});

test("maskUrlCredentials redacts password in URLs", () => {
	assert.equal(
		maskUrlCredentials("http://user:secret@collector:4318/v1/traces"),
		"http://user:***@collector:4318/v1/traces",
	);
	assert.equal(
		maskUrlCredentials("https://collector:4318/v1/traces"),
		"https://collector:4318/v1/traces",
	);
	assert.equal(maskUrlCredentials("http://[::1"), "http://[::1");
});

test("formatStartupConfigSummary masks credentials in endpoint URLs", () => {
	const summary = formatStartupConfigSummary({
		url: "http://user:trace-secret@trace:4318/v1/traces",
		metricsUrl: "http://metrics:4318/v1/metrics",
		logsUrl: "http://user:logs-secret@logs:4318/v1/logs",
		protocol: "http",
		tracesProtocol: "http",
		metricsProtocol: "http",
		logsProtocol: "http",
		serviceName: "Node-RED",
		tracesEnabled: true,
		metricsEnabled: true,
		logsEnabled: true,
		rootPrefix: "",
		ignoredNodeTypes: "debug,catch",
		propagateHeaderNodeTypes: "",
		logLevel: "warn",
		timeout: 10,
		attributeMappings: [],
	});
	assert.match(summary, /tracesUrl=http:\/\/user:\*\*\*@trace:4318\/v1\/traces/);
	assert.match(summary, /logsUrl=http:\/\/user:\*\*\*@logs:4318\/v1\/logs/);
	assert.doesNotMatch(summary, /trace-secret|logs-secret/);
});

test("createSpan creates parent and child spans for new messages", () => {
	const startedSpans = [];
	const tracer = {
		startSpan: (name, options) => {
			const span = createFakeSpan(name, options);
			startedSpans.push(span);
			return span;
		},
	};
	const span = createSpan(
		mockRed,
		tracer,
		{ _msgid: "1" },
		{ id: "node", type: "function", name: "Function", z: "flow" },
		{},
		false,
	);
	assert.equal(span.name, "Function");
	assert.equal(startedSpans.length, 2);
	const spansMap = getMsgSpans();
	assert.equal(spansMap.size, 1);
	const entry = spansMap.get("1");
	assert.equal(entry.parentSpan, startedSpans[0]);
	assert.ok(entry.spans.has("1#node"));
});

test("createSpan skips creation when span already exists", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "1" };
	const node = { id: "node", type: "function", name: "Function", z: "flow" };
	assert.ok(createSpan(mockRed, tracer, msg, node, {}, false));
	assert.equal(createSpan(mockRed, tracer, msg, node, {}, false), undefined);
});

test("createSpan stores fake span when tracing disabled for node", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "1" };
	const node = { id: "node", type: "function", name: "Function", z: "flow" };
	const span = createSpan(mockRed, tracer, msg, node, {}, true);
	assert.equal(typeof span.end, "function");
	const spansMap = getMsgSpans();
	const storedSpan = spansMap.get("1").spans.get("1#node");
	assert.notEqual(storedSpan, span);
	assert.equal(storedSpan.attributes["node_red.node.type"], "function");
});

test("endSpan ends child span and clears parent when last span completes", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "1" };
	const node = { id: "node", type: "function", name: "Function", z: "flow" };
	const childSpan = createSpan(mockRed, tracer, msg, node, {}, false);
	const entry = getMsgSpans().get("1");
	let parentEnded = false;
	entry.parentSpan.end = () => {
		parentEnded = true;
	};
	endSpan(mockRed, msg, null, node);
	assert.equal(childSpan.ended, true);
	assert.equal(parentEnded, true);
	assert.equal(getMsgSpans().size, 0);
});

test("deleteOutdatedMsgSpans removes outdated entries", () => {
	const parentSpan = createFakeSpan("parent");
	const now = Date.now();
	const spans = getMsgSpans();
	spans.set("msg", {
		parentSpan,
		spans: new Map(),
		updateTimestamp: now - 100,
	});
	setTimeoutMs(0);
	deleteOutdatedMsgSpans();
	assert.equal(spans.size, 0);
	assert.equal(parentSpan.ended, true);
	assert.ok(parentSpan.endTimestamp <= now - 100);
});

test("logEvent should not log when logging is disabled", () => {
	setLogLevel("off");
	const consoleLogSpy = test.mock.method(console, "log");
	logEvent(mockRed, {}, "test", {});
	assert.equal(consoleLogSpy.mock.calls.length, 0);
});

test("logEvent respects debug log level", () => {
	setLogLevel("debug");
	const consoleLogSpy = test.mock.method(console, "log");
	logEvent(mockRed, {}, "test", { msg: { _msgid: "1" } });
	assert.equal(consoleLogSpy.mock.calls.length, 1);
});

test("logEvent does not write debug output when level is warn", () => {
	setLogLevel("warn");
	const consoleLogSpy = test.mock.method(console, "log");
	logEvent(mockRed, {}, "test", { msg: { _msgid: "1" } });
	assert.equal(consoleLogSpy.mock.calls.length, 0);
});

test("logEvent emits structured OTel logs even when console log level is warn", () => {
	setLogLevel("warn");
	const logger = { emit: () => {} };
	const emitSpy = test.mock.method(logger, "emit");
	const sharedState = getSharedState();
	sharedState.logger = logger;
	logEvent(mockRed, {}, "test", { msg: { _msgid: "1" } });
	assert.equal(emitSpy.mock.calls.length, 1);
});

test("createSpan should handle various node types correctly", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "1", req: { headers: {} } };
	const httpNode = {
		id: "http-node",
		type: "http in",
		name: "HTTP In",
		z: "flow",
	};
	const tcpNode = { id: "tcp-node", type: "tcp in", name: "TCP In", z: "flow" };

	createSpan(mockRed, tracer, msg, httpNode, {}, false);
	const httpSpans = getMsgSpans().get("1");
	assert.ok(httpSpans.parentSpan);

	createSpan(mockRed, tracer, { _msgid: "2" }, tcpNode, {}, false);
	const tcpSpans = getMsgSpans().get("2");
	assert.ok(tcpSpans.parentSpan);
});

test("createSpan should extract trace context from different sources", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const mqttMsg = { _msgid: "3", userProperties: {} };
	const mqttNode = {
		id: "mqtt-node",
		type: "mqtt in",
		name: "MQTT In",
		z: "flow",
	};
	createSpan(mockRed, tracer, mqttMsg, mqttNode, {}, false);
	assert.ok(getMsgSpans().has("3"));

	const amqpMsg = { _msgid: "4", properties: { headers: {} } };
	const amqpNode = {
		id: "amqp-node",
		type: "amqp-in",
		name: "AMQP In",
		z: "flow",
	};
	createSpan(mockRed, tracer, amqpMsg, amqpNode, {}, false);
	assert.ok(getMsgSpans().has("4"));
});

test("endSpan should handle http request and response correctly", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = {
		_msgid: "1",
		statusCode: 200,
		responseUrl: "http://example.com/test",
	};
	const node = {
		id: "node",
		type: "http request",
		name: "HTTP Request",
		z: "flow",
	};
	const childSpan = createSpan(
		mockRed,
		tracer,
		{ _msgid: "1" },
		node,
		{},
		false,
	);
	endSpan(mockRed, msg, null, node);
	assert.equal(childSpan.ended, true);
	assert.deepEqual(childSpan.attributes["http.response.status_code"], 200);
});

test("endSpan auto-applies client HTTP response attributes for unknown node", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = {
		_msgid: "unknown-http-client",
		statusCode: 202,
		responseUrl: "http://example.com/queue/result",
	};
	const node = {
		id: "queue-client-node",
		type: "custom queue request",
		name: "Queue Request",
		z: "flow",
	};
	const childSpan = createSpan(
		mockRed,
		tracer,
		{ _msgid: "unknown-http-client" },
		node,
		{},
		false,
	);
	endSpan(mockRed, msg, null, node);
	assert.equal(childSpan.ended, true);
	assert.equal(childSpan.attributes["http.response.status_code"], 202);
	assert.equal(childSpan.attributes["url.path"], "/queue/result");
	assert.equal(childSpan.attributes["server.address"], "example.com");
});

test("endSpan should handle errors correctly", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "1", error: new Error("test error") };
	const node = { id: "node", type: "function", name: "Function", z: "flow" };
	const childSpan = createSpan(mockRed, tracer, msg, node, {}, false);
	const recordExceptionSpy = test.mock.method(childSpan, "recordException");
	endSpan(mockRed, msg, "error", node);
	assert.equal(recordExceptionSpy.mock.calls.length, 1);
});

test("endSpan should stringify non-Error exception objects", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "obj-error", error: { reason: "bad payload" } };
	const node = {
		id: "obj-node",
		type: "function",
		name: "Function",
		z: "flow",
	};
	const childSpan = createSpan(mockRed, tracer, msg, node, {}, false);
	const recordExceptionSpy = test.mock.method(childSpan, "recordException");
	endSpan(mockRed, msg, { code: 500 }, node);
	assert.equal(recordExceptionSpy.mock.calls.length, 1);
	assert.equal(typeof recordExceptionSpy.mock.calls[0].arguments[0], "string");
});

test("createSpan should handle websocket nodes correctly", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const wsInMsg = { _msgid: "ws-in" };
	const wsInNode = {
		id: "ws-in-node",
		type: "websocket in",
		name: "WS In",
		z: "flow",
		serverConfig: { path: "/ws/in" },
	};
	createSpan(mockRed, tracer, wsInMsg, wsInNode, {}, false);
	const wsInSpans = getMsgSpans().get("ws-in");
	assert.ok(wsInSpans.parentSpan);
	assert.deepEqual(wsInSpans.parentSpan.attributes["url.path"], "/ws/in");

	const wsOutMsg = { _msgid: "ws-out" };
	const wsOutNode = {
		id: "ws-out-node",
		type: "websocket out",
		name: "WS Out",
		z: "flow",
		serverConfig: { path: "ws://localhost:1880/ws/out" },
	};
	const wsOutSpan = createSpan(mockRed, tracer, wsOutMsg, wsOutNode, {}, false);
	assert.ok(wsOutSpan);
	assert.deepEqual(wsOutSpan.attributes["url.path"], "/ws/out");
	assert.deepEqual(wsOutSpan.attributes["server.address"], "localhost");
	assert.deepEqual(wsOutSpan.attributes["server.port"], "1880");
	assert.deepEqual(wsOutSpan.attributes["url.scheme"], "ws");

});

test("createSpan websocket out should support relative serverConfig path", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const wsOutRelativeMsg = { _msgid: "ws-out-relative" };
	const wsOutRelativeNode = {
		id: "ws-out-relative-node",
		type: "websocket out",
		name: "WS Out Relative",
		z: "flow",
		serverConfig: { path: "/ws/events" },
	};
	const wsOutRelativeSpan = createSpan(
		mockRed,
		tracer,
		wsOutRelativeMsg,
		wsOutRelativeNode,
		{},
		false,
	);
	assert.ok(wsOutRelativeSpan);
	assert.deepEqual(wsOutRelativeSpan.attributes["url.path"], "/ws/events");
	assert.equal(wsOutRelativeSpan.attributes["server.address"], undefined);
	assert.equal(wsOutRelativeSpan.attributes["server.port"], undefined);
	assert.equal(wsOutRelativeSpan.attributes["url.scheme"], undefined);
});

test("createSpan websocket out should keep malformed endpoint as url.path", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "ws-out-malformed" };
	const node = {
		id: "ws-out-malformed-node",
		type: "websocket out",
		name: "WS Out Malformed",
		z: "flow",
		serverConfig: { path: "http://[::1" },
	};
	const span = createSpan(mockRed, tracer, msg, node, {}, false);
	assert.ok(span);
	assert.equal(span.attributes["url.path"], "http://[::1");
	assert.equal(span.attributes["server.address"], undefined);
	assert.equal(span.attributes["server.port"], undefined);
	assert.equal(span.attributes["url.scheme"], undefined);
});

test("endSpan should ignore malformed responseUrl without throwing", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const node = {
		id: "http-request-malformed-url",
		type: "http request",
		name: "HTTP Request",
		z: "flow",
	};
	const childSpan = createSpan(
		mockRed,
		tracer,
		{ _msgid: "malformed-response-url" },
		node,
		{},
		false,
	);
	assert.doesNotThrow(() => {
		endSpan(
			mockRed,
			{
				_msgid: "malformed-response-url",
				statusCode: 200,
				responseUrl: "http://[::1",
			},
			null,
			node,
		);
	});
	assert.equal(childSpan.ended, true);
});

test("createSpan auto-enriches unknown node with HTTP-like message context", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = {
		_msgid: "unknown-http-like",
		req: {
			method: "post",
			path: "/queue/consume",
			ip: "10.0.0.8",
			headers: {
				"user-agent": "test-agent",
			},
		},
		topic: "orders",
		queue: "orders-queue",
	};
	const node = {
		id: "queue-node",
		type: "custom queue in",
		name: "Queue In",
		z: "flow",
	};
	const span = createSpan(mockRed, tracer, msg, node, {}, false);
	assert.ok(span);
	assert.equal(msg.otelStartTime !== undefined, true);
	assert.equal(span.attributes["http.request.method"], "POST");
	assert.equal(span.attributes["url.path"], "/queue/consume");
	assert.equal(span.attributes["client.address"], "10.0.0.8");
	assert.equal(span.attributes["node_red.msg.topic"], "orders");
	assert.equal(span.attributes["node_red.msg.queue"], "orders-queue");
});

test("createSpan auto-enriches unknown node endpoint path from node config", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "unknown-endpoint" };
	const node = {
		id: "custom-endpoint-node",
		type: "custom endpoint",
		name: "Custom Endpoint",
		z: "flow",
		serverConfig: { path: "/mq/events" },
	};
	const span = createSpan(mockRed, tracer, msg, node, {}, false);
	assert.ok(span);
	assert.equal(span.attributes["url.path"], "/mq/events");
});

test("endSpan should set span status to ERROR on error", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "1" };
	const node = { id: "node", type: "function", name: "Function", z: "flow" };
	const childSpan = createSpan(mockRed, tracer, msg, node, {}, false);
	const setStatusSpy = test.mock.method(childSpan, "setStatus");
	const parentSpan = getMsgSpans().get("1").parentSpan;
	const parentSetStatusSpy = test.mock.method(parentSpan, "setStatus");
	endSpan(mockRed, msg, new Error("test error"), node);
	assert.equal(setStatusSpy.mock.calls.length, 1);
	assert.deepEqual(setStatusSpy.mock.calls[0].arguments[0].code, 2); // 2 = ERROR
	assert.equal(parentSetStatusSpy.mock.calls.length, 1);
});

test("endSpan records http metrics even when there is no active span", () => {
	const sharedState = getSharedState();
	const recordSpy = test.mock.fn();
	sharedState.metrics.requestDuration = { record: recordSpy };
	const startTime = Date.now() - 50;
	endSpan(
		mockRed,
		{
			_msgid: "metrics-only-msg",
			otelStartTime: startTime,
			req: { method: "GET", path: "/health" },
			res: { _res: { statusCode: 204 } },
		},
		null,
		{ id: "http-response", type: "http response", z: "flow" },
	);
	assert.equal(recordSpy.mock.calls.length, 1);
	const call = recordSpy.mock.calls[0];
	assert.equal(typeof call.arguments[0], "number");
	assert.ok(call.arguments[0] >= 0);
	assert.deepEqual(call.arguments[1], {
		"http.response.status_code": 204,
		"http.request.method": "GET",
		"url.path": "/health",
	});
});

test("endSpan records http metrics only once per message", () => {
	const sharedState = getSharedState();
	const recordSpy = test.mock.fn();
	sharedState.metrics.requestDuration = { record: recordSpy };
	const msg = {
		_msgid: "metrics-once-msg",
		otelStartTime: Date.now() - 25,
		req: { method: "GET", path: "/once" },
		res: { _res: { statusCode: 200 } },
	};
	const node = { id: "resp-node", type: "http response", z: "flow" };

	endSpan(mockRed, msg, null, node);
	endSpan(mockRed, msg, null, node);

	assert.equal(recordSpy.mock.calls.length, 1);
	assert.equal(msg.otelHttpMetricsRecorded, true);
});

test("endSpan records http metrics once across cloned messages with same _msgid", () => {
	const sharedState = getSharedState();
	const recordSpy = test.mock.fn();
	sharedState.metrics.requestDuration = { record: recordSpy };
	const node = { id: "resp-node", type: "http response", z: "flow" };

	const msgCloneA = {
		_msgid: "metrics-clone-msg",
		otelStartTime: Date.now() - 25,
		req: { method: "GET", path: "/clone" },
		res: { _res: { statusCode: 200 } },
	};
	const msgCloneB = {
		_msgid: "metrics-clone-msg",
		otelStartTime: Date.now() - 25,
		req: { method: "GET", path: "/clone" },
		res: { _res: { statusCode: 200 } },
	};

	endSpan(mockRed, msgCloneA, null, node);
	endSpan(mockRed, msgCloneB, null, node);

	assert.equal(recordSpy.mock.calls.length, 1);
});

test("endSpan records terminal HTTP metrics for custom responder when response is finished", () => {
	const sharedState = getSharedState();
	const recordSpy = test.mock.fn();
	sharedState.metrics.requestDuration = { record: recordSpy };
	const node = { id: "custom-responder", type: "custom responder", z: "flow" };
	const msg = {
		_msgid: "metrics-custom-terminal",
		otelStartTime: Date.now() - 40,
		req: { method: "GET", path: "/custom" },
		res: { _res: { statusCode: 204, finished: true } },
	};

	endSpan(mockRed, msg, null, node);

	assert.equal(recordSpy.mock.calls.length, 1);
	assert.equal(msg.otelHttpMetricsRecorded, true);
});

test("endSpan records metrics for different messages independently", () => {
	const sharedState = getSharedState();
	const recordSpy = test.mock.fn();
	sharedState.metrics.requestDuration = { record: recordSpy };
	const node = { id: "resp-node", type: "http response", z: "flow" };

	const msgA = {
		_msgid: "metrics-a",
		otelStartTime: Date.now() - 20,
		req: { method: "GET", path: "/a" },
		res: { _res: { statusCode: 200 } },
	};
	const msgB = {
		_msgid: "metrics-b",
		otelStartTime: Date.now() - 30,
		req: { method: "POST", path: "/b" },
		res: { _res: { statusCode: 201 } },
	};

	endSpan(mockRed, msgA, null, node);
	endSpan(mockRed, msgB, null, node);

	assert.equal(recordSpy.mock.calls.length, 2);
	assert.equal(msgA.otelHttpMetricsRecorded, true);
	assert.equal(msgB.otelHttpMetricsRecorded, true);
});

test("endSpan skips metrics when otelStartTime is missing", () => {
	const sharedState = getSharedState();
	const recordSpy = test.mock.fn();
	sharedState.metrics.requestDuration = { record: recordSpy };
	const msg = {
		_msgid: "metrics-no-start",
		req: { method: "GET", path: "/missing" },
		res: { _res: { statusCode: 200 } },
	};
	const node = { id: "resp-node", type: "http response", z: "flow" };

	endSpan(mockRed, msg, null, node);

	assert.equal(recordSpy.mock.calls.length, 0);
	assert.equal(msg.otelHttpMetricsRecorded, undefined);
});

test("endSpan does not apply server response status for non-terminal custom nodes", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = {
		_msgid: "unknown-http-response",
		req: { method: "GET", path: "/orders" },
		res: { _res: { statusCode: 200 } },
	};
	const rootNode = {
		id: "root-node",
		type: "custom ingress",
		name: "Ingress",
		z: "flow",
		method: "GET",
	};
	const endNode = {
		id: "resp-node",
		type: "custom responder",
		name: "Responder",
		z: "flow",
	};
	createSpan(mockRed, tracer, msg, rootNode, {}, false);
	const endSpanRef = createSpan(mockRed, tracer, msg, endNode, {}, false);
	const parent = getMsgSpans().get("unknown-http-response");
	const rootSpanId = "unknown-http-response#root-node";
	const rootSpan = parent.spans.get(rootSpanId);
	assert.ok(rootSpan);
	assert.ok(endSpanRef);
	const parentStatusSpy = test.mock.method(parent.parentSpan, "setStatus");

	endSpan(mockRed, msg, null, endNode);
	assert.equal(endSpanRef.ended, true);
	assert.equal(parentStatusSpy.mock.calls.length, 0);
	assert.equal(parent.parentSpan.attributes["http.response.status_code"], undefined);
});

test("endSpan applies response status to root span for terminal http response node", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = {
		_msgid: "unknown-http-response-error",
		req: { method: "GET", path: "/orders" },
		res: { _res: { statusCode: 500 } },
	};
	const rootNode = {
		id: "root-node-error",
		type: "custom ingress",
		name: "Ingress",
		z: "flow",
		method: "GET",
	};
	const endNode = {
		id: "resp-node-error",
		type: "http response",
		name: "HTTP Response",
		z: "flow",
	};
	createSpan(mockRed, tracer, msg, rootNode, {}, false);
	const endSpanRef = createSpan(mockRed, tracer, msg, endNode, {}, false);
	const parent = getMsgSpans().get("unknown-http-response-error");
	assert.ok(parent);
	assert.ok(endSpanRef);
	const parentStatusSpy = test.mock.method(parent.parentSpan, "setStatus");

	endSpan(mockRed, msg, null, endNode);

	assert.equal(endSpanRef.ended, true);
	assert.equal(parentStatusSpy.mock.calls.length, 1);
	assert.equal(parentStatusSpy.mock.calls[0].arguments[0].code, 2); // ERROR
	assert.equal(parent.parentSpan.attributes["http.response.status_code"], 500);
});

test("endSpan applies response status to root span for custom terminal responder", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = {
		_msgid: "unknown-http-response-custom-terminal",
		req: { method: "GET", path: "/orders" },
		res: { _res: { statusCode: 201, finished: true } },
	};
	const rootNode = {
		id: "root-node-custom-terminal",
		type: "custom ingress",
		name: "Ingress",
		z: "flow",
		method: "GET",
	};
	const endNode = {
		id: "resp-node-custom-terminal",
		type: "custom responder",
		name: "Responder",
		z: "flow",
	};
	createSpan(mockRed, tracer, msg, rootNode, {}, false);
	const endSpanRef = createSpan(mockRed, tracer, msg, endNode, {}, false);
	const parent = getMsgSpans().get("unknown-http-response-custom-terminal");
	assert.ok(parent);
	assert.ok(endSpanRef);
	const parentStatusSpy = test.mock.method(parent.parentSpan, "setStatus");

	endSpan(mockRed, msg, null, endNode);

	assert.equal(endSpanRef.ended, true);
	assert.equal(parentStatusSpy.mock.calls.length, 1);
	assert.equal(parent.parentSpan.attributes["http.response.status_code"], 201);
});

test("endSpan keeps error status when terminal response has 2xx status", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = {
		_msgid: "error-with-2xx-response",
		req: { method: "POST", path: "/orders" },
		res: { _res: { statusCode: 201 } },
	};
	const rootNode = {
		id: "root-node-error-2xx",
		type: "custom ingress",
		name: "Ingress",
		z: "flow",
		method: "POST",
	};
	const endNode = {
		id: "resp-node-error-2xx",
		type: "http response",
		name: "HTTP Response",
		z: "flow",
	};
	createSpan(mockRed, tracer, msg, rootNode, {}, false);
	const endSpanRef = createSpan(mockRed, tracer, msg, endNode, {}, false);
	const parent = getMsgSpans().get("error-with-2xx-response");
	assert.ok(parent);
	assert.ok(endSpanRef);
	const childSetStatusSpy = test.mock.method(endSpanRef, "setStatus");
	const parentSetStatusSpy = test.mock.method(parent.parentSpan, "setStatus");

	endSpan(mockRed, msg, new Error("request failed"), endNode);

	const childStatusCodes = childSetStatusSpy.mock.calls
		.map((call) => call.arguments[0]?.code)
		.filter((code) => typeof code === "number");
	const parentStatusCodes = parentSetStatusSpy.mock.calls
		.map((call) => call.arguments[0]?.code)
		.filter((code) => typeof code === "number");
	assert.ok(childStatusCodes.includes(2));
	assert.ok(parentStatusCodes.includes(2));
	assert.equal(childStatusCodes.includes(1), false);
	assert.equal(parentStatusCodes.includes(1), false);
});

function createPluginHarness(withHookListeners: boolean = false) {
	let runtimePlugin: any;
	const hooks = withHookListeners
		? {
				listeners: {},
				add: function (name, listener) {
					this.listeners[name] = listener;
				},
				remove: function (pattern) {
					if (!pattern || !String(pattern).startsWith(".")) {
						delete this.listeners[pattern];
						return;
					}
					Object.keys(this.listeners)
						.filter((name) => name.endsWith(pattern.substring(1)))
						.forEach((name) => {
							delete this.listeners[name];
						});
				},
			}
		: {
				add: () => {},
				remove: () => {},
			};
	const mockRed: any = {
		nodes: {
			getNode: (id) => ({ name: `Flow ${id}` }),
		},
		settings: {},
		hooks,
		plugins: {
			registerPlugin: (_id, plugin) => {
				runtimePlugin = {
					onSettings: async (settings) => {
						mockRed.settings.opentelemetry =
							(settings && settings.opentelemetry) || settings || {};
						return plugin.onadd?.();
					},
					onClose: async () => plugin.onremove?.(),
				};
			},
		},
	};

	assert.doesNotThrow(() => {
		otelModule(mockRed);
	});
	return { runtimePlugin, mockRed };
}

test("postDeliver.otel hook injects trace context for http and mqtt", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			ignoredNodeTypes: "",
			propagateHeaderNodeTypes: "http request,mqtt out",
			logLevel: "off",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const postDeliverListener = mockRed.hooks.listeners["postDeliver.otel"];
	assert.ok(postDeliverListener);

	const httpSendEvent = {
		msg: { _msgid: "http-msg" },
		source: { node: { id: "source-node", type: "function", z: "flow" } },
		destination: { node: { id: "dest-node", type: "http request", z: "flow" } },
	};
	postDeliverListener(httpSendEvent);
	assert.ok(httpSendEvent.msg.headers);
	assert.ok(httpSendEvent.msg.headers.traceparent);

	const mqttSendEvent = {
		msg: { _msgid: "mqtt-msg" },
		source: { node: { id: "source-node", type: "function", z: "flow" } },
		destination: { node: { id: "dest-node", type: "mqtt out", z: "flow" } },
	};
	postDeliverListener(mqttSendEvent);
	assert.ok(mqttSendEvent.msg.userProperties);
	assert.ok(mqttSendEvent.msg.userProperties.traceparent);

	await runtimePlugin.onClose();
});

test("preDeliver.otel hook clears all propagated trace headers safely", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			ignoredNodeTypes: "",
			propagateHeaderNodeTypes: "function",
			logLevel: "off",
			timeout: 10,
			attributeMappings: [],
		},
	});

	const preDeliverListener = mockRed.hooks.listeners["preDeliver.otel"];
	assert.ok(preDeliverListener);

	const sendEvent = {
		source: { node: { type: "function" } },
		msg: {
			headers: {
				traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
				tracestate: "vendor=value",
				baggage: "k=v",
				"x-b3-traceid": "80f198ee56343ba864fe8b2a57d3eff7",
				"x-b3-spanid": "e457b5a2e4d86bd1",
				"x-b3-sampled": "1",
			},
		},
	};
	preDeliverListener(sendEvent);
	assert.equal(sendEvent.msg.headers.traceparent, undefined);
	assert.equal(sendEvent.msg.headers.tracestate, undefined);
	assert.equal(sendEvent.msg.headers.baggage, undefined);
	assert.equal(sendEvent.msg.headers["x-b3-traceid"], undefined);
	assert.equal(sendEvent.msg.headers["x-b3-spanid"], undefined);
	assert.equal(sendEvent.msg.headers["x-b3-sampled"], undefined);

	await runtimePlugin.onClose();
});

test("onReceive.otel hook sets otelRootMsgId for split nodes", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);

	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			ignoredNodeTypes: "",
			propagateHeaderNodeTypes: "",
		},
	});

	const onReceiveListener = mockRed.hooks.listeners["onReceive.otel"];
	assert.ok(onReceiveListener);

	const splitEvent = {
		msg: { _msgid: "original-msg-id" },
		destination: { node: { id: "split-node", type: "split" } },
	};
	onReceiveListener(splitEvent);
	assert.equal(splitEvent.msg.otelRootMsgId, "original-msg-id");

	const otherEvent = {
		msg: { _msgid: "other-msg-id" },
		destination: { node: { id: "other-node", type: "function" } },
	};
	onReceiveListener(otherEvent);
	assert.equal(otherEvent.msg.otelRootMsgId, undefined);

	await runtimePlugin.onClose();
});

test("runtime plugin onSettings does not create providers when all signals are disabled", async () => {
	const { runtimePlugin } = createPluginHarness(false);
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			metricsUrl: "http://localhost:4318/v1/metrics",
			logsUrl: "http://localhost:4318/v1/logs",
			tracesEnabled: false,
			metricsEnabled: false,
			logsEnabled: false,
		},
	});
	const sharedState = getSharedState();
	assert.equal(sharedState.provider, null);
	assert.equal(sharedState.meterProvider, null);
	assert.equal(sharedState.loggerProvider, null);
});

test("runtime plugin onSettings creates only configured signal providers", async () => {
	const { runtimePlugin } = createPluginHarness(false);
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			metricsUrl: "http://localhost:4318/v1/metrics",
			logsUrl: "http://localhost:4318/v1/logs",
			tracesEnabled: false,
			metricsEnabled: true,
			logsEnabled: true,
		},
	});
	const sharedState = getSharedState();
	assert.equal(sharedState.provider, null);
	assert.ok(sharedState.meterProvider);
	assert.ok(sharedState.loggerProvider);
	await runtimePlugin.onClose();
});

test("runtime plugin registers and removes Node-RED runtime log handler with logs signal", async () => {
	const { runtimePlugin } = createPluginHarness(false);
	assert.ok(runtimePlugin);
	assert.equal(nodeRedUtilStub.log.handlerCount(), 0);
	await runtimePlugin.onSettings({
		opentelemetry: {
			logsEnabled: true,
			logsUrl: "http://localhost:4318/v1/logs",
			tracesEnabled: false,
			metricsEnabled: false,
			logLevel: "off",
		},
	});
	assert.equal(nodeRedUtilStub.log.handlerCount(), 1);
	await runtimePlugin.onSettings({
		opentelemetry: {
			logsEnabled: false,
			logsUrl: "http://localhost:4318/v1/logs",
			tracesEnabled: false,
			metricsEnabled: false,
			logLevel: "off",
		},
	});
	assert.equal(nodeRedUtilStub.log.handlerCount(), 0);
	await runtimePlugin.onClose();
	assert.equal(nodeRedUtilStub.log.handlerCount(), 0);
});

test("runtime plugin forwards Node-RED runtime logs to OTel logger", async () => {
	const { runtimePlugin } = createPluginHarness(false);
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			logsEnabled: true,
			logsUrl: "http://localhost:4318/v1/logs",
			tracesEnabled: false,
			metricsEnabled: false,
			logLevel: "off",
		},
	});
	const logger = getSharedState().logger;
	assert.ok(logger);
	const emitSpy = test.mock.method(logger, "emit");
	nodeRedUtilStub.log.emit({
		level: nodeRedUtilStub.log.ERROR,
		msg: "Started flows",
		type: "runtime",
		id: "runtime-id",
		name: "runtime-name",
	});
	assert.equal(emitSpy.mock.calls.length, 1);
	assert.equal(emitSpy.mock.calls[0].arguments[0].body, "Started flows");
	assert.equal(emitSpy.mock.calls[0].arguments[0].severityText, "ERROR");
	assert.equal(
		emitSpy.mock.calls[0].arguments[0].attributes["node_red.log.type"],
		"runtime",
	);
	await runtimePlugin.onClose();
});

test("runtime plugin shutdown should not disable global OpenTelemetry APIs", async () => {
	const { runtimePlugin } = createPluginHarness(false);
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
		},
	});
	const traceDisableSpy = test.mock.method(otelApi.trace, "disable");
	const metricsDisableSpy = test.mock.method(otelApi.metrics, "disable");
	const logsDisableSpy = test.mock.method(otelLogsApi.logs, "disable");
	await runtimePlugin.onClose();
	assert.equal(traceDisableSpy.mock.calls.length, 0);
	assert.equal(metricsDisableSpy.mock.calls.length, 0);
	assert.equal(logsDisableSpy.mock.calls.length, 0);
});

test("module initialization tolerates duplicate runtime plugin registration", () => {
	const registeredPlugins = new Set();
	const mockRed = {
		hooks: { add: () => {}, remove: () => {} },
		plugins: {
			registerPlugin: (id) => {
				if (registeredPlugins.has(id)) {
					throw new Error(`${id} already registered`);
				}
				registeredPlugins.add(id);
			},
		},
	};
	assert.doesNotThrow(() => {
		otelModule(mockRed);
		otelModule(mockRed);
	});
	assert.equal(registeredPlugins.has("opentelemetry-runtime"), true);
});

test("module initialization tolerates plugin-only Node-RED context", async () => {
	let runtimePlugin: any;
	const mockRed = {
		settings: {},
		plugins: {
			registerPlugin: (_id, plugin) => {
				runtimePlugin = {
					onSettings: async (settings) => {
						mockRed.settings.opentelemetry =
							(settings && settings.opentelemetry) || settings || {};
						return plugin.onadd?.();
					},
					onClose: async () => plugin.onremove?.(),
				};
			},
		},
	};
	assert.doesNotThrow(() => {
		otelModule(mockRed);
	});
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
		},
	});
	assert.equal(getSharedState().hooksRegistered, false);
	await runtimePlugin.onClose();
});

test("runtime plugin onSettings updates runtime config", async () => {
	const { runtimePlugin } = createPluginHarness(false);
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			logLevel: "warn",
			timeout: 10,
		},
	});
	assert.equal(getSharedState().logLevel, "warn");
	assert.equal(getSharedState().timeout, 10000);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			logLevel: "debug",
			timeout: 3,
		},
	});
	assert.equal(getSharedState().logLevel, "debug");
	assert.equal(getSharedState().timeout, 3000);
	await runtimePlugin.onClose();
});

test("runtime plugin onSettings reconfigures active providers", async () => {
	const { runtimePlugin } = createPluginHarness(false);
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			tracesEnabled: true,
			metricsEnabled: false,
			logsEnabled: false,
		},
	});
	assert.ok(getSharedState().provider);
	assert.equal(getSharedState().meterProvider, null);
	assert.equal(getSharedState().loggerProvider, null);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			metricsUrl: "http://localhost:4318/v1/metrics",
			logsUrl: "http://localhost:4318/v1/logs",
			tracesEnabled: false,
			metricsEnabled: true,
			logsEnabled: true,
		},
	});
	assert.equal(getSharedState().provider, null);
	assert.ok(getSharedState().meterProvider);
	assert.ok(getSharedState().loggerProvider);
	await runtimePlugin.onClose();
});

test("runtime plugin onSettings awaits provider shutdown before reconfigure", async () => {
	const { runtimePlugin } = createPluginHarness(false);
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			tracesEnabled: true,
			metricsEnabled: false,
			logsEnabled: false,
		},
	});
	const sharedState = getSharedState();
	assert.ok(sharedState.provider);
	const oldProvider = sharedState.provider;
	let resolveShutdown: any;
	let shutdownCompleted = false;
	oldProvider.shutdown = () =>
		new Promise((resolve) => {
			resolveShutdown = () => {
				shutdownCompleted = true;
				resolve();
			};
		});
	const reconfigurePromise = runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			tracesEnabled: true,
			metricsEnabled: false,
			logsEnabled: false,
		},
	});
	await Promise.resolve();
	assert.equal(shutdownCompleted, false);
	resolveShutdown();
	await reconfigurePromise;
	assert.equal(shutdownCompleted, true);
	assert.notEqual(getSharedState().provider, oldProvider);
	await runtimePlugin.onClose();
});

test("onSend.otel hook creates spans for every event in batch", async () => {
	const { runtimePlugin, mockRed } = createPluginHarness(true);
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			protocol: "http",
			serviceName: "test-service",
			rootPrefix: "",
			ignoredNodeTypes: "",
			propagateHeaderNodeTypes: "",
			logLevel: "off",
			timeout: 10,
			attributeMappings: [],
		},
	});
	const onSendListener = mockRed.hooks.listeners["onSend.otel"];
	assert.ok(onSendListener);
	onSendListener([
		{
			msg: { _msgid: "a" },
			source: { node: { id: "node-a", type: "function", z: "flow-a" } },
		},
		{
			msg: { _msgid: "b" },
			source: { node: { id: "node-b", type: "function", z: "flow-b" } },
		},
	]);
	assert.equal(getMsgSpans().size, 2);
	await runtimePlugin.onClose();
});

test("runtime plugin onClose waits for provider shutdown before resolving", async () => {
	const { runtimePlugin } = createPluginHarness(false);
	assert.ok(runtimePlugin);
	await runtimePlugin.onSettings({
		opentelemetry: {
			url: "http://localhost:4318/v1/traces",
			tracesEnabled: true,
			metricsEnabled: false,
			logsEnabled: false,
		},
	});
	const sharedState = getSharedState();
	assert.ok(sharedState.provider);
	let resolveShutdown: any;
	sharedState.provider.shutdown = () =>
		new Promise((resolve) => {
			resolveShutdown = resolve;
		});
	let closeResolved = false;
	const closePromise = runtimePlugin.onClose().then(() => {
		closeResolved = true;
	});
	await Promise.resolve();
	assert.equal(closeResolved, false);
	resolveShutdown();
	await closePromise;
	assert.equal(closeResolved, true);
});

test("endSpan should handle orphan spans from switch nodes", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "1" };
	const switchNode = {
		id: "switch-node",
		type: "switch",
		name: "Switch",
		z: "flow",
	};
	const functionNode = {
		id: "function-node",
		type: "function",
		name: "Function",
		z: "flow",
	};

	// Create a parent span and a switch span
	createSpan(mockRed, tracer, msg, switchNode, {}, false);
	const parent = getMsgSpans().get("1");
	assert.ok(parent);

	// Create a function span that will be ended
	const functionSpan = createSpan(
		mockRed,
		tracer,
		msg,
		functionNode,
		{},
		false,
	);
	assert.ok(functionSpan);

	// End the function span. This should trigger the orphan logic for the switch span.
	endSpan(mockRed, msg, null, functionNode);

	// The parent span should be ended because the only remaining child is an orphan
	assert.equal(getMsgSpans().size, 0);
});

test("endSpan keeps parent active when remaining child span is non-orphan", () => {
	const tracer = {
		startSpan: (name, options) => createFakeSpan(name, options),
	};
	const msg = { _msgid: "active-child-msg" };
	const functionNodeA = {
		id: "function-node-a",
		type: "function",
		name: "Function A",
		z: "flow",
	};
	const functionNodeB = {
		id: "function-node-b",
		type: "function",
		name: "Function B",
		z: "flow",
	};

	createSpan(mockRed, tracer, msg, functionNodeA, {}, false);
	createSpan(mockRed, tracer, msg, functionNodeB, {}, false);
	endSpan(mockRed, msg, null, functionNodeA);

	const parent = getMsgSpans().get("active-child-msg");
	assert.ok(parent);
	assert.equal(parent.spans.has("active-child-msg#function-node-b"), true);
});



