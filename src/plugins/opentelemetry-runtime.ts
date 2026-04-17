import os from "node:os";
import { EventEmitter } from "node:events";
import type {
	NodeAPI,
	NodeDef,
	NodeMessageInFlow,
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
import {
	resourceFromAttributes,
	type Resource,
} from "@opentelemetry/resources";
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
	ATTR_CODE_FUNCTION_NAME,
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
	ATTR_HOST_NAME,
} from "@opentelemetry/semantic-conventions/incubating";
import jmespath from "jmespath";
import { name, version } from "../../package.json";

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
const completedHttpMetricsMsgIds = new Map<string, number>();
const completedHttpResponseMsgIds = new Map<string, number>();
const OTEL_HOOK_NAMES = [
	"onSend.otel",
	"preDeliver.otel",
	"postDeliver.otel",
	"postReceive.otel",
	"onReceive.otel",
	"onComplete.otel",
] as const;

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
	flowEventLogsEnabled?: boolean;
	rootPrefix?: string;
	ignoredNodeTypes?: string;
	propagateHeaderNodeTypes?: string;
	logLevel?: string;
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
	tracesProtocol: "grpc" | "proto" | "http";
	metricsProtocol: "grpc" | "proto" | "http";
	logsProtocol: "grpc" | "proto" | "http";
	serviceName: string;
	tracesEnabled: boolean;
	metricsEnabled: boolean;
	logsEnabled: boolean;
	flowEventLogsEnabled: boolean;
	rootPrefix: string;
	ignoredNodeTypes: string;
	propagateHeaderNodeTypes: string;
	logLevel: "off" | "error" | "warn" | "info" | "debug" | "trace";
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

type RuntimeNodeDef = NodeDef & {
	url?: string;
	method?: string;
	serverConfig?: { path: string };
	[key: string]: unknown;
};
type RuntimeMessage = NodeMessageInFlow & {
	otelRootMsgId?: string;
	otelStartTime?: number;
	otelHttpMetricsRecorded?: boolean;
	z?: string;
	headers?: Record<string, string>;
	userProperties?: Record<string, unknown>;
	properties?: { headers: Record<string, string> };
	req?: RuntimeRequest;
	res?: RuntimeResponse;
	statusCode?: number;
	responseUrl?: string;
	topic?: unknown;
	queue?: unknown;
	routingKey?: unknown;
	routing_key?: unknown;
	correlationId?: unknown;
	correlation_id?: unknown;
	partition?: unknown;
	key?: unknown;
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
type RuntimeRedNodeInstance = {
	id?: string;
	name?: string;
};
type RuntimePluginRegistration = {
	type?: string;
	settings?: Record<string, unknown>;
	onadd?: () => Promise<void> | void;
	onremove?: () => Promise<void> | void;
	[key: string]: unknown;
};
type NodeRedUtilLogApi = {
	INFO?: unknown;
	ERROR?: unknown;
	WARN?: unknown;
	DEBUG?: unknown;
	TRACE?: unknown;
	FATAL?: unknown;
	AUDIT?: unknown;
	METRIC?: unknown;
	addHandler?: (handler: EventEmitter) => void;
	removeHandler?: (handler: EventEmitter) => void;
	log: (entry: NodeRedLogEntry) => void;
};
type NodeRedLogEntry = {
	level?: unknown;
	msg?: unknown;
	type?: string;
	id?: string;
	name?: string;
	timestamp?: unknown;
	[key: string]: unknown;
};
type RuntimeApi = NodeAPI & {
	plugins: NodeAPI["plugins"] & {
		registerPlugin?: (id: string, plugin: RuntimePluginRegistration) => void;
	};
};

/**
 * Shared state structure for all node instances
 */
interface SharedState {
	logLevel: "off" | "error" | "warn" | "info" | "debug" | "trace";
	rootPrefix: string;
	timeout: number;
	attributeMappings: AttributeMapping[];
	ignoredNodeTypesList: string[];
	propagateHeaderNodeTypesList: string[];
	tracer: Tracer | null;
	provider: BasicTracerProvider | null;
	meterProvider: MeterProvider | null;
	loggerProvider: LoggerProvider | null;
	logger: Logger | null;
	metrics: {
		requestDuration: Histogram | null;
	};
	intervalId: NodeJS.Timeout | null;
	hooksRegistered: boolean;
	nodeRedLogApi: NodeRedUtilLogApi | null;
	nodeRedLogHandler: EventEmitter | null;
	flowEventLogsEnabled: boolean;
}

// Shared state for all node instances
const sharedState: SharedState = {
	logLevel: "info",
	rootPrefix: "",
	timeout: 10_000,
	attributeMappings: [],
	ignoredNodeTypesList: [],
	propagateHeaderNodeTypesList: [],
	tracer: null,
	provider: null, // Trace provider
	meterProvider: null,
	loggerProvider: null,
	logger: null,
	metrics: {
		requestDuration: null,
	},
	intervalId: null,
	hooksRegistered: false,
	nodeRedLogApi: null,
	nodeRedLogHandler: null,
	flowEventLogsEnabled: true,
};

const DEFAULT_OTEL_TRACE_URL = "http://localhost:4318/v1/traces";
const DEFAULT_OTEL_METRICS_URL = "http://localhost:4318/v1/metrics";
const DEFAULT_OTEL_LOGS_URL = "http://localhost:4318/v1/logs";
const DEFAULT_OTEL_GRPC_URL = "http://localhost:4317";
const DEFAULT_OTEL_PROTOCOL = "http";
const DEFAULT_OTEL_SERVICE_NAME = "Node-RED";
const DEFAULT_ROOT_SPAN_NAME_PREFIX = "";
const DEFAULT_IGNORED_NODE_TYPES = "inject,debug,catch";
const DEFAULT_PROPAGATE_HEADER_NODE_TYPES = "";
const DEFAULT_LOG_LEVEL = "warn";
const DEFAULT_TIMEOUT_SECONDS = 10;

const LOG_LEVEL_PRIORITY = {
	off: 0,
	error: 1,
	warn: 2,
	info: 3,
	debug: 4,
	trace: 5,
} as const;

type LogLevel = keyof typeof LOG_LEVEL_PRIORITY;

function splitCsv(value: string | undefined | null): string[] {
	return String(value ?? "")
		.split(",")
		.map((key) => key.trim())
		.filter((key) => key.length > 0);
}

function ensureSignalPath(
	urlValue: string | undefined,
	signalPath: "/v1/traces" | "/v1/metrics" | "/v1/logs",
	appendToExistingPath: boolean = false,
): string | undefined {
	if (!urlValue) return urlValue;
	if (!URL.canParse(String(urlValue))) {
		return urlValue;
	}
	const parsed = new URL(String(urlValue));
	if (parsed.pathname === "/" || parsed.pathname === "") {
		parsed.pathname = signalPath;
	} else if (appendToExistingPath && !parsed.pathname.endsWith(signalPath)) {
		const basePath = parsed.pathname.replace(/\/+$/, "");
		parsed.pathname = `${basePath}${signalPath}`;
	}
	return parsed.toString();
}

function ensureSignalPathFromGenericEndpoint(
	urlValue: string | undefined,
	signalPath: "/v1/traces" | "/v1/metrics" | "/v1/logs",
): string | undefined {
	if (!urlValue) return urlValue;
	if (!URL.canParse(String(urlValue))) {
		return urlValue;
	}
	const parsed = new URL(String(urlValue));
	if (parsed.pathname === "/" || parsed.pathname === "") {
		parsed.pathname = signalPath;
		return parsed.toString();
	}
	const trimmedPath = parsed.pathname.replace(/\/+$/, "");
	const remappedPath = trimmedPath.replace(
		/\/v1\/(?:traces|metrics|logs)$/u,
		signalPath,
	);
	if (remappedPath !== trimmedPath) {
		parsed.pathname = remappedPath;
		return parsed.toString();
	}
	if (!trimmedPath.endsWith(signalPath)) {
		parsed.pathname = `${trimmedPath}${signalPath}`;
	}
	return parsed.toString();
}

function normalizeGrpcEndpoint(urlValue: string | undefined): string | undefined {
	if (!urlValue) return urlValue;
	if (
		urlValue === DEFAULT_OTEL_TRACE_URL ||
		urlValue === DEFAULT_OTEL_METRICS_URL ||
		urlValue === DEFAULT_OTEL_LOGS_URL
	) {
		return DEFAULT_OTEL_GRPC_URL;
	}
	if (!URL.canParse(String(urlValue))) {
		return urlValue;
	}
	const parsed = new URL(String(urlValue));
	if (/\/v1\/(?:traces|metrics|logs)\/?$/u.test(parsed.pathname)) {
		parsed.pathname = "/";
	}
	return parsed.toString();
}

function parseNodeUrl(
	urlValue: string,
): { url: URL; isAbsolute: boolean } | undefined {
	if (URL.canParse(urlValue)) {
		return { url: new URL(urlValue), isAbsolute: true };
	}
	const fallbackBase = "http://localhost";
	if (URL.canParse(urlValue, fallbackBase)) {
		// Fallback base for relative paths (for pathname extraction only).
		return { url: new URL(urlValue, fallbackBase), isAbsolute: false };
	}
	return undefined;
}

function resolveProtocol(
	value: string | undefined,
): "grpc" | "proto" | "http" | undefined {
	const normalized = String(value ?? "")
		.trim()
		.toLowerCase();
	switch (normalized) {
		case "grpc":
			return "grpc";
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

function resolveLogLevel(value: string | undefined): LogLevel | undefined {
	const normalized = String(value ?? "")
		.trim()
		.toLowerCase();
	switch (normalized) {
		case "off":
		case "error":
		case "warn":
		case "info":
		case "debug":
		case "trace":
			return normalized;
		default:
			return undefined;
	}
}

function resolveNodeRedLogLevel(settings: unknown): LogLevel | undefined {
	if (!settings || typeof settings !== "object") {
		return undefined;
	}
	const logging = (settings as { logging?: unknown }).logging;
	if (!logging || typeof logging !== "object") {
		return undefined;
	}
	const loggingRecord = logging as Record<string, unknown>;
	const candidateLevels: unknown[] = [
		(loggingRecord.console as { level?: unknown } | undefined)?.level,
		loggingRecord.level,
	];
	for (const [key, value] of Object.entries(loggingRecord)) {
		if (key === "console" || key === "level") {
			continue;
		}
		if (value && typeof value === "object") {
			candidateLevels.push((value as { level?: unknown }).level);
		}
	}
	for (const levelValue of candidateLevels) {
		const normalized = String(levelValue ?? "")
			.trim()
			.toLowerCase();
		if (!normalized) {
			continue;
		}
		if (normalized === "fatal") {
			return "error";
		}
		const resolved = resolveLogLevel(normalized);
		if (resolved) {
			return resolved;
		}
	}
	return undefined;
}

function mapNodeRedLevelToPluginLevel(severityText: string): LogLevel {
	switch (severityText) {
		case "FATAL":
		case "ERROR":
			return "error";
		case "WARN":
			return "warn";
		case "INFO":
			return "info";
		case "DEBUG":
			return "debug";
		case "TRACE":
			return "trace";
		default:
			return "info";
	}
}

function parseExporterEnv(value: string | undefined): string[] {
	if (value === undefined) {
		return [];
	}
	return String(value)
		.split(",")
		.map((item) => item.trim().toLowerCase())
		.filter((item) => item.length > 0);
}

function resolveSignalEnabledFromEnv(
	exporterEnv: string | undefined,
): boolean | undefined {
	const exporters = parseExporterEnv(exporterEnv);
	if (exporters.length === 0) {
		return undefined;
	}
	if (exporters.includes("none")) {
		return false;
	}
	if (exporters.includes("otlp")) {
		return true;
	}
	return false;
}

function shouldLog(requiredLevel: LogLevel): boolean {
	return (
		LOG_LEVEL_PRIORITY[sharedState.logLevel] >=
		LOG_LEVEL_PRIORITY[requiredLevel]
	);
}

function pluginLog(
	level: Exclude<LogLevel, "off">,
	message: string,
	error?: unknown,
): void {
	const logApi = getNodeRedUtilLogApi();
	const body = error !== undefined ? `${message} ${stringifyLogBody(error)}` : message;
	if (logApi) {
		switch (level) {
			case "error":
				logApi.log({ level: logApi.ERROR, msg: body });
				break;
			case "warn":
				logApi.log({ level: logApi.WARN, msg: body });
				break;
			case "info":
				logApi.log({ level: logApi.INFO, msg: body });
				break;
			case "debug":
				logApi.log({ level: logApi.DEBUG, msg: body });
				break;
			case "trace":
				logApi.log({ level: logApi.TRACE, msg: body });
				break;
		}
		return;
	}
	switch (level) {
		case "error":
			if (error !== undefined) {
				console.error(message, error);
			} else {
				console.error(message);
			}
			break;
		case "warn":
			if (error !== undefined) {
				console.warn(message, error);
			} else {
				console.warn(message);
			}
			break;
		case "info":
		case "debug":
		case "trace":
			if (error !== undefined) {
				console.log(message, error);
			} else {
				console.log(message);
			}
			break;
	}
}

function stringifyLogBody(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (value instanceof Error) {
		return value.stack || value.message;
	}
	if (value === null || value === undefined) {
		return "";
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function getNodeRedUtilLogApi(): NodeRedUtilLogApi | null {
	if (sharedState.nodeRedLogApi) {
		return sharedState.nodeRedLogApi;
	}
	try {
		const nodeRedUtil = require("@node-red/util") as { log?: NodeRedUtilLogApi };
		if (nodeRedUtil?.log) {
			sharedState.nodeRedLogApi = nodeRedUtil.log;
			return nodeRedUtil.log;
		}
	} catch {}
	return null;
}

function resolveNodeRedSeverity(
	level: unknown,
	logApi: NodeRedUtilLogApi | null,
): { severityNumber: SeverityNumber; severityText: string } {
	if (level !== undefined && logApi) {
		const numericLevel =
			typeof level === "string" && /^\d+$/u.test(level.trim())
				? Number(level)
				: level;
		if (numericLevel === logApi.FATAL) {
			return { severityNumber: SeverityNumber.FATAL, severityText: "FATAL" };
		}
		if (numericLevel === logApi.ERROR) {
			return { severityNumber: SeverityNumber.ERROR, severityText: "ERROR" };
		}
		if (numericLevel === logApi.WARN) {
			return { severityNumber: SeverityNumber.WARN, severityText: "WARN" };
		}
		if (numericLevel === logApi.DEBUG) {
			return { severityNumber: SeverityNumber.DEBUG, severityText: "DEBUG" };
		}
		if (numericLevel === logApi.TRACE) {
			return { severityNumber: SeverityNumber.TRACE, severityText: "TRACE" };
		}
	}
	const normalizedLevel = String(level ?? "").trim().toLowerCase();
	switch (normalizedLevel) {
		case "fatal":
			return { severityNumber: SeverityNumber.FATAL, severityText: "FATAL" };
		case "error":
			return { severityNumber: SeverityNumber.ERROR, severityText: "ERROR" };
		case "warn":
		case "warning":
			return { severityNumber: SeverityNumber.WARN, severityText: "WARN" };
		case "debug":
			return { severityNumber: SeverityNumber.DEBUG, severityText: "DEBUG" };
		case "trace":
			return { severityNumber: SeverityNumber.TRACE, severityText: "TRACE" };
		case "audit":
		case "metric":
		case "info":
		default:
			return { severityNumber: SeverityNumber.INFO, severityText: "INFO" };
	}
}

function emitNodeRedRuntimeLog(entry: NodeRedLogEntry): void {
	if (!sharedState.logger) {
		return;
	}
	const logApi = getNodeRedUtilLogApi();
	const body = stringifyLogBody(entry.msg);
	if (!body) {
		return;
	}
	const { severityNumber, severityText } = resolveNodeRedSeverity(
		entry.level,
		logApi,
	);
	if (!shouldLog(mapNodeRedLevelToPluginLevel(severityText))) {
		return;
	}
	const attributes: Record<string, string | number> = {
		"node_red.event_type": "runtime.log",
		"node_red.log.level": severityText.toLowerCase(),
	};
	if (entry.type) {
		attributes["node_red.log.type"] = String(entry.type);
	}
	if (entry.id) {
		attributes["node_red.log.id"] = String(entry.id);
	}
	if (entry.name) {
		attributes["node_red.log.name"] = String(entry.name);
	}
	if (typeof entry.timestamp === "number") {
		attributes["node_red.log.timestamp"] = entry.timestamp;
	}
	sharedState.logger.emit({
		severityNumber,
		severityText,
		body,
		attributes,
		context: context.active(),
	});
}

function unregisterNodeRedLogHandler(): void {
	if (!sharedState.nodeRedLogHandler) {
		return;
	}
	const logApi = getNodeRedUtilLogApi();
	try {
		logApi?.removeHandler?.(sharedState.nodeRedLogHandler);
	} catch (error) {
		pluginLog("debug", "Failed to remove Node-RED log handler", error);
	}
	sharedState.nodeRedLogHandler.removeAllListeners("log");
	sharedState.nodeRedLogHandler = null;
}

function registerNodeRedLogHandler(): void {
	if (!sharedState.logger || sharedState.nodeRedLogHandler) {
		return;
	}
	const logApi = getNodeRedUtilLogApi();
	if (!logApi?.addHandler) {
		return;
	}
	const handler = new EventEmitter();
	handler.on("log", (entry: NodeRedLogEntry) => {
		try {
			emitNodeRedRuntimeLog(entry);
		} catch (error) {
			pluginLog("debug", "Failed to emit Node-RED runtime log", error);
		}
	});
	try {
		logApi.addHandler(handler);
		sharedState.nodeRedLogHandler = handler;
	} catch (error) {
		pluginLog("warn", "Failed to register Node-RED log handler", error);
	}
}

function maskUrlCredentials(urlValue: string): string {
	try {
		const parsedUrl = new URL(urlValue);
		if (parsedUrl.password.length > 0) {
			parsedUrl.password = "***";
			return parsedUrl.toString();
		}
		return urlValue;
	} catch {
		return urlValue;
	}
}

function formatStartupConfigSummary(config: ResolvedOTELConfig): string {
	const attributeMappingsCount = Array.isArray(config.attributeMappings)
		? config.attributeMappings.length
		: 0;
	const tracesUrl = config.tracesEnabled
		? config.url
			? maskUrlCredentials(config.url)
			: "n/a"
		: "disabled";
	const metricsUrl = config.metricsEnabled
		? config.metricsUrl
			? maskUrlCredentials(config.metricsUrl)
			: "n/a"
		: "disabled";
	const logsUrl = config.logsEnabled
		? config.logsUrl
			? maskUrlCredentials(config.logsUrl)
			: "n/a"
		: "disabled";

	return [
		`serviceName=${String(config.serviceName)}`,
		`logLevel=${String(config.logLevel)}`,
		`tracesEnabled=${String(config.tracesEnabled)}`,
		`tracesProtocol=${String(config.tracesProtocol)}`,
		`tracesUrl=${tracesUrl}`,
		`metricsEnabled=${String(config.metricsEnabled)}`,
		`metricsProtocol=${String(config.metricsProtocol)}`,
		`metricsUrl=${metricsUrl}`,
		`logsEnabled=${String(config.logsEnabled)}`,
		`flowEventLogsEnabled=${String(config.flowEventLogsEnabled)}`,
		`logsProtocol=${String(config.logsProtocol)}`,
		`logsUrl=${logsUrl}`,
		`rootPrefix=${String(config.rootPrefix)}`,
		`ignoredNodeTypes=${String(config.ignoredNodeTypes)}`,
		`propagateHeaderNodeTypes=${String(config.propagateHeaderNodeTypes)}`,
		`timeout=${String(config.timeout)}`,
		`attributeMappings=${String(attributeMappingsCount)}`,
	].join(", ");
}

function resolveOpenTelemetryConfig(
	config: OTELConfig,
	nodeRedSettings?: unknown,
): ResolvedOTELConfig {
	const env = process.env;
	const tracesEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
	const metricsEndpoint = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
	const logsEndpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
	const genericEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
	const tracesProtocolEnv = env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL;
	const metricsProtocolEnv = env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL;
	const logsProtocolEnv = env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL;
	const genericProtocol = env.OTEL_EXPORTER_OTLP_PROTOCOL;
	const serviceNameEnv = env.OTEL_SERVICE_NAME;
	const logLevelEnv = env.OTEL_LOG_LEVEL;
	const ignoredNodeTypesEnv = env.IGNORED_NODE_TYPES;
	const tracesExporterEnv = env.OTEL_TRACES_EXPORTER;
	const metricsExporterEnv = env.OTEL_METRICS_EXPORTER;
	const logsExporterEnv = env.OTEL_LOGS_EXPORTER;

	const resolvedTracesProtocol = resolveProtocol(
		tracesProtocolEnv || genericProtocol,
	);
	const resolvedMetricsProtocol = resolveProtocol(
		metricsProtocolEnv || genericProtocol,
	);
	const resolvedLogsProtocol = resolveProtocol(
		logsProtocolEnv || genericProtocol,
	);

	const selectedTraceEndpoint =
		tracesEndpoint || genericEndpoint || undefined;
	const selectedMetricsEndpoint =
		metricsEndpoint || genericEndpoint || undefined;
	const selectedLogsEndpoint =
		logsEndpoint || genericEndpoint || undefined;

	const isTraceGenericEndpoint = Boolean(
		!tracesEndpoint && genericEndpoint,
	);
	const isMetricsGenericEndpoint = Boolean(
		!metricsEndpoint && genericEndpoint,
	);
	const isLogsGenericEndpoint = Boolean(
		!logsEndpoint && genericEndpoint,
	);

	const configuredProtocol =
		resolveProtocol(config.protocol || DEFAULT_OTEL_PROTOCOL) || "http";
	const tracesProtocol = resolvedTracesProtocol || configuredProtocol;
	const metricsProtocol = resolvedMetricsProtocol || configuredProtocol;
	const logsProtocol = resolvedLogsProtocol || configuredProtocol;
	const nodeRedLogLevel = resolveNodeRedLogLevel(nodeRedSettings);
	const configuredLogLevel =
		resolveLogLevel(logLevelEnv) ||
		resolveLogLevel(config.logLevel) ||
		nodeRedLogLevel ||
		DEFAULT_LOG_LEVEL;
	const configuredGenericEndpoint = config.url || undefined;
	const configuredMetricsEndpoint = config.metricsUrl || undefined;
	const configuredLogsEndpoint = config.logsUrl || undefined;
	const configuredTraceUrl = ensureSignalPath(
		configuredGenericEndpoint || DEFAULT_OTEL_TRACE_URL,
		"/v1/traces",
	);
	const configuredMetricsUrl = configuredMetricsEndpoint
		? ensureSignalPath(configuredMetricsEndpoint, "/v1/metrics")
		: configuredGenericEndpoint
			? ensureSignalPathFromGenericEndpoint(
				configuredGenericEndpoint,
				"/v1/metrics",
			)
			: ensureSignalPath(DEFAULT_OTEL_METRICS_URL, "/v1/metrics");
	const configuredLogsUrl = configuredLogsEndpoint
		? ensureSignalPath(configuredLogsEndpoint, "/v1/logs")
		: configuredGenericEndpoint
			? ensureSignalPathFromGenericEndpoint(configuredGenericEndpoint, "/v1/logs")
			: ensureSignalPath(DEFAULT_OTEL_LOGS_URL, "/v1/logs");
	const tracesEnabledFromEnv = resolveSignalEnabledFromEnv(tracesExporterEnv);
	const metricsEnabledFromEnv = resolveSignalEnabledFromEnv(metricsExporterEnv);
	const logsEnabledFromEnv = resolveSignalEnabledFromEnv(logsExporterEnv);
	const hasMetricsOtlpEnvConfig = Boolean(selectedMetricsEndpoint);
	const hasLogsOtlpEnvConfig = Boolean(selectedLogsEndpoint);
	const configuredTraceEndpointForProtocol =
		tracesProtocol === "grpc"
			? normalizeGrpcEndpoint(configuredGenericEndpoint) || DEFAULT_OTEL_GRPC_URL
			: configuredTraceUrl;
	const configuredMetricsEndpointForProtocol =
		metricsProtocol === "grpc"
			? normalizeGrpcEndpoint(configuredMetricsEndpoint ?? configuredGenericEndpoint) ||
				DEFAULT_OTEL_GRPC_URL
			: configuredMetricsUrl;
	const configuredLogsEndpointForProtocol =
		logsProtocol === "grpc"
			? normalizeGrpcEndpoint(configuredLogsEndpoint ?? configuredGenericEndpoint) ||
				DEFAULT_OTEL_GRPC_URL
			: configuredLogsUrl;

	return {
		url: selectedTraceEndpoint
			? tracesProtocol === "grpc"
				? selectedTraceEndpoint
				: ensureSignalPath(
					selectedTraceEndpoint,
					"/v1/traces",
					isTraceGenericEndpoint,
				)
			: configuredTraceEndpointForProtocol,
		metricsUrl: selectedMetricsEndpoint
			? metricsProtocol === "grpc"
				? selectedMetricsEndpoint
				: ensureSignalPath(
					selectedMetricsEndpoint,
					"/v1/metrics",
					isMetricsGenericEndpoint,
				)
			: configuredMetricsEndpointForProtocol,
		logsUrl: selectedLogsEndpoint
			? logsProtocol === "grpc"
				? selectedLogsEndpoint
				: ensureSignalPath(
					selectedLogsEndpoint,
					"/v1/logs",
					isLogsGenericEndpoint,
				)
			: configuredLogsEndpointForProtocol,
		protocol: tracesProtocol,
		tracesProtocol,
		metricsProtocol,
		logsProtocol,
		serviceName: serviceNameEnv || config.serviceName || DEFAULT_OTEL_SERVICE_NAME,
		tracesEnabled:
			tracesEnabledFromEnv ??
			config.tracesEnabled ??
			true,
		metricsEnabled:
			metricsEnabledFromEnv ??
			config.metricsEnabled ??
			(hasMetricsOtlpEnvConfig ? true : false),
		logsEnabled:
			logsEnabledFromEnv ??
			config.logsEnabled ??
			(hasLogsOtlpEnvConfig ? true : false),
		flowEventLogsEnabled: config.flowEventLogsEnabled ?? true,
		rootPrefix: config.rootPrefix ?? DEFAULT_ROOT_SPAN_NAME_PREFIX,
		ignoredNodeTypes:
			ignoredNodeTypesEnv ??
			config.ignoredNodeTypes ??
			DEFAULT_IGNORED_NODE_TYPES,
		propagateHeaderNodeTypes:
			config.propagateHeaderNodeTypes ?? DEFAULT_PROPAGATE_HEADER_NODE_TYPES,
		logLevel: configuredLogLevel,
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

function setAttributeIfPrimitive(
	target: Record<string, string | number | boolean | undefined>,
	key: string,
	value: unknown,
): void {
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		target[key] = value;
	}
}

function extractEndpointFromNode(nodeDefinition: RuntimeNodeDef): string | undefined {
	if (typeof nodeDefinition.serverConfig?.path === "string") {
		return nodeDefinition.serverConfig.path;
	}
	if (typeof nodeDefinition.url === "string") {
		return nodeDefinition.url;
	}
	return undefined;
}

function buildAutoSpanAttributes(
	msg: RuntimeMessage,
	nodeDefinition: RuntimeNodeDef,
): Record<string, string | number | boolean | undefined> {
	const attributes: Record<string, string | number | boolean | undefined> = {};
	const endpoint = extractEndpointFromNode(nodeDefinition);
	if (endpoint) {
		const parsedUrl = parseNodeUrl(endpoint);
		if (parsedUrl) {
			attributes[ATTR_URL_PATH] = parsedUrl.url.pathname;
			if (parsedUrl.isAbsolute) {
				attributes[ATTR_SERVER_ADDRESS] = parsedUrl.url.hostname;
				attributes[ATTR_SERVER_PORT] = parsedUrl.url.port;
				attributes[ATTR_URL_SCHEME] = parsedUrl.url.protocol.replace(":", "");
			}
		} else {
			attributes[ATTR_URL_PATH] = endpoint;
		}
	}

	const incomingMethod = msg.req?.method ?? nodeDefinition.method;
	if (incomingMethod) {
		attributes[ATTR_HTTP_REQUEST_METHOD] = String(incomingMethod).toUpperCase();
	}
	if (msg.req?.path && !attributes[ATTR_URL_PATH]) {
		attributes[ATTR_URL_PATH] = msg.req.path;
	}
	setAttributeIfPrimitive(attributes, ATTR_CLIENT_ADDRESS, msg.req?.ip);
	setAttributeIfPrimitive(
		attributes,
		ATTR_HTTP_REQUEST_HEADER("x-forwarded-for"),
		msg.req?.headers?.["x-forwarded-for"],
	);
	setAttributeIfPrimitive(
		attributes,
		ATTR_USER_AGENT_ORIGINAL,
		msg.req?.headers?.["user-agent"],
	);
	setAttributeIfPrimitive(attributes, "node_red.msg.topic", msg.topic);
	setAttributeIfPrimitive(attributes, "node_red.msg.queue", msg.queue);
	setAttributeIfPrimitive(
		attributes,
		"node_red.msg.routing_key",
		msg.routingKey ?? msg.routing_key,
	);
	setAttributeIfPrimitive(
		attributes,
		"node_red.msg.correlation_id",
		msg.correlationId ?? msg.correlation_id,
	);
	setAttributeIfPrimitive(attributes, "node_red.msg.partition", msg.partition);
	setAttributeIfPrimitive(attributes, "node_red.msg.key", msg.key);
	return attributes;
}

function hasHttpServerContext(
	msg: RuntimeMessage,
	nodeDefinition: RuntimeNodeDef,
): boolean {
	return Boolean(
		msg.req?.headers ||
			msg.req?.method ||
			msg.req?.path ||
			nodeDefinition.method,
	);
}

function hasHttpResponseContext(msg: RuntimeMessage): boolean {
	return Boolean(msg.res?._res?.statusCode || msg.req?.method || msg.req?.path);
}

function captureHttpStartTimeIfNeeded(
	msg: RuntimeMessage,
	nodeDefinition: RuntimeNodeDef,
): void {
	if (msg.otelStartTime !== undefined) {
		return;
	}
	if (!hasHttpServerContext(msg, nodeDefinition)) {
		return;
	}
	msg.otelStartTime = Date.now();
}

function shouldHandleTerminalHttpResponse(
	msg: RuntimeMessage,
	nodeDefinition: RuntimeNodeDef,
): boolean {
	if (nodeDefinition.type === "http response") {
		return true;
	}
	const response = msg.res?._res as
		| { finished?: boolean; headersSent?: boolean }
		| undefined;
	return Boolean(response?.finished || response?.headersSent);
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
	const flow = RED.nodes.getNode(flowId) as RuntimeRedNodeInstance | undefined;
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
	if (!event.msg) {
		return;
	}
	// Structured OTel logs follow the logs signal enablement (logger presence),
	// while logLevel controls plugin diagnostics written to Node-RED log or console.
	// We also respect logLevel for OTel logs to avoid flooding the backend.
	const emitOtelLogger =
		sharedState.logger &&
		sharedState.flowEventLogsEnabled &&
		shouldLog("info");

	// Diagnostic logging to Node-RED/console is delegated to Node-RED log settings in pluginLog.
	// We call it at 'debug' level for flow events.
	const msgId = getMsgId(event.msg);
	const _msgId = event.msg._msgid;
	const flowName = event.msg.z ? getFlowName(RED, event.msg.z) : undefined;
	let logMsg = `rootMsgId: ${msgId}, _msgId: ${_msgId}:`;

	if (event.source?.node) {
		logMsg += ` src: ${event.source.node.type} ${event.source.node.id}`;
	}
	if (event.destination?.node) {
		logMsg += ` >> dest: ${event.destination.node.type} ${event.destination.node.id}`;
	}
	if (event.node?.node) {
		logMsg += ` ## node: ${event.node.node.type} ${event.node.node.id}`;
	}

	pluginLog("debug", `${eventType}: ${logMsg}`);

	if (!emitOtelLogger) {
		return;
	}

	try {
		const attributes: Record<string, string> = {
			[ATTR_MSG_ID]: msgId,
			"node_red.msg._msgid": _msgId,
			"node_red.event_type": eventType,
		};
		if (flowName) {
			attributes[ATTR_FLOW_NAME] = flowName;
		}

		if (event.source?.node) {
			attributes[ATTR_NODE_ID] = event.source.node.id;
			attributes[ATTR_NODE_TYPE] = event.source.node.type;
		}
		if (event.destination?.node) {
			attributes["node_red.destination.id"] = event.destination.node.id;
			attributes["node_red.destination.type"] = event.destination.node.type;
		}
		if (event.node?.node) {
			attributes[ATTR_NODE_ID] = event.node.node.id;
			attributes[ATTR_NODE_TYPE] = event.node.node.type;
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
		pluginLog("error", `An error occurred during logging ${eventType}`, error);
	}
}

/**
 * Delete outdated message spans
 */
function deleteOutdatedMsgSpans(): void {
	const now = Date.now();
	try {
		for (const [msgId, recordedTimestamp] of completedHttpMetricsMsgIds) {
			if (recordedTimestamp < now - sharedState.timeout) {
				completedHttpMetricsMsgIds.delete(msgId);
			}
		}
		for (const [msgId, recordedTimestamp] of completedHttpResponseMsgIds) {
			if (recordedTimestamp < now - sharedState.timeout) {
				completedHttpResponseMsgIds.delete(msgId);
			}
		}
		for (const [msgId, msgSpan] of msgSpans) {
			if (msgSpan.updateTimestamp < now - sharedState.timeout) {
				// ending parent span and remove it
				pluginLog(
					"debug",
					`Parent span "${msgSpan.parentSpan.name}" ${msgId} is outdated, ending`,
				);
				msgSpan.parentSpan.end(msgSpan.updateTimestamp);
				msgSpans.delete(msgId);
				completedHttpMetricsMsgIds.delete(msgId);
				completedHttpResponseMsgIds.delete(msgId);
			}
		}
	} catch (error) {
		pluginLog("error", "An error occurred during span cleaning", error);
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
				pluginLog(
					"warn",
					`An error occurred during span attribute parsing (key: ${mapping.key}, path: ${mapping.path}): ${(error as Error).message}`,
				);
			}
		});
	return attributes;
}

function resolveSpanKind(nodeType: string): SpanKind {
	switch (nodeType) {
		case "http in":
		case "tcp in":
		case "udp in":
			return SpanKind.SERVER;
		case "http request":
		case "tcp request":
			return SpanKind.CLIENT;
		case "mqtt in":
		case "amqp-in":
		case "websocket in":
			return SpanKind.CONSUMER;
		case "mqtt out":
		case "amqp-out":
		case "websocket out":
			return SpanKind.PRODUCER;
		default:
			return SpanKind.INTERNAL;
	}
}

function buildCommonAttributes(
	msgId: string,
	nodeDefinition: RuntimeNodeDef,
	flowName: string | undefined,
): Record<string, string | undefined> {
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
	return commonAttributes;
}

function extractIncomingContext(
	msg: RuntimeMessage,
	nodeDefinition: RuntimeNodeDef,
): Context | undefined {
	if (hasHttpServerContext(msg, nodeDefinition)) {
		return propagator.extract(
			context.active(),
			msg.req?.headers ?? {},
			defaultTextMapGetter,
		);
	}
	if (nodeDefinition.type === "mqtt in" && msg.userProperties) {
		return propagator.extract(
			context.active(),
			msg.userProperties,
			defaultTextMapGetter,
		);
	}
	if (nodeDefinition.type === "amqp-in") {
		return propagator.extract(
			context.active(),
			msg.properties?.headers ?? {},
			defaultTextMapGetter,
		);
	}
	return undefined;
}

function createAndStoreParentSpan(
	tracer: Tracer,
	msg: RuntimeMessage,
	msgId: string,
	spanName: string,
	nodeDefinition: RuntimeNodeDef,
	kind: SpanKind,
	commonAttributes: Record<string, string | undefined>,
	now: number,
): { parentSpan: Span; context: Context } {
	const extractedContext = extractIncomingContext(msg, nodeDefinition);
	const parentSpan = tracer.startSpan(
		sharedState.rootPrefix + spanName,
		{
			attributes: {
				[ATTR_IS_MESSAGE_CREATION]: true,
				[ATTR_SERVICE_NAME]: nodeDefinition.type,
				...commonAttributes,
			},
			kind,
		},
		extractedContext,
	);
	const parentContext = trace.setSpan(context.active(), parentSpan);
	msgSpans.set(msgId, {
		parentSpan,
		spans: new Map(),
		updateTimestamp: now,
	});
	return { parentSpan, context: parentContext };
}

function storeFakeChildSpan(
	msgId: string,
	spanId: string,
	nodeDefinition: RuntimeNodeDef,
	now: number,
): Span {
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
	_node: RuntimeRedNodeInstance | null,
	isNotTraced: boolean,
): Span | undefined {
	try {
		const msgId = getMsgId(msg);
		if (msgId === undefined) {
			return;
		}
		const spanId = getSpanId(msg, nodeDefinition);
		const existingParent = msgSpans.get(msgId);
		if (msgSpans.has(msgId) && existingParent?.spans.has(spanId)) {
			return;
		}

		const spanName = nodeDefinition.name || nodeDefinition.type;
		const flowName = getFlowName(RED, nodeDefinition.z);
		const now = Date.now();
		const kind = resolveSpanKind(nodeDefinition.type);
		const commonAttributes = buildCommonAttributes(msgId, nodeDefinition, flowName);
		let parentSpan: Span | undefined;
		let ctx: Context | undefined =
			existingParent &&
			trace.setSpan(context.active(), existingParent.parentSpan);
		if (!existingParent) {
			const createdParent = createAndStoreParentSpan(
				tracer,
				msg,
				msgId,
				spanName,
				nodeDefinition,
				kind,
				commonAttributes,
				now,
			);
			parentSpan = createdParent.parentSpan;
			ctx = createdParent.context;
			pluginLog("debug", `=> Created parent span for ${nodeDefinition.type}`);
		}

		if (isNotTraced) {
			return storeFakeChildSpan(msgId, spanId, nodeDefinition, now);
		}
		const localAttributes = parseAttribute(
			false,
			msg,
			nodeDefinition.z,
			nodeDefinition.type,
		);
		pluginLog(
			"debug",
			`Local span attributes (start) for ${nodeDefinition.id}, ${nodeDefinition.type}: ${JSON.stringify(localAttributes)}`,
		);
		const span = tracer.startSpan(
			spanName,
			{
				attributes: {
					[ATTR_CODE_FUNCTION_NAME]: nodeDefinition.type,
					[ATTR_IS_MESSAGE_CREATION]: false,
					...commonAttributes,
					...localAttributes,
				},
				kind,
			},
			ctx,
		) as Span & { _creationTimestamp: number };
		span._creationTimestamp = now;

		const autoAttributes = buildAutoSpanAttributes(msg, nodeDefinition);
		span.setAttributes(autoAttributes);
		if (hasHttpServerContext(msg, nodeDefinition) && msg.otelStartTime === undefined) {
			msg.otelStartTime = now;
		}
		if (parentSpan !== undefined) {
			parentSpan.setAttributes(autoAttributes);
			if (typeof autoAttributes[ATTR_URL_PATH] === "string") {
				const parentSpanExt = parentSpan as Span & OTelSpanExtension;
				parentSpanExt.updateName?.(
					`${parentSpanExt.name ?? ""} ${autoAttributes[ATTR_URL_PATH]}`,
				);
			}
		}

		pluginLog("debug", `=> Created span for ${nodeDefinition.type}`);

		// store child span
		const parent = msgSpans.get(msgId);
		parent?.spans.set(spanId, span);
		if (parent) {
			parent.updateTimestamp = now;
		}
		return span;
	} catch (error) {
		pluginLog("error", "An error occurred during span creation", error);
	}
}

function recordHttpResponseMetricsIfNeeded(
	msgId: string,
	msg: RuntimeMessage,
	nodeDefinition: RuntimeNodeDef,
): void {
	if (!shouldHandleTerminalHttpResponse(msg, nodeDefinition)) {
		return;
	}
	if (!hasHttpResponseContext(msg)) {
		return;
	}
	if (completedHttpMetricsMsgIds.has(msgId) || msg.otelHttpMetricsRecorded) {
		return;
	}
	if (!sharedState.metrics.requestDuration || !msg.otelStartTime) {
		return;
	}
	const duration = Date.now() - msg.otelStartTime;
	sharedState.metrics.requestDuration.record(duration, {
		[ATTR_HTTP_RESPONSE_STATUS_CODE]: msg.res?._res?.statusCode ?? 0,
		[ATTR_HTTP_REQUEST_METHOD]: msg.req?.method ?? "",
		[ATTR_URL_PATH]: msg.req?.path ?? "",
	});
	completedHttpMetricsMsgIds.set(msgId, Date.now());
	msg.otelHttpMetricsRecorded = true;
}

function resolveSpanContextForEnd(
	msgId: string,
	msgSpanId: string,
): { parent: { parentSpan: Span; spans: Map<string, Span>; updateTimestamp: number }; span: Span | undefined } | undefined {
	if (!msgSpans.has(msgId) || !msgSpans.get(msgId)?.spans.has(msgSpanId)) {
		return undefined;
	}
	const parent = msgSpans.get(msgId);
	if (!parent) {
		return undefined;
	}
	return { parent, span: parent.spans.get(msgSpanId) };
}

function applyClientResponseAttributes(span: Span | undefined, msg: RuntimeMessage): void {
	if (typeof msg.statusCode !== "number" && !msg.responseUrl) {
		return;
	}
	const statusCode = msg.statusCode;
	if (typeof statusCode === "number") {
		span?.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode);
		if (statusCode >= 400) {
			span?.setStatus({ code: SpanStatusCode.ERROR });
		} else if (statusCode >= 200 && statusCode < 300) {
			span?.setStatus({ code: SpanStatusCode.OK });
		}
	}
	if (!msg.responseUrl) {
		return;
	}
	try {
		const url = new URL(msg.responseUrl);
		span?.setAttribute(ATTR_URL_PATH, url.pathname);
		span?.setAttribute(ATTR_SERVER_ADDRESS, url.hostname);
		span?.setAttribute(ATTR_SERVER_PORT, url.port);
		span?.setAttribute(ATTR_URL_SCHEME, url.protocol.replace(":", ""));
	} catch (_error) {}
}

function applyErrorToSpan(
	span: Span | undefined,
	parent: { parentSpan: Span },
	error: unknown,
	msg: RuntimeMessage,
): boolean {
	if (!error) {
		return false;
	}
	const exception = msg.error ?? error;
	if (exception instanceof Error || typeof exception === "string") {
		span?.recordException(exception);
	} else {
		span?.recordException(String(exception));
	}
	span?.setStatus({
		code: SpanStatusCode.ERROR,
		message: error instanceof Error ? error.message : String(error),
	});
	parent.parentSpan.setStatus({ code: SpanStatusCode.ERROR });
	return true;
}

function applyLocalEndAttributes(
	span: Span | undefined,
	msg: RuntimeMessage,
	nodeDefinition: RuntimeNodeDef,
): void {
	const localAttributes = parseAttribute(
		true,
		msg,
		nodeDefinition.z,
		nodeDefinition.type,
	);
	if (localAttributes === undefined) {
		return;
	}
	for (const [key, value] of Object.entries(localAttributes)) {
		span?.setAttribute(key, value);
	}
	pluginLog(
		"debug",
		`Local span attributes (end) for ${nodeDefinition.id}, ${nodeDefinition.type}: ${JSON.stringify(localAttributes)}`,
	);
}

function applyHttpResponseCompletion(
	msgId: string,
	parent: { parentSpan: Span; spans: Map<string, Span> },
	span: Span | undefined,
	msg: RuntimeMessage,
	nodeDefinition: RuntimeNodeDef,
	hasError: boolean,
): void {
	if (!shouldHandleTerminalHttpResponse(msg, nodeDefinition)) {
		return;
	}
	if (!hasHttpResponseContext(msg)) {
		return;
	}
	if (completedHttpResponseMsgIds.has(msgId)) {
		return;
	}
	const statusCode = msg.res?._res?.statusCode;
	if (typeof statusCode === "number") {
		if (statusCode >= 400) {
			span?.setStatus({ code: SpanStatusCode.ERROR });
			parent.parentSpan.setStatus({ code: SpanStatusCode.ERROR });
		} else if (statusCode >= 200 && statusCode < 300 && !hasError) {
			span?.setStatus({ code: SpanStatusCode.OK });
			parent.parentSpan.setStatus({ code: SpanStatusCode.OK });
		}
		span?.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode);
		parent.parentSpan.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode);
	}
	completedHttpResponseMsgIds.set(msgId, Date.now());
}

function hasActiveNonOrphanChildSpan(
	parent: { spans: Map<string, Span> },
	currentSpanCreationTimestamp: number | undefined,
): boolean {
	for (const [, childSpan] of parent.spans) {
		const childSpanExt = childSpan as Span & {
			attributes: Record<string, unknown>;
			_creationTimestamp?: number;
		};
		if (
			!ORPHAN_NODE_TYPES.includes(
				childSpanExt.attributes["node_red.node.type"] as string,
			) ||
			(childSpanExt._creationTimestamp ?? 0) >
				(currentSpanCreationTimestamp ?? 0)
		) {
			return true;
		}
	}
	return false;
}

function cleanupOrphanSpansIfNeeded(
	msgId: string,
	parent: { parentSpan: Span; spans: Map<string, Span> },
	currentSpanCreationTimestamp: number | undefined,
): void {
	if (hasActiveNonOrphanChildSpan(parent, currentSpanCreationTimestamp)) {
		return;
	}
	for (const [orphanSpanId] of parent.spans) {
		pluginLog("debug", `Orphan span to delete: ${orphanSpanId}`);
		parent.spans.delete(orphanSpanId);
	}
	pluginLog(
		"debug",
		`Parent span "${(parent.parentSpan as Span & OTelSpanExtension).name ?? ""}" no longer has child span, ending`,
	);
	parent.parentSpan.end();
	msgSpans.delete(msgId);
	completedHttpMetricsMsgIds.delete(msgId);
	completedHttpResponseMsgIds.delete(msgId);
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
			const msgId = getMsgId(msg);
			if (!msgId) {
				return;
			}
			recordHttpResponseMetricsIfNeeded(msgId, msg, nodeDefinition);
			const msgSpanId = getSpanId(msg, nodeDefinition);
			const spanContext = resolveSpanContextForEnd(msgId, msgSpanId);
			if (!spanContext) {
			return;
		}
		const { parent, span } = spanContext;
		const flowName = getFlowName(RED, nodeDefinition.z);
		if (flowName) {
			span?.setAttribute(ATTR_FLOW_NAME, flowName);
			}
			applyClientResponseAttributes(span, msg);
			const hasError = applyErrorToSpan(span, parent, error, msg);
			applyLocalEndAttributes(span, msg, nodeDefinition);
			applyHttpResponseCompletion(
				msgId,
				parent,
				span,
				msg,
				nodeDefinition,
				hasError,
			);
		span?.end();
		const currentSpanCreationTimestamp = (span as Span & OTelSpanExtension)
			?._creationTimestamp;
		pluginLog(
			"debug",
			`==> Ended span for ${nodeDefinition.id} ${nodeDefinition.type}`,
		);
		parent.spans.delete(msgSpanId);
		parent.updateTimestamp = Date.now();
		cleanupOrphanSpansIfNeeded(msgId, parent, currentSpanCreationTimestamp);
	} catch (error) {
		pluginLog("error", "An error occurred during span ending", error);
	}
}

function applyResolvedRuntimeConfig(resolvedConfig: ResolvedOTELConfig): void {
	sharedState.logLevel = resolvedConfig.logLevel;
	sharedState.rootPrefix = resolvedConfig.rootPrefix;
	sharedState.timeout = normalizeTimeoutMs(resolvedConfig.timeout);
	sharedState.attributeMappings = sanitizeAttributeMappings(
		resolvedConfig.attributeMappings,
	);
	sharedState.ignoredNodeTypesList = splitCsv(resolvedConfig.ignoredNodeTypes);
	sharedState.propagateHeaderNodeTypesList = splitCsv(
		resolvedConfig.propagateHeaderNodeTypes,
	);
	sharedState.flowEventLogsEnabled = resolvedConfig.flowEventLogsEnabled;
}

function createCommonResource(serviceName: string): Resource {
	return resourceFromAttributes({
		[ATTR_SERVICE_NAME]: serviceName,
		[ATTR_HOST_NAME]: os.hostname(),
	});
}

function isAlreadyRegisteredError(error: unknown): boolean {
	const message =
		error instanceof Error ? error.message : error ? String(error) : "";
	return /already\s+registered/i.test(message);
}

function initializeTracerProvider(
	commonResource: Resource,
	tracesEnabled: boolean,
	tracesProtocol: "grpc" | "proto" | "http",
	url: string | undefined,
): void {
	if (sharedState.provider || !tracesEnabled || !url) {
		return;
	}
	let spanProcessor: BatchSpanProcessor;
	if (tracesProtocol === "grpc") {
		const {
			OTLPTraceExporter,
		} = require("@opentelemetry/exporter-trace-otlp-grpc");
		spanProcessor = new BatchSpanProcessor(new OTLPTraceExporter({ url }));
	} else if (tracesProtocol === "proto") {
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
	let tracerRegistered = true;
	try {
		tracerRegistered = trace.setGlobalTracerProvider(provider);
	} catch (error) {
		if (!isAlreadyRegisteredError(error)) {
			throw error;
		}
		tracerRegistered = false;
	}
	if (!tracerRegistered) {
		pluginLog(
			"warn",
			"OpenTelemetry tracer provider is already configured globally; using local tracer provider for this node.",
		);
	}
	sharedState.provider = provider;
	sharedState.tracer = provider.getTracer(name, version);
}

function initializeMeterProvider(
	commonResource: Resource,
	metricsEnabled: boolean,
	metricsProtocol: "grpc" | "proto" | "http",
	metricsUrl: string | undefined,
): void {
	if (sharedState.meterProvider || !metricsEnabled || !metricsUrl) {
		return;
	}
	const metricExporter =
		metricsProtocol === "grpc"
			? (() => {
					const {
						OTLPMetricExporter,
					} = require("@opentelemetry/exporter-metrics-otlp-grpc");
					return new OTLPMetricExporter({ url: metricsUrl });
				})()
			: metricsProtocol === "proto"
			? (() => {
					const {
						OTLPMetricExporter,
					} = require("@opentelemetry/exporter-metrics-otlp-proto");
					return new OTLPMetricExporter({ url: metricsUrl });
				})()
			: (() => {
					const {
						OTLPMetricExporter,
					} = require("@opentelemetry/exporter-metrics-otlp-http");
					return new OTLPMetricExporter({ url: metricsUrl });
				})();
	const metricReader = new PeriodicExportingMetricReader({
		exporter: metricExporter,
		exportIntervalMillis: 60000,
	});
	const meterProvider = new MeterProvider({
		resource: commonResource,
		readers: [metricReader],
	});
	let meterRegistered = true;
	try {
		meterRegistered = metrics.setGlobalMeterProvider(meterProvider);
	} catch (error) {
		if (!isAlreadyRegisteredError(error)) {
			throw error;
		}
		meterRegistered = false;
	}
	if (!meterRegistered) {
		pluginLog(
			"warn",
			"OpenTelemetry meter provider is already configured globally; using local meter provider for this node.",
		);
	}
	sharedState.meterProvider = meterProvider;
	const meter = meterProvider.getMeter(name, version);
	sharedState.metrics.requestDuration = meter.createHistogram(
		"http.server.duration",
		{
			description: "Duration of HTTP server requests in milliseconds",
			unit: "ms",
		},
	);
}

function initializeLoggerProvider(
	commonResource: Resource,
	logsEnabled: boolean,
	logsProtocol: "grpc" | "proto" | "http",
	logsUrl: string | undefined,
): void {
	if (sharedState.loggerProvider || !logsEnabled || !logsUrl) {
		return;
	}
	const logExporter =
		logsProtocol === "grpc"
			? (() => {
					const {
						OTLPLogExporter,
					} = require("@opentelemetry/exporter-logs-otlp-grpc");
					return new OTLPLogExporter({ url: logsUrl });
				})()
			: logsProtocol === "proto"
			? (() => {
					const {
						OTLPLogExporter,
					} = require("@opentelemetry/exporter-logs-otlp-proto");
					return new OTLPLogExporter({ url: logsUrl });
				})()
			: (() => {
					const {
						OTLPLogExporter,
					} = require("@opentelemetry/exporter-logs-otlp-http");
					return new OTLPLogExporter({ url: logsUrl });
				})();
	const loggerProvider = new LoggerProvider({
		resource: commonResource,
		processors: [new BatchLogRecordProcessor(logExporter)],
	});
	let selectedLoggerProvider: unknown;
	try {
		selectedLoggerProvider = logs.setGlobalLoggerProvider(loggerProvider);
	} catch (error) {
		if (!isAlreadyRegisteredError(error)) {
			throw error;
		}
		selectedLoggerProvider = logs.getLoggerProvider();
	}
	if (selectedLoggerProvider !== loggerProvider) {
		pluginLog(
			"warn",
			"OpenTelemetry logger provider is already configured globally; using local logger provider for this node.",
		);
	}
	sharedState.loggerProvider = loggerProvider;
	sharedState.logger = loggerProvider.getLogger(name, version);
}

function registerRuntimeHooks(RED: RuntimeApi): void {
	if (
		!RED.hooks ||
		typeof RED.hooks.add !== "function" ||
		typeof RED.hooks.remove !== "function"
	) {
		pluginLog(
			"warn",
			"Node-RED hooks API is unavailable; runtime hooks were not registered.",
		);
		return;
	}
	RED.hooks.add("onSend.otel", (events: RuntimeHookEvent[]) => {
		if (events.length === 0) {
			return;
		}
		events.forEach((event) => {
			if (event.source?.node) {
				captureHttpStartTimeIfNeeded(event.msg, event.source.node);
			}
			logEvent(RED, null, "1.onSend", event);
			if (sharedState.tracer) {
				createSpan(
					RED,
					sharedState.tracer,
					event.msg,
					event.source?.node as RuntimeNodeDef,
					null,
					sharedState.ignoredNodeTypesList.includes(
						event.source?.node.type ?? "",
					),
				);
			}
		});
	});

	RED.hooks.add("preDeliver.otel", (sendEvent: RuntimeHookEvent) => {
		if (
			sendEvent.source?.node &&
			sharedState.propagateHeaderNodeTypesList.includes(
				sendEvent.source.node.type,
			)
		) {
			if (!sendEvent.msg.headers) {
				sendEvent.msg.headers = {};
			}
			const headers = sendEvent.msg.headers;
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
			sharedState.ignoredNodeTypesList.includes(
				sendEvent.destination.node.type,
			),
		);
		if (
			span &&
			sendEvent.destination.node &&
			sharedState.propagateHeaderNodeTypesList.includes(
				sendEvent.destination.node.type,
			)
		) {
			const output: Record<string, string> = {};
			const ctx = trace.setSpan(context.active(), span as Span);
			propagator.inject(ctx, output, defaultTextMapSetter);
			switch (sendEvent.destination.node.type) {
				case "mqtt out":
					if (!sendEvent.msg.userProperties) {
						sendEvent.msg.userProperties = {};
					}
					Object.assign(sendEvent.msg.userProperties, output);
					break;
				default:
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
			const msgId = getMsgId(sendEvent.msg);
			const spanId = getSpanId(sendEvent.msg, sendEvent.source.node);
			const parent = msgSpans.get(msgId);
			if (parent?.spans.has(spanId)) {
				pluginLog("debug", `Switch or subflow span ${spanId} will be ended`);
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

	sharedState.hooksRegistered = true;
	pluginLog("info", "OpenTelemetry startup: runtime hooks registered");
	sharedState.intervalId = setInterval(deleteOutdatedMsgSpans, 5000);
}

async function shutdownSignalProviders(): Promise<void> {
	unregisterNodeRedLogHandler();
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
	sharedState.tracer = null;
	sharedState.logger = null;
	sharedState.metrics.requestDuration = null;
}

/**
 * @param {RuntimeApi} RED Node-RED runtime object
 */
module.exports = (RED: RuntimeApi) => {
	let runtimePluginInitialized = false;

	function registerRuntimePluginOnce(
		id: string,
		plugin: RuntimePluginRegistration,
	): void {
		try {
			RED.plugins?.registerPlugin?.(id, plugin);
		} catch (error) {
			if (!isAlreadyRegisteredError(error)) {
				pluginLog(
					"error",
					"Failed to register Node-RED runtime plugin 'opentelemetry-runtime'.",
					error,
				);
				throw error;
			}
			pluginLog(
				"debug",
				"Node-RED runtime plugin already registered; skipping duplicate registration.",
			);
		}
	}
	/**
	 * Initialize the OpenTelemetry system from runtime plugin settings.
	 * @param {OTELConfig} config Optional configuration to override defaults
	 */
	async function initOTEL(
		config: OTELConfig = {},
		nodeRedSettings?: unknown,
	): Promise<void> {
		// get config
		const resolvedConfig = resolveOpenTelemetryConfig(config, nodeRedSettings);
		const {
			url,
			metricsUrl,
			logsUrl,
			tracesProtocol,
			metricsProtocol,
			logsProtocol,
			serviceName,
			tracesEnabled,
			metricsEnabled,
			logsEnabled,
		} = resolvedConfig;
		applyResolvedRuntimeConfig(resolvedConfig);
		pluginLog(
			"warn",
			`OpenTelemetry startup config: ${formatStartupConfigSummary(resolvedConfig)}`,
		);
		pluginLog(
			"debug",
			`OpenTelemetry startup endpoints: traces(${tracesProtocol})=${url ? maskUrlCredentials(url) : "disabled"}, metrics(${metricsProtocol})=${metricsUrl ? maskUrlCredentials(metricsUrl) : "disabled"}, logs(${logsProtocol})=${logsUrl ? maskUrlCredentials(logsUrl) : "disabled"}`,
		);
		if (
			sharedState.provider ||
			sharedState.meterProvider ||
			sharedState.loggerProvider
		) {
			pluginLog("debug", "OpenTelemetry startup: replacing existing providers");
			await shutdownSignalProviders();
		}
		const commonResource = createCommonResource(serviceName);
		initializeTracerProvider(
			commonResource,
			tracesEnabled,
			tracesProtocol,
			url,
		);
		initializeMeterProvider(
			commonResource,
			metricsEnabled,
			metricsProtocol,
			metricsUrl,
		);
	initializeLoggerProvider(commonResource, logsEnabled, logsProtocol, logsUrl);
	if (sharedState.logger) {
		registerNodeRedLogHandler();
	} else {
		unregisterNodeRedLogHandler();
	}
	if (!sharedState.hooksRegistered) {
		registerRuntimeHooks(RED);
	}

	}

	async function stopOTEL(): Promise<void> {
		if (sharedState.intervalId) {
			clearInterval(sharedState.intervalId);
			sharedState.intervalId = null;
		}
		if (sharedState.hooksRegistered) {
			if (RED.hooks && typeof RED.hooks.remove === "function") {
				OTEL_HOOK_NAMES.forEach((hookName) => {
					RED.hooks.remove(hookName);
				});
			}
			sharedState.hooksRegistered = false;
		}
		msgSpans.clear();
		completedHttpMetricsMsgIds.clear();
		completedHttpResponseMsgIds.clear();
		await shutdownSignalProviders();
	}

	// Support Node-RED 4+ Runtime Plugin.
	if (
		RED.plugins &&
		typeof RED.plugins.registerPlugin === "function"
	) {
		const applyRuntimeSettings = async (settings: unknown): Promise<void> => {
			try {
				let pluginConfig: OTELConfig = {};
				if (typeof settings === "object" && settings !== null) {
					pluginConfig = settings as OTELConfig;
				}
				await initOTEL(pluginConfig, RED.settings);
				runtimePluginInitialized = true;
			} catch (error) {
				pluginLog("error", "OpenTelemetry runtime plugin settings failed.", error);
			}
		};

		const shutdownRuntimePlugin = async (): Promise<void> => {
			try {
				if (!runtimePluginInitialized) {
					return;
				}
				await stopOTEL();
				runtimePluginInitialized = false;
			} catch (error) {
				pluginLog("error", "OpenTelemetry runtime plugin shutdown failed.", error);
			}
		};

		const runtimePlugin = {
			type: "opentelemetry-runtime",
			onadd: async () => {
				await applyRuntimeSettings(
					(RED.settings as { opentelemetry?: OTELConfig } | undefined)
						?.opentelemetry ?? {},
				);
			},
			onremove: async () => {
				await shutdownRuntimePlugin();
			},
		};
		registerRuntimePluginOnce("opentelemetry-runtime", runtimePlugin);
	} else {
		pluginLog(
			"warn",
			"Node-RED runtime plugin API is unavailable; OpenTelemetry runtime plugin was not registered.",
		);
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
	setLogLevel: (value: string) => {
		sharedState.logLevel = resolveLogLevel(value) || DEFAULT_LOG_LEVEL;
	},
	resolveOpenTelemetryConfig,
	maskUrlCredentials,
	formatStartupConfigSummary,
	logEvent,
	pluginLog,
	getMsgSpans: () => msgSpans,
	clearInterval: () => {
		if (sharedState.intervalId) {
			clearInterval(sharedState.intervalId);
			sharedState.intervalId = null;
		}
	},
	resetState: () => {
		msgSpans.clear();
		completedHttpMetricsMsgIds.clear();
		completedHttpResponseMsgIds.clear();
		unregisterNodeRedLogHandler();
		sharedState.nodeRedLogApi = null;
		sharedState.logLevel = DEFAULT_LOG_LEVEL;
		sharedState.flowEventLogsEnabled = true;
		sharedState.rootPrefix = "";
		sharedState.timeout = 10;
		sharedState.attributeMappings = [];
		sharedState.hooksRegistered = false;
		if (sharedState.intervalId) {
			clearInterval(sharedState.intervalId);
			sharedState.intervalId = null;
		}
		if (sharedState.provider) {
			sharedState.provider.shutdown();
			sharedState.provider = null;
		}
		if (sharedState.meterProvider) {
			sharedState.meterProvider.shutdown();
			sharedState.meterProvider = null;
		}
		if (sharedState.loggerProvider) {
			sharedState.loggerProvider.shutdown();
			sharedState.loggerProvider = null;
		}
		sharedState.tracer = null;
		sharedState.logger = null;
		sharedState.metrics.requestDuration = null;
	},
	getSharedState: () => sharedState,
};

