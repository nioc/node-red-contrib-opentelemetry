const os = require("os");
const { name, version } = require("../package.json");
const {
	trace,
	context,
	SpanKind,
	SpanStatusCode,
	metrics,
} = require("@opentelemetry/api");
const { logs, SeverityNumber } = require("@opentelemetry/api-logs");
const { Resource } = require("@opentelemetry/resources");
const {
	ATTR_SERVICE_NAME,
	ATTR_HTTP_RESPONSE_STATUS_CODE,
	ATTR_URL_PATH,
	ATTR_SERVER_ADDRESS,
	ATTR_SERVER_PORT,
	ATTR_URL_SCHEME,
	ATTR_HTTP_REQUEST_METHOD,
	ATTR_CLIENT_ADDRESS,
	ATTR_USER_AGENT_ORIGINAL,
	ATTR_HTTP_REQUEST_HEADER,
} = require("@opentelemetry/semantic-conventions");
const {
	ATTR_HOST_NAME,
	ATTR_CODE_FUNCTION,
} = require("@opentelemetry/semantic-conventions/incubating");
const {
	BasicTracerProvider,
	BatchSpanProcessor,
} = require("@opentelemetry/sdk-trace-base");
const {
	MeterProvider,
	PeriodicExportingMetricReader,
} = require("@opentelemetry/sdk-metrics");
const {
	LoggerProvider,
	BatchLogRecordProcessor,
} = require("@opentelemetry/sdk-logs");
const {
	B3InjectEncoding,
	B3Propagator,
} = require("@opentelemetry/propagator-b3");
const { JaegerPropagator } = require("@opentelemetry/propagator-jaeger");
const {
	CompositePropagator,
	W3CBaggagePropagator,
	W3CTraceContextPropagator,
} = require("@opentelemetry/core");
const { clearInterval } = require("timers");
const {
	defaultTextMapGetter,
	defaultTextMapSetter,
} = require("@opentelemetry/api");
const jmespath = require("jmespath");

/**
 * @typedef {import('@opentelemetry/api').Tracer} Tracer
 * @typedef {import('@opentelemetry/api').Span} Span
 */

const ATTR_MSG_ID = "node_red.msg.id";
const ATTR_FLOW_ID = "node_red.flow.id";
const ATTR_FLOW_NAME = "node_red.flow.name";
const ATTR_NODE_ID = "node_red.node.id";
const ATTR_NODE_TYPE = "node_red.node.type";
const ATTR_NODE_NAME = "node_red.node.name";
const ATTR_IS_MESSAGE_CREATION = "node_red.msg.new";
const ORPHAN_NODE_TYPES = ["switch", "rbe"];
const fakeSpan = {
	end: () => {},
	recordException: () => {},
	setStatus: () => {},
	setAttribute: () => {},
};
/**
 * The map of running parent spans, each message will be an entry, each span will be stored in its own spans map
 * @type {Map<string, {parentSpan: Span, spans: Map<string, Span>, updateTimestamp: number}>}
 */
const msgSpans = new Map();

// Shared state for all node instances
const sharedState = {
	isLogging: false,
	rootPrefix: "",
	timeout: 10_000,
	attributeMappings: [],
	ignoredTypesList: [],
	propagateHeadersTypesList: [],
	tracer: null,
	provider: null, // Trace provider
	meterProvider: null,
	loggerProvider: null,
	logger: null,
	metrics: {
		requestDuration: null,
	},
	intervalId: null,
	refCount: 0,
};

const DEFAULT_OTEL_TRACE_URL = "http://localhost:4318/v1/traces";
const DEFAULT_OTEL_METRICS_URL = "http://localhost:4318/v1/metrics";
const DEFAULT_OTEL_LOGS_URL = "http://localhost:4318/v1/logs";
const DEFAULT_OTEL_PROTOCOL = "http";
const DEFAULT_OTEL_SERVICE_NAME = "Node-RED";
const DEFAULT_ROOT_PREFIX = "Message ";
const DEFAULT_IGNORED_TYPES = "debug,catch";
const DEFAULT_PROPAGATE_HEADERS_TYPES = "";
const DEFAULT_TIMEOUT_SECONDS = 10;

function splitCsv(value) {
	return String(value ?? "")
		.split(",")
		.map((key) => key.trim())
		.filter((key) => key.length > 0);
}

function ensureTracesPath(urlValue) {
	try {
		const parsed = new URL(String(urlValue));
		if (parsed.pathname === "/" || parsed.pathname === "") {
			parsed.pathname = "/v1/traces";
		}
		return parsed.toString();
	} catch (_error) {
		return urlValue;
	}
}

function resolveProtocol(value) {
	const normalized = String(value ?? "")
		.trim()
		.toLowerCase();
	switch (normalized) {
		case "http/protobuf":
		case "protobuf":
		case "proto":
			return "proto";
		case "http/json":
		case "http":
		case "json":
			return "http";
		default:
			return undefined;
	}
}

function resolveOpenTelemetryConfig(config) {
	const env = process.env;
	const tracesEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
	const metricsEndpoint = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
	const logsEndpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
	const genericEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
	const tracesProtocol = env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL;
	const genericProtocol = env.OTEL_EXPORTER_OTLP_PROTOCOL;
	const serviceNameEnv = env.OTEL_SERVICE_NAME;

	const resolvedProtocol = resolveProtocol(tracesProtocol || genericProtocol);

	const useEnvTraceUrl = !config.url || config.url === DEFAULT_OTEL_TRACE_URL;
	const useEnvMetricsUrl =
		!config.metricsUrl || config.metricsUrl === DEFAULT_OTEL_METRICS_URL;
	const useEnvLogsUrl =
		!config.logsUrl || config.logsUrl === DEFAULT_OTEL_LOGS_URL;
	const useEnvProtocol =
		!config.protocol || config.protocol === DEFAULT_OTEL_PROTOCOL;
	const useEnvServiceName =
		!config.serviceName || config.serviceName === DEFAULT_OTEL_SERVICE_NAME;

	return {
		url:
			useEnvTraceUrl && (tracesEndpoint || genericEndpoint)
				? ensureTracesPath(tracesEndpoint || genericEndpoint)
				: config.url || DEFAULT_OTEL_TRACE_URL,
		metricsUrl:
			useEnvMetricsUrl && (metricsEndpoint || genericEndpoint)
				? metricsEndpoint || genericEndpoint
				: config.metricsUrl || DEFAULT_OTEL_METRICS_URL,
		logsUrl:
			useEnvLogsUrl && (logsEndpoint || genericEndpoint)
				? logsEndpoint || genericEndpoint
				: config.logsUrl || DEFAULT_OTEL_LOGS_URL,
		protocol:
			useEnvProtocol && resolvedProtocol
				? resolvedProtocol
				: config.protocol || DEFAULT_OTEL_PROTOCOL,
		serviceName:
			useEnvServiceName && serviceNameEnv
				? serviceNameEnv
				: config.serviceName || DEFAULT_OTEL_SERVICE_NAME,
		tracesEnabled: config.tracesEnabled ?? true,
		metricsEnabled: config.metricsEnabled ?? false,
		logsEnabled: config.logsEnabled ?? false,
		rootPrefix: config.rootPrefix ?? DEFAULT_ROOT_PREFIX,
		ignoredTypes: config.ignoredTypes ?? DEFAULT_IGNORED_TYPES,
		propagateHeadersTypes:
			config.propagateHeadersTypes ?? DEFAULT_PROPAGATE_HEADERS_TYPES,
		isLogging: config.isLogging ?? false,
		timeout: config.timeout ?? DEFAULT_TIMEOUT_SECONDS,
		attributeMappings: config.attributeMappings ?? [],
	};
}

function normalizeTimeoutMs(timeoutSeconds) {
	const parsedValue = Number(timeoutSeconds);
	if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
		return 10_000;
	}
	return parsedValue * 1000;
}

function sanitizeAttributeMappings(mappings) {
	if (!Array.isArray(mappings)) {
		return [];
	}
	return mappings.filter((mapping) => {
		if (!mapping || typeof mapping !== "object") {
			return false;
		}
		const key = String(mapping.key ?? "").trim();
		const path = String(mapping.path ?? "").trim();
		return key.length > 0 && path.length > 0;
	});
}

const propagator = new CompositePropagator({
	propagators: [
		new JaegerPropagator(),
		new W3CTraceContextPropagator(),
		new W3CBaggagePropagator(),
		new B3Propagator(),
		new B3Propagator({
			injectEncoding: B3InjectEncoding.MULTI_HEADER,
		}),
	],
});

/**
 * Get parent span id or current message id if there is none
 * @param {any} msg Message data to be used to retrieve the parent span id `otelRootMsgId`
 * @returns {string}
 */
function getMsgId(msg) {
	return msg.otelRootMsgId ? msg.otelRootMsgId : msg._msgid;
}

/**
 * Return the span identifier for this node and message
 * @param {any} msg Message data to be used to retrieve the parent message id
 * @param {any} nodeDefinition Current node definition
 * @returns {string}
 */
function getSpanId(msg, nodeDefinition) {
	const msgId =
		nodeDefinition.type === "split" && msg.otelRootMsgId
			? msg.otelRootMsgId
			: msg._msgid;
	return `${msgId}#${nodeDefinition.id}`;
}

/**
 * Get the name of a flow (or subflow) by its ID
 * @param {any} RED Node-RED runtime object
 * @param {string} flowId
 * @returns {string|undefined}
 */
function getFlowName(RED, flowId) {
	if (!RED || !flowId) return undefined;
	const flow = RED.nodes.getNode(flowId);
	return flow ? flow.name : undefined;
}

/**
 * @param {any} RED Node-RED runtime object
 * @param {any} node OTEL node (for using Node-RED utilities)
 * @param {string} eventType
 * @param {any} event
 * @returns
 */
function logEvent(RED, node, eventType, event) {
	if (!sharedState.isLogging && !sharedState.logger) {
		return;
	}
	try {
		const msgId = getMsgId(event.msg);
		const _msgId = event.msg._msgid;
		const flowName = getFlowName(RED, event.msg.z);
		let logMsg = `rootMsgId: ${msgId}, _msgId: ${_msgId}:`;
		const attributes = {
			[ATTR_MSG_ID]: msgId,
			"node_red.msg._msgid": _msgId,
			"node_red.event_type": eventType,
		};
		if (flowName) {
			attributes[ATTR_FLOW_NAME] = flowName;
		}

		if (event.source && event.source.node) {
			logMsg += ` src: ${event.source.node.type} ${event.source.node.id}`;
			attributes[ATTR_NODE_ID] = event.source.node.id;
			attributes[ATTR_NODE_TYPE] = event.source.node.type;
		}
		if (event.destination && event.destination.node) {
			logMsg += ` >> dest: ${event.destination.node.type} ${event.destination.node.id}`;
			attributes["node_red.destination.id"] = event.destination.node.id;
			attributes["node_red.destination.type"] = event.destination.node.type;
		}
		if (event.node && event.node.node) {
			logMsg += ` ## node: ${event.node.node.type} ${event.node.node.id}`;
			attributes[ATTR_NODE_ID] = event.node.node.id;
			attributes[ATTR_NODE_TYPE] = event.node.node.type;
		}

		if (sharedState.isLogging) {
			console.log(`${eventType}: ${logMsg}`);
		}

		if (sharedState.logger) {
			sharedState.logger.emit({
				severityNumber: SeverityNumber.INFO,
				severityText: "INFO",
				body: `${eventType}: ${logMsg}`,
				attributes,
				context: context.active(),
			});
		}
	} catch (error) {
		console.error(`An error occurred during logging ${eventType}`, error);
	}
}

/**
 * Delete outdated message spans
 */
function deleteOutdatedMsgSpans() {
	const now = Date.now();
	try {
		for (const [msgId, msgSpan] of msgSpans) {
			if (msgSpan.updateTimestamp < now - sharedState.timeout) {
				// ending parent span and remove it
				if (sharedState.isLogging) {
					console.log(
						`Parent span "${msgSpan.parentSpan.name}" ${msgId} is outdated, ending`,
					);
				}
				msgSpan.parentSpan.end(msgSpan.updateTimestamp);
				msgSpans.delete(msgId);
			}
		}
	} catch (error) {
		console.error("An error occurred during span cleaning", error);
	}
}

/**
 * Attribute value must be a non-null string, boolean, floating point value, integer, or an array of these values
 * ({@link https://opentelemetry.io/docs/concepts/signals/traces/#attributes OTEL doc})
 * @param {any} input Data whose type needs to be tested
 * @returns {boolean} Is the input data a primitive?
 **/
function isPrimitive(input) {
	if (Array.isArray(input)) {
		return input.every(isPrimitive);
	}
	return ["string", "number", "boolean"].includes(typeof input);
}

/**
 * Use message data to provide user custom span attributes
 * @param {boolean} isAfter Should attribute analysis be after node processing?
 * @param {any} data Message data to be used for parsing
 * @param {string} flowId Flow identifier
 * @param {string} nodeType Node type (ex: `http in`, `function`)
 * @returns {Record<string, string | number | boolean > | undefined} Custom attributes as record or undefined
 */
function parseAttribute(isAfter, data, flowId, nodeType) {
	if (sharedState.attributeMappings.length === 0) {
		return;
	}
	const attributes = {};
	sharedState.attributeMappings
		.filter(
			(mapping) =>
				(mapping.flow === "" || mapping.flow === flowId) &&
				(mapping.nodeType === "" || mapping.nodeType === nodeType) &&
				mapping.isAfter === isAfter,
		)
		.forEach((mapping) => {
			try {
				const result = jmespath.search(data, mapping.path);
				if (isPrimitive(result)) {
					attributes[mapping.key] = result;
				}
			} catch (error) {
				console.warn(
					`An error occurred during span attribute parsing (key: ${mapping.key}, path: ${mapping.path}): ${error.message}`,
				);
			}
		});
	return attributes;
}

/**
 * Create a span for this node and message
 * @param {any} RED Node-RED runtime object
 * @param {Tracer} tracer Tracer used for creating spans
 * @param {any} msg Complete message data
 * @param {any} nodeDefinition Current node definition
 * @param {any} node OTEL node (for using Node-RED utilities)
 * @param {boolean} isNotTraced Is the node should be traced?
 * @returns {Span|undefined} Created span
 */
function createSpan(RED, tracer, msg, nodeDefinition, node, isNotTraced) {
	try {
		// check and get message id (handle root message id for splitted parts)
		const msgId = getMsgId(msg);
		if (msgId === undefined) {
			return;
		}
		// check and get span id (msg id and node id)
		const spanId = getSpanId(msg, nodeDefinition);
		if (msgSpans.has(msgId) && msgSpans.get(msgId).spans.has(spanId)) {
			return;
		}

		// define context variables
		const spanName = nodeDefinition.name || nodeDefinition.type;
		const flowName = getFlowName(RED, nodeDefinition.z);
		const now = Date.now();
		let parentSpan, ctx, kind;

		// try to set span kind
		switch (nodeDefinition.type) {
			case "http in":
			case "tcp in":
			case "udp in":
				kind = SpanKind.SERVER;
				break;
			case "http request":
			case "tcp request":
				kind = SpanKind.CLIENT;
				break;
			case "mqtt in":
			case "amqp-in":
			case "websocket in":
				kind = SpanKind.CONSUMER;
				break;
			case "mqtt out":
			case "amqp-out":
			case "websocket out":
				kind = SpanKind.PRODUCER;
				break;
			default:
				kind = SpanKind.INTERNAL;
				break;
		}

		// prepare common attributes
		const commonAttributes = {
			[ATTR_MSG_ID]: msgId,
			[ATTR_FLOW_ID]: nodeDefinition.z,
			[ATTR_NODE_ID]: nodeDefinition.id,
			[ATTR_NODE_TYPE]: nodeDefinition.type,
			[ATTR_NODE_NAME]: nodeDefinition.name,
		};
		if (flowName) {
			commonAttributes[ATTR_FLOW_NAME] = flowName;
		}

		// handle context
		if (msgSpans.has(msgId)) {
			// get (parent) message context
			ctx = trace.setSpan(context.active(), msgSpans.get(msgId).parentSpan);
		} else {
			if (nodeDefinition.type === "http in") {
				// try to get trace context in incoming http request headers
				ctx = propagator.extract(
					context.active(),
					msg.req.headers,
					defaultTextMapGetter,
				);
			} else if (nodeDefinition.type === "mqtt in" && msg.userProperties) {
				// try to get trace context in incoming mqtt v5 user properties
				ctx = propagator.extract(
					context.active(),
					msg.userProperties,
					defaultTextMapGetter,
				);
			} else if (nodeDefinition.type === "amqp-in") {
				// try to get trace context in incoming ampq message headers
				ctx = propagator.extract(
					context.active(),
					msg.properties.headers,
					defaultTextMapGetter,
				);
			}
			// create the parent span
			parentSpan = tracer.startSpan(
				sharedState.rootPrefix + spanName,
				{
					attributes: {
						[ATTR_IS_MESSAGE_CREATION]: true,
						[ATTR_SERVICE_NAME]: nodeDefinition.type,
						...commonAttributes,
					},
					kind,
				},
				ctx,
			);
			// create the message context
			ctx = trace.setSpan(context.active(), parentSpan);
			// store message parent span
			msgSpans.set(msgId, {
				parentSpan,
				spans: new Map(),
				updateTimestamp: now,
			});

			if (sharedState.isLogging) {
				console.log("=> Created parent span for", nodeDefinition.type);
			}
		}

		if (isNotTraced) {
			// store fake child span (required to finish parent span)
			msgSpans.get(msgId).spans.set(
				spanId,
				Object.assign(
					{
						attributes: { [ATTR_NODE_TYPE]: nodeDefinition.type },
						_creationTimestamp: now,
					},
					fakeSpan,
				),
			);
			return fakeSpan;
		}
		// create child span
		const localAttributes = parseAttribute(
			false,
			msg,
			nodeDefinition.z,
			nodeDefinition.type,
		);
		if (sharedState.isLogging) {
			console.log(
				`Local span attributes (start) for ${nodeDefinition.id}, ${nodeDefinition.type}: ${JSON.stringify(localAttributes)}`,
			);
		}
		const span = tracer.startSpan(
			spanName,
			{
				attributes: {
					[ATTR_CODE_FUNCTION]: nodeDefinition.type,
					[ATTR_IS_MESSAGE_CREATION]: false,
					...commonAttributes,
					...localAttributes,
				},
				kind,
			},
			ctx,
		);
		span._creationTimestamp = now;

		if (nodeDefinition.type === "http in") {
			msg.otelStartTime = now;
			const httpAttributes = {
				[ATTR_URL_PATH]: nodeDefinition.url,
				[ATTR_HTTP_REQUEST_METHOD]: nodeDefinition.method?.toUpperCase(),
				[ATTR_CLIENT_ADDRESS]: msg.req.ip,
				[ATTR_HTTP_REQUEST_HEADER("x-forwarded-for")]:
					msg.req.headers["x-forwarded-for"],
				[ATTR_USER_AGENT_ORIGINAL]: msg.req.headers["user-agent"],
			};
			span.setAttributes(httpAttributes);
			if (parentSpan !== undefined) {
				parentSpan.setAttributes(httpAttributes);
				parentSpan.updateName(`${parentSpan.name} ${nodeDefinition.url}`);
			}
		}
		if (nodeDefinition.type === "websocket out") {
			// add URL info in attributes
			try {
				const url = URL.parse(nodeDefinition.serverConfig.path);
				span.setAttribute(ATTR_URL_PATH, url.pathname);
				span.setAttribute(ATTR_SERVER_ADDRESS, url.hostname);
				span.setAttribute(ATTR_SERVER_PORT, url.port);
				span.setAttribute(ATTR_URL_SCHEME, url.protocol.replace(":", ""));
			} catch (_error) {}
		}

		if (nodeDefinition.type === "websocket in") {
			// add URL info in attributes
			span.setAttribute(ATTR_URL_PATH, nodeDefinition.serverConfig.path);
			if (parentSpan !== undefined) {
				parentSpan.setAttribute(
					ATTR_URL_PATH,
					nodeDefinition.serverConfig.path,
				);
				parentSpan.updateName(
					`${parentSpan.name} ${nodeDefinition.serverConfig.path}`,
				);
			}
		}

		if (sharedState.isLogging) {
			console.log("=> Created span for", nodeDefinition.type);
		}

		// store child span
		const parent = msgSpans.get(msgId);
		parent.spans.set(spanId, span);
		parent.updateTimestamp = now;
		return span;
	} catch (error) {
		console.error(`An error occurred during span creation`, error);
	}
}

/**
 * Ends the span for this node and message
 * @param {any} RED Node-RED runtime object
 * @param {any} msg Complete message data
 * @param {any} error Any error encountered
 * @param {any} nodeDefinition Current node definition
 */
function endSpan(RED, msg, error, nodeDefinition) {
	try {
		// check and get message id (handle root message id for splitted parts)
		const msgId = getMsgId(msg);
		if (!msgId) {
			return;
		}
		// check and get span id (msg id and node id)
		const msgSpanId = getSpanId(msg, nodeDefinition);
		if (!msgSpans.has(msgId) || !msgSpans.get(msgId).spans.has(msgSpanId)) {
			return;
		}

		// end and remove child span
		const parent = msgSpans.get(msgId);
		const span = parent.spans.get(msgSpanId);
		const flowName = getFlowName(RED, nodeDefinition.z);
		if (flowName) {
			span.setAttribute(ATTR_FLOW_NAME, flowName);
		}
		if (nodeDefinition.type === "http request") {
			// add http status code in attribute
			span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, msg.statusCode);
			if (msg.statusCode >= 400) {
				span.setStatus({ code: SpanStatusCode.ERROR });
			} else if (msg.statusCode >= 200 && msg.statusCode < 300) {
				span.setStatus({ code: SpanStatusCode.OK });
			}
			// add URL info in attributes
			try {
				const url = URL.parse(msg.responseUrl);
				span.setAttribute(ATTR_URL_PATH, url.pathname);
				span.setAttribute(ATTR_SERVER_ADDRESS, url.hostname);
				span.setAttribute(ATTR_SERVER_PORT, url.port);
				span.setAttribute(ATTR_URL_SCHEME, url.protocol.replace(":", ""));
			} catch (_error) {}
		}
		if (error) {
			// log errors
			if (msg.error) {
				span.recordException(msg.error);
			} else {
				span.recordException(error);
			}
			span.setStatus({ code: SpanStatusCode.ERROR, message: error });
			if (parent.parentSpan) {
				parent.parentSpan.setStatus({ code: SpanStatusCode.ERROR });
			}
		}
		const localAttributes = parseAttribute(
			true,
			msg,
			nodeDefinition.z,
			nodeDefinition.type,
		);
		if (localAttributes !== undefined) {
			for (const [key, value] of Object.entries(localAttributes)) {
				span.setAttribute(key, value);
			}
			if (sharedState.isLogging) {
				console.log(
					`Local span attributes (end) for ${nodeDefinition.id}, ${nodeDefinition.type}: ${JSON.stringify(localAttributes)}`,
				);
			}
		}

		if (nodeDefinition.type === "http response") {
			// correlate with "http in" node
			const statusCode = msg.res._res.statusCode;
			for (const [msgSpanId, spanIn] of parent.spans) {
				if (spanIn.attributes["node_red.node.type"] === "http in") {
					if (sharedState.isLogging) {
						console.log("==> Ended related span for ", msgSpanId, "http in");
					}
					spanIn.end();
					parent.spans.delete(msgSpanId);
					break;
				}
			}

			// Record metrics
			if (sharedState.metrics.requestDuration && msg.otelStartTime) {
				const duration = Date.now() - msg.otelStartTime;
				sharedState.metrics.requestDuration.record(duration, {
					[ATTR_HTTP_RESPONSE_STATUS_CODE]: statusCode,
					[ATTR_HTTP_REQUEST_METHOD]: msg.req.method,
					[ATTR_URL_PATH]: msg.req.path,
				});
			}

			// add http status code in attribute
			if (statusCode >= 400) {
				span.setStatus({ code: SpanStatusCode.ERROR });
				parent.parentSpan.setStatus({ code: SpanStatusCode.ERROR });
			} else if (statusCode >= 200 && statusCode < 300) {
				span.setStatus({ code: SpanStatusCode.OK });
				parent.parentSpan.setStatus({ code: SpanStatusCode.OK });
			}
			span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode);
			parent.parentSpan.setAttribute(
				ATTR_HTTP_RESPONSE_STATUS_CODE,
				statusCode,
			);
		}

		span.end();
		const currentSpanCreationTimestamp = span._creationTimestamp;
		if (sharedState.isLogging) {
			console.log(
				"==> Ended span for ",
				nodeDefinition.id,
				nodeDefinition.type,
			);
		}
		parent.spans.delete(msgSpanId);
		parent.updateTimestamp = Date.now();

		// check orphan traces (nodes that do not trigger complete event)
		let isOrphan = true;
		for (const [, span] of parent.spans) {
			if (
				!ORPHAN_NODE_TYPES.includes(span.attributes["node_red.node.type"]) ||
				span._creationTimestamp > currentSpanCreationTimestamp
			) {
				// found an active span, skip
				isOrphan = false;
				break;
			}
		}
		if (isOrphan) {
			for (const [msgSpanId] of parent.spans) {
				if (sharedState.isLogging) {
					console.log(`Orphan span to delete: ${msgSpanId}`);
				}
				parent.spans.delete(msgSpanId);
			}
			// all children are completed, end and remove parent span
			if (sharedState.isLogging) {
				console.log(
					`Parent span "${parent.parentSpan.name}" no longer has child span, ending`,
				);
			}
			parent.parentSpan.end();
			msgSpans.delete(msgId);
		}
	} catch (error) {
		console.error(error);
	}
}

/**
 * @param {any} RED Node-RED runtime object
 */
module.exports = function (RED) {
	"use strict";

	/**
	 * Initialize the OpenTelemetry system. Can be called by the Plugin API or a Node instance.
	 * @param {any} config Optional configuration to override defaults
	 */
	function initOTEL(config = {}) {
		// get config
		const resolvedConfig = resolveOpenTelemetryConfig(config);
		const {
			url,
			metricsUrl,
			logsUrl,
			protocol,
			serviceName,
			tracesEnabled,
			metricsEnabled,
			logsEnabled,
			rootPrefix,
			ignoredTypes,
			propagateHeadersTypes,
			isLogging,
			timeout,
			attributeMappings,
		} = resolvedConfig;

		// Update shared state (latest node/plugin wins)
		sharedState.isLogging = Boolean(isLogging);
		sharedState.rootPrefix = rootPrefix;
		sharedState.timeout = normalizeTimeoutMs(timeout);
		sharedState.attributeMappings = sanitizeAttributeMappings(attributeMappings);
		sharedState.ignoredTypesList = splitCsv(ignoredTypes);
		sharedState.propagateHeadersTypesList = splitCsv(propagateHeadersTypes);

		const commonResource = new Resource({
			[ATTR_SERVICE_NAME]: serviceName,
			[ATTR_HOST_NAME]: os.hostname(),
		});

		// create tracer if not already created
		if (!sharedState.provider && tracesEnabled && url) {
			let spanProcessor;
			if (protocol === "proto") {
				const {
					OTLPTraceExporter,
				} = require("@opentelemetry/exporter-trace-otlp-proto");
				spanProcessor = new BatchSpanProcessor(new OTLPTraceExporter({ url }));
			} else {
				const {
					OTLPTraceExporter,
				} = require("@opentelemetry/exporter-trace-otlp-http");
				spanProcessor = new BatchSpanProcessor(new OTLPTraceExporter({ url }));
			}
			const provider = new BasicTracerProvider({
				resource: commonResource,
				spanProcessors: [spanProcessor],
			});
			trace.setGlobalTracerProvider(provider);
			sharedState.provider = provider;
			sharedState.tracer = trace.getTracer(name, version);
		}

		// create meter if not already created
		if (!sharedState.meterProvider && metricsEnabled && metricsUrl) {
			const {
				OTLPMetricExporter,
			} = require("@opentelemetry/exporter-metrics-otlp-http");
			const metricReader = new PeriodicExportingMetricReader({
				exporter: new OTLPMetricExporter({ url: metricsUrl }),
				exportIntervalMillis: 60000,
			});
			const meterProvider = new MeterProvider({
				resource: commonResource,
				readers: [metricReader],
			});
			metrics.setGlobalMeterProvider(meterProvider);
			sharedState.meterProvider = meterProvider;
			const meter = metrics.getMeter(name, version);
			sharedState.metrics.requestDuration = meter.createHistogram(
				"http.server.duration",
				{
					description: "Duration of HTTP server requests in milliseconds",
					unit: "ms",
				},
			);
		}

		// create logger if not already created
		if (!sharedState.loggerProvider && logsEnabled && logsUrl) {
			const {
				OTLPLogExporter,
			} = require("@opentelemetry/exporter-logs-otlp-http");
			const logExporter = new OTLPLogExporter({ url: logsUrl });
			const loggerProvider = new LoggerProvider({
				resource: commonResource,
			});
			loggerProvider.addLogRecordProcessor(
				new BatchLogRecordProcessor(logExporter),
			);
			logs.setGlobalLoggerProvider(loggerProvider);
			sharedState.loggerProvider = loggerProvider;
			sharedState.logger = logs.getLogger(name, version);
		}

		// add hooks only for the first instance
		if (sharedState.refCount === 0) {
			RED.hooks.add("onSend.otel", (events) => {
				if (events.length === 0) {
					return;
				}
				events.forEach((event) => {
					logEvent(RED, null, "1.onSend", event);
					if (sharedState.tracer) {
						createSpan(
							RED,
							sharedState.tracer,
							event.msg,
							event.source.node,
							null,
							sharedState.ignoredTypesList.includes(event.source.node.type),
						);
					}
				});
			});

			RED.hooks.add("preDeliver.otel", (sendEvent) => {
				if (
					sharedState.propagateHeadersTypesList.includes(sendEvent.source.node.type)
				) {
					if (!sendEvent.msg.headers) {
						sendEvent.msg.headers = {};
					}
					// remove trace context of http request headers
					propagator.fields().forEach((field) => {
						delete sendEvent.msg.headers[field];
					});
				}
				logEvent(RED, null, "3.preDeliver", sendEvent);
			});

			RED.hooks.add("postDeliver.otel", (sendEvent) => {
				logEvent(RED, null, "4.postDeliver", sendEvent);
				if (!sharedState.tracer) return;

				const span = createSpan(
					RED,
					sharedState.tracer,
					sendEvent.msg,
					sendEvent.destination.node,
					null,
					sharedState.ignoredTypesList.includes(sendEvent.destination.node.type),
				);
				if (
					sharedState.propagateHeadersTypesList.includes(
						sendEvent.destination.node.type,
					)
				) {
					const output = {};
					const ctx = trace.setSpan(context.active(), span);
					propagator.inject(ctx, output, defaultTextMapSetter);
					switch (sendEvent.destination.node.type) {
						// add trace context in mqtt v5 user properties
						case "mqtt out":
							if (!sendEvent.msg.userProperties) {
								sendEvent.msg.userProperties = {};
							}
							Object.assign(sendEvent.msg.userProperties, output);
							break;
						default:
							// add trace context in http request headers
							if (!sendEvent.msg.headers) {
								sendEvent.msg.headers = {};
							}
							Object.assign(sendEvent.msg.headers, output);
							break;
					}
				}
				if (
					sendEvent.source.node.type === "switch" ||
					sendEvent.source.node.type.startsWith("subflow")
				) {
					// end switch or subflow spans as they do not trigger onComplete
					const msgId = getMsgId(sendEvent.msg);
					const spanId = getSpanId(sendEvent.msg, sendEvent.source.node);
					const parent = msgSpans.get(msgId);
					if (parent && parent.spans.has(spanId)) {
						if (sharedState.isLogging) {
							console.log(`Switch or subflow span ${spanId} will be ended`);
						}
						parent.spans.get(spanId).end();
						parent.spans.delete(spanId);
					}
				}
			});

			RED.hooks.add("postReceive.otel", (sendEvent) => {
				logEvent(RED, null, "6.postReceive", sendEvent);
			});

			RED.hooks.add("onReceive.otel", (receiveEvent) => {
				if (receiveEvent.destination.node.type === "split") {
					// store parent message id before split
					receiveEvent.msg.otelRootMsgId = getMsgId(receiveEvent.msg);
				}
				logEvent(RED, null, "5.onReceive", receiveEvent);
			});

			RED.hooks.add("onComplete.otel", (completeEvent) => {
				logEvent(RED, null, "7.onComplete", completeEvent);
				endSpan(RED, completeEvent.msg, completeEvent.error, completeEvent.node.node);
			});

			// add timer for killing outdated message spans
			sharedState.intervalId = setInterval(deleteOutdatedMsgSpans, 5000);
		}

		sharedState.refCount++;
	}

	async function stopOTEL() {
		sharedState.refCount--;
		if (sharedState.refCount <= 0) {
			if (sharedState.intervalId) {
				clearInterval(sharedState.intervalId);
				sharedState.intervalId = null;
			}
			RED.hooks.remove("*.otel");
			msgSpans.clear();
			if (sharedState.provider) {
				await sharedState.provider.shutdown();
				sharedState.provider = null;
			}
			if (sharedState.meterProvider) {
				await sharedState.meterProvider.shutdown();
				sharedState.meterProvider = null;
			}
			if (sharedState.loggerProvider) {
				await sharedState.loggerProvider.shutdown();
				sharedState.loggerProvider = null;
			}
			trace.disable();
			metrics.disable();
			logs.disable();
			sharedState.tracer = null;
			sharedState.logger = null;
			sharedState.metrics.requestDuration = null;
			sharedState.refCount = 0;
		}
	}

	// Register as a Node
	function OpenTelemetryNode(config) {
		RED.nodes.createNode(this, config);
		initOTEL(config);
		this.on("close", async (done) => {
			await stopOTEL();
			this.status({ fill: "red", shape: "ring", text: "deactivated" });
			if (typeof done === "function") done();
		});
		this.status({ fill: "green", shape: "ring", text: "activated" });
	}
	RED.nodes.registerType("OpenTelemetry", OpenTelemetryNode);

	// Support Node-RED 4+ Runtime Plugin
	// If loaded as a plugin, it won't have a config object, but can read from env vars
	if (RED.plugins && typeof RED.plugins.registerRuntimePlugin === "function") {
		RED.plugins.registerRuntimePlugin({
			id: "opentelemetry-runtime",
			onSettings: (settings) => {
				// We can read from settings.js if needed
				if (settings.opentelemetry) {
					initOTEL(settings.opentelemetry);
				} else {
					// Fallback to env vars only
					initOTEL({});
				}
			},
			onClose: async () => {
				await stopOTEL();
			},
		});
	}
};

module.exports.__test__ = {
	getMsgId,
	getSpanId,
	isPrimitive,
	parseAttribute,
	createSpan,
	endSpan,
	deleteOutdatedMsgSpans,
	setAttributeMappings: (mappings) => {
		sharedState.attributeMappings = sanitizeAttributeMappings(mappings);
	},
	setTimeout: (timeoutMs) => {
		sharedState.timeout = timeoutMs;
	},
	setLogging: (value) => {
		sharedState.isLogging = value;
	},
	resolveOpenTelemetryConfig,
	logEvent,
	getMsgSpans: () => msgSpans,
	clearInterval: () => {
		if (sharedState.intervalId) {
			clearInterval(sharedState.intervalId);
			sharedState.intervalId = null;
		}
	},
	resetState: () => {
		msgSpans.clear();
		sharedState.isLogging = false;
		sharedState.rootPrefix = "";
		sharedState.timeout = 10;
		sharedState.attributeMappings = [];
		sharedState.refCount = 0;
		if (sharedState.intervalId) {
			clearInterval(sharedState.intervalId);
			sharedState.intervalId = null;
		}
		if (sharedState.provider) {
			sharedState.provider.shutdown();
			sharedState.provider = null;
		}
		sharedState.tracer = null;
	},
	getSharedState: () => sharedState,
};
