import os from "node:os";
import type {
	NodeAPI,
	NodeDef,
	NodeMessageInFlow,
	Node as RedNodeInstance,
} from "@node-red/registry";
import {
	type Context,
	context,
	defaultTextMapGetter,
	defaultTextMapSetter,
	type Histogram,
	metrics,
	type Span,
	SpanKind,
	SpanStatusCode,
	type Tracer,
	trace,
} from "@opentelemetry/api";
import { type Logger, logs, SeverityNumber } from "@opentelemetry/api-logs";
import {
	CompositePropagator,
	W3CBaggagePropagator,
	W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { B3InjectEncoding, B3Propagator } from "@opentelemetry/propagator-b3";
import { JaegerPropagator } from "@opentelemetry/propagator-jaeger";
import { Resource } from "@opentelemetry/resources";
import {
	BatchLogRecordProcessor,
	LoggerProvider,
} from "@opentelemetry/sdk-logs";
import {
	MeterProvider,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
	BasicTracerProvider,
	BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
	ATTR_CLIENT_ADDRESS,
	ATTR_HTTP_REQUEST_HEADER,
	ATTR_HTTP_REQUEST_METHOD,
	ATTR_HTTP_RESPONSE_STATUS_CODE,
	ATTR_SERVER_ADDRESS,
	ATTR_SERVER_PORT,
	ATTR_SERVICE_NAME,
	ATTR_URL_PATH,
	ATTR_URL_SCHEME,
	ATTR_USER_AGENT_ORIGINAL,
} from "@opentelemetry/semantic-conventions";
import {
	ATTR_CODE_FUNCTION,
	ATTR_HOST_NAME,
} from "@opentelemetry/semantic-conventions/incubating";
import jmespath from "jmespath";
import { name, version } from "../package.json";

declare module "jmespath";

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

/**
 * Represents the OpenTelemetry Node-RED node configuration
 */
interface OTELConfig {
	url?: string;
	metricsUrl?: string;
	logsUrl?: string;
	protocol?: string;
	serviceName?: string;
	tracesEnabled?: boolean;
	metricsEnabled?: boolean;
	logsEnabled?: boolean;
	rootPrefix?: string;
	ignoredTypes?: string;
	propagateHeadersTypes?: string;
	isLogging?: boolean;
	timeout?: number;
	attributeMappings?: AttributeMapping[];
}

interface AttributeMapping {
	key: string;
	path: string;
	flow?: string;
	nodeType?: string;
	isAfter?: boolean;
	[key: string]: unknown;
}

interface ResolvedOTELConfig {
	url?: string;
	metricsUrl?: string;
	logsUrl?: string;
	protocol: string;
	serviceName: string;
	tracesEnabled: boolean;
	metricsEnabled: boolean;
	logsEnabled: boolean;
	rootPrefix: string;
	ignoredTypes: string;
	propagateHeadersTypes: string;
	isLogging: boolean;
	timeout: number;
	attributeMappings: AttributeMapping[];
}

interface RuntimeRequest {
	headers: Record<string, string | undefined>;
	ip?: string;
	method?: string;
	path?: string;
}

interface RuntimeResponse {
	_res?: { statusCode?: number };
}

interface OTelSpanExtension {
	attributes?: Record<string, unknown>;
	_creationTimestamp?: number;
	updateName?: (name: string) => void;
	name?: string;
}

type OTELNodeDef = NodeDef & OTELConfig;
type RuntimeNodeDef = NodeDef & {
	url?: string;
	method?: string;
	serverConfig?: { path: string };
	[key: string]: unknown;
};
type RuntimeMessage = NodeMessageInFlow & {
	otelRootMsgId?: string;
	otelStartTime?: number;
	z?: string;
	headers?: Record<string, string>;
	userProperties?: Record<string, unknown>;
	properties?: { headers: Record<string, string> };
	req?: RuntimeRequest;
	res?: RuntimeResponse;
	statusCode?: number;
	responseUrl?: string;
	error?: unknown;
	[key: string]: unknown;
};
type RuntimeHookEvent = {
	msg: RuntimeMessage;
	source?: { node: RuntimeNodeDef };
	destination?: { node: RuntimeNodeDef };
	node?: { node: RuntimeNodeDef };
	error?: unknown;
};
type RuntimePluginRegistration = {
	id: string;
	onSettings?: (settings: unknown) => void;
	onClose?: () => Promise<void> | void;
	[key: string]: unknown;
};
type RuntimeApi = NodeAPI & {
	plugins: NodeAPI["plugins"] & {
		registerRuntimePlugin?: (plugin: RuntimePluginRegistration) => void;
	};
};

/**
 * Shared state structure for all node instances
 */
interface SharedState {
	isLogging: boolean;
	rootPrefix: string;
	timeout: number;
	attributeMappings: AttributeMapping[];
	ignoredTypesList: string[];
	propagateHeadersTypesList: string[];
	tracer: Tracer | null;
	provider: BasicTracerProvider | null;
	meterProvider: MeterProvider | null;
	loggerProvider: LoggerProvider | null;
	logger: Logger | null;
	metrics: {
		requestDuration: Histogram | null;
	};
	intervalId: NodeJS.Timeout | null;
	refCount: number;
}

// Shared state for all node instances
const sharedState: SharedState = {
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

function splitCsv(value: string | undefined | null): string[] {
	return String(value ?? "")
		.split(",")
		.map((key) => key.trim())
		.filter((key) => key.length > 0);
}

function ensureTracesPath(urlValue: string | undefined): string | undefined {
	if (!urlValue) return urlValue;
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

function resolveProtocol(
	value: string | undefined,
): "proto" | "http" | undefined {
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

function resolveOpenTelemetryConfig(config: OTELConfig): ResolvedOTELConfig {
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

function normalizeTimeoutMs(timeoutSeconds: string | number): number {
	const parsedValue = Number(timeoutSeconds);
	if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
		return 10_000;
	}
	return parsedValue * 1000;
}

function sanitizeAttributeMappings(mappings: unknown): AttributeMapping[] {
	if (!Array.isArray(mappings)) {
		return [];
	}
	return mappings.filter((mapping) => {
		if (!mapping || typeof mapping !== "object") {
			return false;
		}
		const typedMapping = mapping as Partial<AttributeMapping>;
		const key = String(typedMapping.key ?? "").trim();
		const path = String(typedMapping.path ?? "").trim();
		return key.length > 0 && path.length > 0;
	}) as AttributeMapping[];
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
 * @param {{ otelRootMsgId?: string; _msgid: string }} msg Message data to be used to retrieve the parent span id `otelRootMsgId`
 * @returns {string}
 */
function getMsgId(msg: { otelRootMsgId?: string; _msgid: string }): string {
	return msg.otelRootMsgId ? msg.otelRootMsgId : msg._msgid;
}

/**
 * Return the span identifier for this node and message
 * @param {{ otelRootMsgId?: string; _msgid: string }} msg Message data to be used to retrieve the parent message id
 * @param {NodeDef} nodeDefinition Current node definition
 * @returns {string}
 */
function getSpanId(
	msg: { otelRootMsgId?: string; _msgid: string },
	nodeDefinition: NodeDef,
): string {
	const msgId =
		nodeDefinition.type === "split" && msg.otelRootMsgId
			? msg.otelRootMsgId
			: msg._msgid;
	return `${msgId}#${nodeDefinition.id}`;
}

/**
 * Get the name of a flow (or subflow) by its ID
 * @param {RuntimeApi} RED Node-RED runtime object
 * @param {string} flowId
 * @returns {string|undefined}
 */
function getFlowName(RED: RuntimeApi, flowId: string): string | undefined {
	if (!RED || !flowId) return undefined;
	const flow = RED.nodes.getNode(flowId) as RedNodeInstance | undefined;
	return flow?.name;
}

/**
 * @param {RuntimeApi} RED Node-RED runtime object
 * @param {NodeDef | null} node OTEL node (for using Node-RED utilities)
 * @param {string} eventType
 * @param {RuntimeHookEvent} event
 * @returns
 */
/**
 * @param {RuntimeApi} RED Node-RED runtime object
 * @param {NodeDef | null} node OTEL node (for using Node-RED utilities)
 * @param {string} eventType
 * @param {RuntimeHookEvent} event
 * @returns {void}
 */
function logEvent(
	RED: RuntimeApi,
	_node: NodeDef | null,
	eventType: string,
	event: RuntimeHookEvent,
): void {
	if (!sharedState.isLogging && !sharedState.logger) {
		return;
	}
	try {
		const msgId = getMsgId(event.msg);
		const _msgId = event.msg._msgid;
		const flowName = event.msg.z ? getFlowName(RED, event.msg.z) : undefined;
		let logMsg = `rootMsgId: ${msgId}, _msgId: ${_msgId}:`;
		const attributes: Record<string, string> = {
			[ATTR_MSG_ID]: msgId,
			"node_red.msg._msgid": _msgId,
			"node_red.event_type": eventType,
		};
		if (flowName) {
			attributes[ATTR_FLOW_NAME] = flowName;
		}

		if (event.source?.node) {
			logMsg += ` src: ${event.source.node.type} ${event.source.node.id}`;
			attributes[ATTR_NODE_ID] = event.source.node.id;
			attributes[ATTR_NODE_TYPE] = event.source.node.type;
		}
		if (event.destination?.node) {
			logMsg += ` >> dest: ${event.destination.node.type} ${event.destination.node.id}`;
			attributes["node_red.destination.id"] = event.destination.node.id;
			attributes["node_red.destination.type"] = event.destination.node.type;
		}
		if (event.node?.node) {
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
function deleteOutdatedMsgSpans(): void {
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
 * @param {unknown} input Data whose type needs to be tested
 * @returns {boolean} Is the input data a primitive?
 **/
function isPrimitive(input: unknown): boolean {
	if (Array.isArray(input)) {
		return input.every(isPrimitive);
	}
	return ["string", "number", "boolean"].includes(typeof input);
}

/**
 * Use message data to provide user custom span attributes
 * @param {boolean} isAfter Should attribute analysis be after node processing?
 * @param {unknown} data Message data to be used for parsing
 * @param {string} flowId Flow identifier
 * @param {string} nodeType Node type (ex: `http in`, `function`)
 * @returns {Record<string, string | number | boolean > | undefined} Custom attributes as record or undefined
 */
function parseAttribute(
	isAfter: boolean,
	data: unknown,
	flowId: string,
	nodeType: string,
): Record<string, string | number | boolean> | undefined {
	if (sharedState.attributeMappings.length === 0) {
		return;
	}
	const attributes: Record<string, string | number | boolean> = {};
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
					`An error occurred during span attribute parsing (key: ${mapping.key}, path: ${mapping.path}): ${(error as Error).message}`,
				);
			}
		});
	return attributes;
}

/**
 * Create a span for this node and message
 * @param {RuntimeApi} RED Node-RED runtime object
 * @param {Tracer} tracer Tracer used for creating spans
 * @param {RuntimeMessage} msg Complete message data
 * @param {NodeDef} nodeDefinition Current node definition
 * @param {boolean} isNotTraced Is the node should be traced?
 * @returns {Span|undefined} Created span
 */
function createSpan(
	RED: RuntimeApi,
	tracer: Tracer,
	msg: RuntimeMessage,
	nodeDefinition: RuntimeNodeDef,
	_node: RedNodeInstance | null,
	isNotTraced: boolean,
): Span | undefined {
	try {
		// check and get message id (handle root message id for splitted parts)
		const msgId = getMsgId(msg);
		if (msgId === undefined) {
			return;
		}
		// check and get span id (msg id and node id)
		const spanId = getSpanId(msg, nodeDefinition);
		const existingParent = msgSpans.get(msgId);
		if (msgSpans.has(msgId) && existingParent?.spans.has(spanId)) {
			return;
		}

		// define context variables
		const spanName = nodeDefinition.name || nodeDefinition.type;
		const flowName = getFlowName(RED, nodeDefinition.z);
		const now = Date.now();
		let parentSpan: Span | undefined;
		let ctx: Context | undefined;
		let kind: SpanKind;

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
		const commonAttributes: Record<string, string | undefined> = {
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
			if (existingParent) {
				ctx = trace.setSpan(context.active(), existingParent.parentSpan);
			}
		} else {
			if (nodeDefinition.type === "http in") {
				// try to get trace context in incoming http request headers
				ctx = propagator.extract(
					context.active(),
					msg.req?.headers ?? {},
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
					msg.properties?.headers ?? {},
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
			msgSpans.get(msgId)?.spans.set(
				spanId,
				Object.assign(
					{
						attributes: { [ATTR_NODE_TYPE]: nodeDefinition.type },
						_creationTimestamp: now,
					},
					fakeSpan,
				) as unknown as Span,
			);
			return fakeSpan as unknown as Span;
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
		) as Span & { _creationTimestamp: number };
		span._creationTimestamp = now;

		if (nodeDefinition.type === "http in") {
			msg.otelStartTime = now;
			const httpAttributes: Record<string, string | undefined> = {
				[ATTR_URL_PATH]: nodeDefinition.url,
				[ATTR_HTTP_REQUEST_METHOD]: nodeDefinition.method?.toUpperCase(),
				[ATTR_CLIENT_ADDRESS]: msg.req?.ip,
				[ATTR_HTTP_REQUEST_HEADER("x-forwarded-for")]:
					msg.req?.headers?.["x-forwarded-for"],
				[ATTR_USER_AGENT_ORIGINAL]: msg.req?.headers?.["user-agent"],
			};
			span.setAttributes(httpAttributes);
			if (parentSpan !== undefined) {
				parentSpan.setAttributes(httpAttributes);
				const parentSpanExt = parentSpan as Span & OTelSpanExtension;
				parentSpanExt.updateName?.(
					`${parentSpanExt.name ?? ""} ${nodeDefinition.url ?? ""}`,
				);
			}
		}
		if (nodeDefinition.type === "websocket out") {
			// add URL info in attributes
			try {
				if (!nodeDefinition.serverConfig?.path) {
					return span;
				}
				const url = new URL(nodeDefinition.serverConfig.path);
				span.setAttribute(ATTR_URL_PATH, url.pathname);
				span.setAttribute(ATTR_SERVER_ADDRESS, url.hostname);
				span.setAttribute(ATTR_SERVER_PORT, url.port);
				span.setAttribute(ATTR_URL_SCHEME, url.protocol.replace(":", ""));
			} catch (_error) {}
		}

		if (nodeDefinition.type === "websocket in") {
			// add URL info in attributes
			if (!nodeDefinition.serverConfig?.path) {
				return span;
			}
			span.setAttribute(ATTR_URL_PATH, nodeDefinition.serverConfig.path);
			if (parentSpan !== undefined) {
				parentSpan.setAttribute(
					ATTR_URL_PATH,
					nodeDefinition.serverConfig.path,
				);
				const parentSpanExt = parentSpan as Span & OTelSpanExtension;
				parentSpanExt.updateName?.(
					`${parentSpanExt.name ?? ""} ${nodeDefinition.serverConfig.path}`,
				);
			}
		}

		if (sharedState.isLogging) {
			console.log("=> Created span for", nodeDefinition.type);
		}

		// store child span
		const parent = msgSpans.get(msgId);
		parent?.spans.set(spanId, span);
		if (parent) {
			parent.updateTimestamp = now;
		}
		return span;
	} catch (error) {
		console.error(`An error occurred during span creation`, error);
	}
}

/**
 * Ends the span for this node and message
 * @param {RuntimeApi} RED Node-RED runtime object
 * @param {RuntimeMessage} msg Complete message data
 * @param {unknown} error Any error encountered
 * @param {NodeDef} nodeDefinition Current node definition
 */
function endSpan(
	RED: RuntimeApi,
	msg: RuntimeMessage,
	error: unknown,
	nodeDefinition: RuntimeNodeDef,
): void {
	try {
		// check and get message id (handle root message id for splitted parts)
		const msgId = getMsgId(msg);
		if (!msgId) {
			return;
		}
		// check and get span id (msg id and node id)
		const msgSpanId = getSpanId(msg, nodeDefinition);
		if (!msgSpans.has(msgId) || !msgSpans.get(msgId)?.spans.has(msgSpanId)) {
			return;
		}

		// end and remove child span
		const parent = msgSpans.get(msgId);
		if (!parent) {
			return;
		}
		const span = parent?.spans.get(msgSpanId);
		const flowName = getFlowName(RED, nodeDefinition.z);
		if (flowName) {
			span?.setAttribute(ATTR_FLOW_NAME, flowName);
		}
		if (nodeDefinition.type === "http request") {
			// add http status code in attribute
			const statusCode = msg.statusCode;
			if (typeof statusCode === "number") {
				span?.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode);
			}
			if (typeof statusCode === "number" && statusCode >= 400) {
				span?.setStatus({ code: SpanStatusCode.ERROR });
			} else if (
				typeof statusCode === "number" &&
				statusCode >= 200 &&
				statusCode < 300
			) {
				span?.setStatus({ code: SpanStatusCode.OK });
			}
			// add URL info in attributes
			if (msg.responseUrl) {
				try {
					const url = new URL(msg.responseUrl);
					span?.setAttribute(ATTR_URL_PATH, url.pathname);
					span?.setAttribute(ATTR_SERVER_ADDRESS, url.hostname);
					span?.setAttribute(ATTR_SERVER_PORT, url.port);
					span?.setAttribute(ATTR_URL_SCHEME, url.protocol.replace(":", ""));
				} catch (_error) {}
			}
		}
		if (error) {
			// log errors
			if (msg.error) {
				span?.recordException(msg.error);
			} else {
				span?.recordException(error);
			}
			span?.setStatus({
				code: SpanStatusCode.ERROR,
				message: error instanceof Error ? error.message : String(error),
			});
			if (parent?.parentSpan) {
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
				span?.setAttribute(key, value);
			}
			if (sharedState.isLogging) {
				console.log(
					`Local span attributes (end) for ${nodeDefinition.id}, ${nodeDefinition.type}: ${JSON.stringify(localAttributes)}`,
				);
			}
		}

		if (nodeDefinition.type === "http response") {
			// correlate with "http in" node
			const statusCode = msg.res?._res?.statusCode;
			for (const [msgSpanId, spanIn] of parent.spans) {
				if (spanIn.attributes["node_red.node.type"] === "http in") {
					if (sharedState.isLogging) {
						console.log("==> Ended related span for ", msgSpanId, "http in");
					}
					spanIn.end();
					parent?.spans.delete(msgSpanId);
					break;
				}
			}

			// Record metrics
			if (sharedState.metrics.requestDuration && msg.otelStartTime) {
				const duration = Date.now() - msg.otelStartTime;
				sharedState.metrics.requestDuration.record(duration, {
					[ATTR_HTTP_RESPONSE_STATUS_CODE]: statusCode ?? 0,
					[ATTR_HTTP_REQUEST_METHOD]: msg.req?.method ?? "",
					[ATTR_URL_PATH]: msg.req?.path ?? "",
				});
			}

			// add http status code in attribute
			if (typeof statusCode === "number" && statusCode >= 400) {
				span?.setStatus({ code: SpanStatusCode.ERROR });
				parent?.parentSpan.setStatus({ code: SpanStatusCode.ERROR });
			} else if (
				typeof statusCode === "number" &&
				statusCode >= 200 &&
				statusCode < 300
			) {
				span?.setStatus({ code: SpanStatusCode.OK });
				parent?.parentSpan.setStatus({ code: SpanStatusCode.OK });
			}
			if (typeof statusCode === "number") {
				span?.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode);
				parent?.parentSpan.setAttribute(
					ATTR_HTTP_RESPONSE_STATUS_CODE,
					statusCode,
				);
			}
		}

		span?.end();
		const currentSpanCreationTimestamp = (span as Span & OTelSpanExtension)
			?._creationTimestamp;
		if (sharedState.isLogging) {
			console.log(
				"==> Ended span for ",
				nodeDefinition.id,
				nodeDefinition.type,
			);
		}
		parent?.spans.delete(msgSpanId);
		parent.updateTimestamp = Date.now();

		// check orphan traces (nodes that do not trigger complete event)
		let isOrphan = true;
		for (const [, span] of parent.spans) {
			if (
				!ORPHAN_NODE_TYPES.includes(
					span.attributes["node_red.node.type"] as string,
				) ||
				((span as Span & OTelSpanExtension)._creationTimestamp ?? 0) >
					(currentSpanCreationTimestamp ?? 0)
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
				parent?.spans.delete(msgSpanId);
			}
			// all children are completed, end and remove parent span
			if (sharedState.isLogging) {
				console.log(
					`Parent span "${parent?.parentSpan.name}" no longer has child span, ending`,
				);
			}
			parent?.parentSpan.end();
			msgSpans.delete(msgId);
		}
	} catch (error) {
		console.error(error);
	}
}

/**
 * @param {RuntimeApi} RED Node-RED runtime object
 */
module.exports = (RED: RuntimeApi) => {
	/**
	 * Initialize the OpenTelemetry system. Can be called by the Plugin API or a Node instance.
	 * @param {OTELConfig} config Optional configuration to override defaults
	 */
	function initOTEL(config: OTELConfig = {}): void {
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
		sharedState.attributeMappings =
			sanitizeAttributeMappings(attributeMappings);
		sharedState.ignoredTypesList = splitCsv(ignoredTypes);
		sharedState.propagateHeadersTypesList = splitCsv(propagateHeadersTypes);

		const commonResource = new Resource({
			[ATTR_SERVICE_NAME]: serviceName,
			[ATTR_HOST_NAME]: os.hostname(),
		});

		// create tracer if not already created
		if (!sharedState.provider && tracesEnabled && url) {
			let spanProcessor: BatchSpanProcessor;
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
			RED.hooks.add("onSend.otel", (events: RuntimeHookEvent[]) => {
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
							event.source?.node as RuntimeNodeDef,
							null,
							sharedState.ignoredTypesList.includes(
								event.source?.node.type ?? "",
							),
						);
					}
				});
			});

			RED.hooks.add("preDeliver.otel", (sendEvent: RuntimeHookEvent) => {
				if (
					sendEvent.source?.node &&
					sharedState.propagateHeadersTypesList.includes(
						sendEvent.source.node.type,
					)
				) {
					if (!sendEvent.msg.headers) {
						sendEvent.msg.headers = {};
					}
					const headers = sendEvent.msg.headers;
					// remove trace context of http request headers
					propagator.fields().forEach((field: string) => {
						delete headers[field];
					});
				}
				logEvent(RED, null, "3.preDeliver", sendEvent);
			});

			RED.hooks.add("postDeliver.otel", (sendEvent: RuntimeHookEvent) => {
				logEvent(RED, null, "4.postDeliver", sendEvent);
				if (!sharedState.tracer || !sendEvent.destination?.node) return;

				const span = createSpan(
					RED,
					sharedState.tracer,
					sendEvent.msg,
					sendEvent.destination.node,
					null,
					sharedState.ignoredTypesList.includes(
						sendEvent.destination.node.type,
					),
				);
				if (
					span &&
					sendEvent.destination.node &&
					sharedState.propagateHeadersTypesList.includes(
						sendEvent.destination.node.type,
					)
				) {
					const output: Record<string, string> = {};
					const ctx = trace.setSpan(context.active(), span as Span);
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
					sendEvent.source?.node &&
					(sendEvent.source.node.type === "switch" ||
						sendEvent.source.node.type.startsWith("subflow"))
				) {
					// end switch or subflow spans as they do not trigger onComplete
					const msgId = getMsgId(sendEvent.msg);
					const spanId = getSpanId(sendEvent.msg, sendEvent.source.node);
					const parent = msgSpans.get(msgId);
					if (parent?.spans.has(spanId)) {
						if (sharedState.isLogging) {
							console.log(`Switch or subflow span ${spanId} will be ended`);
						}
						parent.spans.get(spanId)?.end();
						parent.spans.delete(spanId);
					}
				}
			});

			RED.hooks.add("postReceive.otel", (sendEvent: RuntimeHookEvent) => {
				logEvent(RED, null, "6.postReceive", sendEvent);
			});

			RED.hooks.add("onReceive.otel", (receiveEvent: RuntimeHookEvent) => {
				if (receiveEvent.destination?.node.type === "split") {
					// store parent message id before split
					receiveEvent.msg.otelRootMsgId = getMsgId(receiveEvent.msg);
				}
				logEvent(RED, null, "5.onReceive", receiveEvent);
			});

			RED.hooks.add(
				"onComplete.otel",
				(
					completeEvent: RuntimeHookEvent & { node: { node: RuntimeNodeDef } },
				) => {
					logEvent(RED, null, "7.onComplete", completeEvent);
					endSpan(
						RED,
						completeEvent.msg,
						completeEvent.error,
						completeEvent.node.node,
					);
				},
			);

			// add timer for killing outdated message spans
			sharedState.intervalId = setInterval(deleteOutdatedMsgSpans, 5000);
		}

		sharedState.refCount++;
	}

	async function stopOTEL(): Promise<void> {
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
	function OpenTelemetryNode(this: RedNodeInstance, config: OTELNodeDef) {
		RED.nodes.createNode(this, config);
		initOTEL(config);
		this.on("close", async (done: () => void) => {
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
			onSettings: (settings: unknown) => {
				// We can read from settings.js if needed
				if (
					typeof settings === "object" &&
					settings !== null &&
					"opentelemetry" in settings
				) {
					const pluginSettings = settings as { opentelemetry?: OTELConfig };
					initOTEL(pluginSettings.opentelemetry ?? {});
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
	setAttributeMappings: (mappings: unknown) => {
		sharedState.attributeMappings = sanitizeAttributeMappings(mappings);
	},
	setTimeout: (timeoutMs: number) => {
		sharedState.timeout = timeoutMs;
	},
	setLogging: (value: boolean) => {
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
