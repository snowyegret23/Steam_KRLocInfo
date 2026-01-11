// Enhanced shim: make common Chrome-style callback APIs return Promises in Firefox
(function () {
    if (typeof chrome === 'undefined') return;

    // Helper to wrap callback-style functions
    function wrapWithPromise(container, fnName, resultMapper) {
        try {
            const orig = container[fnName].bind(container);
            container[fnName] = function () {
                const lastArg = arguments[arguments.length - 1];
                if (typeof lastArg === 'function') {
                    return orig.apply(null, arguments);
                }
                return new Promise(resolve => {
                    const args = Array.from(arguments);
                    args.push(function (res) {
                        resolve(typeof resultMapper === 'function' ? resultMapper(res) : res);
                    });
                    orig.apply(null, args);
                });
            };
        } catch (e) { /* ignore if API not present */ }
    }

    // storage.local.get/set promise wrapper
    if (chrome.storage && chrome.storage.local) {
        wrapWithPromise(chrome.storage.local, 'get');
        wrapWithPromise(chrome.storage.local, 'set', () => undefined);
    }

    // runtime.sendMessage promise wrapper
    if (chrome.runtime && chrome.runtime.sendMessage) {
        wrapWithPromise(chrome.runtime, 'sendMessage');
    }

    // tabs API: create, query, update, remove, sendMessage
    if (chrome.tabs) {
        wrapWithPromise(chrome.tabs, 'create');
        wrapWithPromise(chrome.tabs, 'query');
        wrapWithPromise(chrome.tabs, 'update');
        wrapWithPromise(chrome.tabs, 'remove', () => undefined);
        // tabs.sendMessage signature is (tabId, message, options?, callback?)
        try {
            const origSend = chrome.tabs.sendMessage.bind(chrome.tabs);
            chrome.tabs.sendMessage = function (tabId, message /*, ...maybe options, callback */) {
                const args = Array.from(arguments);
                const last = args[args.length - 1];
                if (typeof last === 'function') return origSend.apply(null, args);
                return new Promise(resolve => {
                    args.push(function (res) { resolve(res); });
                    origSend.apply(null, args);
                });
            };
        } catch (e) { /* ignore */ }
    }

    // optional: wrap runtime.getBackgroundPage (MV2) if present
    if (chrome.runtime && chrome.runtime.getBackgroundPage) {
        wrapWithPromise(chrome.runtime, 'getBackgroundPage');
    }

    // Leave alarms, notifications, and other event-based APIs alone (they are event-driven)
})();

