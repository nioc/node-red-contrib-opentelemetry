const test = require("node:test");
const assert = require("node:assert/strict");
const otelModule = require("../lib/opentelemetry-node");

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
	setLogging,
	resolveOpenTelemetryConfig,
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
});

test.afterEach(() => {
	resetState();
	resetEnv();
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
	assert.equal(config.protocol, "proto");
	assert.equal(config.serviceName, "env-service");
});

test("resolveOpenTelemetryConfig keeps explicit node settings over env values", () => {
	process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
		"http://collector:4318/v1/traces";
	process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/json";
	process.env.OTEL_SERVICE_NAME = "env-service";
	const config = resolveOpenTelemetryConfig({
		url: "http://custom:4318/v1/traces",
		protocol: "proto",
		serviceName: "custom-service",
	});
	assert.equal(config.url, "http://custom:4318/v1/traces");
	assert.equal(config.protocol, "proto");
	assert.equal(config.serviceName, "custom-service");
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
	setLogging(false);
	const consoleLogSpy = test.mock.method(console, "log");
	logEvent(mockRed, {}, "test", {});
	assert.equal(consoleLogSpy.mock.calls.length, 0);
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
	const childSpan = createSpan(mockRed, tracer, { _msgid: "1" }, node, {}, false);
	endSpan(mockRed, msg, null, node);
	assert.equal(childSpan.ended, true);
	assert.deepEqual(childSpan.attributes["http.response.status_code"], 200);
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

test("postDeliver.otel hook injects trace context for http and mqtt", async (t) => {
	let NodeConstructor;
	const mockRed = {
		nodes: {
			createNode: function (node, config) {
				Object.assign(node, config);
			},
			registerType: (name, constructor) => {
				NodeConstructor = constructor;
			},
		},
		hooks: {
			listeners: {},
			add: function (name, listener) {
				this.listeners[name] = listener;
			},
			remove: function (pattern) {
				Object.keys(this.listeners)
					.filter((name) => name.endsWith(pattern.substring(1)))
					.forEach((name) => delete this.listeners[name]);
			},
		},
	};

	otelModule(mockRed);

	let closeHandler;
	const nodeInstance = {
		on: (event, handler) => {
			if (event === "close") closeHandler = handler;
		},
		status: () => {},
	};

	const config = {
		url: "http://localhost:4318/v1/traces",
		protocol: "http",
		serviceName: "test-service",
		rootPrefix: "",
		ignoredTypes: "",
		propagateHeadersTypes: "http request,mqtt out",
		isLogging: false,
		timeout: 10,
		attributeMappings: [],
	};

	NodeConstructor.call(nodeInstance, config);

	const postDeliverListener = mockRed.hooks.listeners["postDeliver.otel"];
	assert.ok(postDeliverListener);

	// Test http request
	const httpSendEvent = {
		msg: { _msgid: "http-msg" },
		source: { node: { id: "source-node", type: "function" } },
		destination: { node: { id: "dest-node", type: "http request" } },
	};
	postDeliverListener(httpSendEvent);
	assert.ok(httpSendEvent.msg.headers, "headers should be present");
	assert.ok(
		httpSendEvent.msg.headers.traceparent,
		"traceparent header should be injected",
	);

	// Test mqtt out
	const mqttSendEvent = {
		msg: { _msgid: "mqtt-msg" },
		source: { node: { id: "source-node", type: "function" } },
		destination: { node: { id: "dest-node", type: "mqtt out" } },
	};
	postDeliverListener(mqttSendEvent);
	assert.ok(
		mqttSendEvent.msg.userProperties,
		"userProperties should be present",
	);
	assert.ok(
		mqttSendEvent.msg.userProperties.traceparent,
		"traceparent should be in userProperties",
	);

	// Test non-propagated type
	const functionSendEvent = {
		msg: { _msgid: "func-msg" },
		source: { node: { id: "source-node", type: "function" } },
		destination: { node: { id: "dest-node", type: "function" } },
	};
	postDeliverListener(functionSendEvent);
	assert.equal(
		functionSendEvent.msg.headers,
		undefined,
		"headers should not be added",
	);

	// cleanup
	await closeHandler.call(nodeInstance);
});

test("preDeliver.otel hook clears all propagated trace headers safely", () => {
	let NodeConstructor;
	const mockRed = {
		nodes: {
			createNode: function (node, config) {
				Object.assign(node, config);
			},
			registerType: (_name, constructor) => {
				NodeConstructor = constructor;
			},
		},
		hooks: {
			listeners: {},
			add: function (name, listener) {
				this.listeners[name] = listener;
			},
			remove: () => {},
		},
	};

	otelModule(mockRed);

	const nodeInstance = {
		on: () => {},
		status: () => {},
	};
	NodeConstructor.call(nodeInstance, {
		url: "http://localhost:4318/v1/traces",
		protocol: "http",
		serviceName: "test-service",
		rootPrefix: "",
		ignoredTypes: "",
		propagateHeadersTypes: "function",
		isLogging: false,
		timeout: 10,
		attributeMappings: [],
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

	const noHeadersEvent = {
		source: { node: { type: "function" } },
		msg: {},
	};
	assert.doesNotThrow(() => preDeliverListener(noHeadersEvent));
	assert.deepEqual(noHeadersEvent.msg.headers, {});
});

test("onReceive.otel hook sets otelRootMsgId for split nodes", () => {
	let NodeConstructor;
	const mockRed = {
		nodes: {
			createNode: function (node, config) {
				Object.assign(node, config);
			},
			registerType: (name, constructor) => {
				NodeConstructor = constructor;
			},
		},
		hooks: {
			listeners: {},
			add: function (name, listener) {
				this.listeners[name] = listener;
			},
			remove: () => {},
		},
	};
	otelModule(mockRed);

	const nodeInstance = { on: () => {}, status: () => {} };
	const config = {
		url: "http://localhost:4318/v1/traces",
		ignoredTypes: "",
		propagateHeadersTypes: "",
	};
	NodeConstructor.call(nodeInstance, config);

	const onReceiveListener = mockRed.hooks.listeners["onReceive.otel"];
	assert.ok(onReceiveListener, "onReceive.otel listener should be registered");

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
});

test("node constructor applies defaults for missing optional config", async () => {
	let NodeConstructor;
	const mockRed = {
		nodes: {
			createNode: function (node, config) {
				Object.assign(node, config);
			},
			registerType: (_name, constructor) => {
				NodeConstructor = constructor;
			},
			getNode: (id) => ({ name: `Flow ${id}` }),
		},
		hooks: {
			listeners: {},
			add: function (name, listener) {
				this.listeners[name] = listener;
			},
			remove: () => {},
		},
	};
	otelModule(mockRed);

	let closeHandler;
	const nodeInstance = {
		on: (event, handler) => {
			if (event === "close") closeHandler = handler;
		},
		status: () => {},
	};

	assert.doesNotThrow(() => {
		NodeConstructor.call(nodeInstance, {
			url: "http://localhost:4318/v1/traces",
		});
	});

	assert.equal(
		parseAttribute(false, { payload: "value" }, "flow", "function"),
		undefined,
	);

	const startedSpans = [];
	const tracer = {
		startSpan: (name, options) => {
			const span = createFakeSpan(name, options);
			startedSpans.push(span);
			return span;
		},
	};
	createSpan(
		mockRed,
		tracer,
		{ _msgid: "defaults-msg" },
		{ id: "node", type: "function", name: "Function", z: "flow" },
		{},
		false,
	);
	assert.equal(startedSpans[0].name, "Message Function");

	const parentSpan = createFakeSpan("parent");
	const spans = getMsgSpans();
	spans.set("stale-msg", {
		parentSpan,
		spans: new Map(),
		updateTimestamp: Date.now() - 15_000,
	});
	deleteOutdatedMsgSpans();
	assert.equal(spans.has("stale-msg"), false);
	assert.equal(parentSpan.ended, true);

	await closeHandler.call(nodeInstance);
});

test("onSend.otel hook creates spans for every event in batch", async () => {
	let NodeConstructor;
	const mockRed = {
		nodes: {
			createNode: function (node, config) {
				Object.assign(node, config);
			},
			registerType: (_name, constructor) => {
				NodeConstructor = constructor;
			},
			getNode: (id) => ({ name: `Flow ${id}` }),
		},
		hooks: {
			listeners: {},
			add: function (name, listener) {
				this.listeners[name] = listener;
			},
			remove: function (_pattern) {},
		},
	};
	otelModule(mockRed);

	let closeHandler;
	const nodeInstance = {
		on: (event, handler) => {
			if (event === "close") closeHandler = handler;
		},
		status: () => {},
	};

	NodeConstructor.call(nodeInstance, {
		url: "http://localhost:4318/v1/traces",
		protocol: "http",
		serviceName: "test-service",
		rootPrefix: "",
		ignoredTypes: "",
		propagateHeadersTypes: "",
		isLogging: false,
		timeout: 10,
		attributeMappings: [],
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

	await closeHandler.call(nodeInstance);
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
	const functionSpan = createSpan(mockRed, tracer, msg, functionNode, {}, false);
	assert.ok(functionSpan);

	// End the function span. This should trigger the orphan logic for the switch span.
	endSpan(mockRed, msg, null, functionNode);

	// The parent span should be ended because the only remaining child is an orphan
	assert.equal(getMsgSpans().size, 0);
});
