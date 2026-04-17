const handlers = new Set();

module.exports = {
	log: {
		FATAL: 10,
		ERROR: 20,
		WARN: 30,
		INFO: 40,
		DEBUG: 50,
		TRACE: 60,
		AUDIT: 98,
		METRIC: 99,
		addHandler: (handler) => {
			handlers.add(handler);
		},
		removeHandler: (handler) => {
			handlers.delete(handler);
		},
		log: () => {},
		emit: (entry) => {
			for (const handler of handlers) {
				if (handler && typeof handler.emit === "function") {
					handler.emit("log", entry);
				}
			}
		},
		handlerCount: () => handlers.size,
		reset: () => {
			handlers.clear();
		},
	},
};
