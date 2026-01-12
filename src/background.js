/**
 * KOSTEAM Background Service Worker
 * Handles data fetching, caching, and message routing
 */

import {
    storageGet,
    storageSet,
    onMessage,
    onInstalled,
    onStartup,
    createAlarm,
    onAlarm
} from './shared/api.js';

import {
    VERSION_URL,
    DATA_URL,
    ALIAS_URL,
    CACHE_KEY,
    CACHE_ALIAS_KEY,
    CACHE_VERSION_KEY,
    UPDATE_INTERVAL_MINUTES,
    DEFAULT_SETTINGS,
    MSG_GET_PATCH_INFO,
    MSG_REFRESH_DATA,
    MSG_CHECK_UPDATE_STATUS
} from './shared/constants.js';

/**
 * Safely parse JSON response with error handling
 * @param {Response} response - Fetch response
 * @returns {Promise<Object|null>} Parsed JSON or null on error
 */
async function safeJsonParse(response) {
    try {
        return await response.json();
    } catch (err) {
        console.error('[KOSTEAM] JSON parse error:', err);
        return null;
    }
}

/**
 * Fetch remote version info
 * @returns {Promise<Object|null>} Version info or null on error
 */
async function getRemoteVersion() {
    try {
        const response = await fetch(VERSION_URL, { cache: 'no-store' });
        if (!response.ok) return null;
        return await safeJsonParse(response);
    } catch (err) {
        console.error('[KOSTEAM] Version fetch error:', err);
        return null;
    }
}

/**
 * Check for updates and fetch if new version available
 * @returns {Promise<Object|null>} Updated data or null
 */
async function checkForUpdates() {
    try {
        const response = await fetch(VERSION_URL, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const remoteVersion = await safeJsonParse(response);
        if (!remoteVersion) return null;

        const local = await storageGet([CACHE_VERSION_KEY]);
        const localVersion = local[CACHE_VERSION_KEY];

        const needsUpdate = !localVersion ||
            localVersion.generated_at !== remoteVersion.generated_at ||
            localVersion.alias_updated_at !== remoteVersion.alias_updated_at;

        if (needsUpdate) {
            console.log('[KOSTEAM] New version detected, updating...');
            return await fetchData(remoteVersion);
        }

        return null;
    } catch (err) {
        console.error('[KOSTEAM] Update check failed:', err);
        return null;
    }
}

/**
 * Fetch and cache lookup and alias data
 * @param {Object} versionInfo - Version metadata
 * @returns {Promise<Object|null>} Fetched data or null on error
 */
async function fetchData(versionInfo) {
    try {
        const [dataRes, aliasRes] = await Promise.all([
            fetch(DATA_URL, { cache: 'no-store' }),
            fetch(ALIAS_URL, { cache: 'no-store' }).catch(() => ({ ok: false }))
        ]);

        if (!dataRes.ok) throw new Error(`Data fetch failed: ${dataRes.status}`);

        const data = await safeJsonParse(dataRes);
        if (!data) throw new Error('Invalid data JSON');

        const alias = aliasRes.ok ? await safeJsonParse(aliasRes) || {} : {};
        const version = versionInfo || data._meta || { generated_at: new Date().toISOString() };

        await storageSet({
            [CACHE_KEY]: data,
            [CACHE_ALIAS_KEY]: alias,
            [CACHE_VERSION_KEY]: version
        });

        console.log(`[KOSTEAM] Updated: ${Object.keys(data).length} games`);
        return data;
    } catch (err) {
        console.error('[KOSTEAM] Data fetch failed:', err);
        return null;
    }
}

/**
 * Get cached data and alias mappings
 * @returns {Promise<{data: Object, alias: Object}>}
 */
async function getData() {
    const result = await storageGet([CACHE_KEY, CACHE_ALIAS_KEY]);
    return {
        data: result[CACHE_KEY] || {},
        alias: result[CACHE_ALIAS_KEY] || {}
    };
}

// Message handler
onMessage((message, sender, sendResponse) => {
    if (message.type === MSG_GET_PATCH_INFO) {
        getData().then(({ data, alias }) => {
            const appId = message.appId;
            const targetId = alias[appId] || appId;
            const info = data[targetId] || null;
            sendResponse({ success: true, info });
        }).catch(err => {
            console.error('[KOSTEAM] GET_PATCH_INFO error:', err);
            sendResponse({ success: false, error: err.message });
        });
        return true;
    }

    if (message.type === MSG_REFRESH_DATA) {
        (async () => {
            try {
                const remoteVersion = await getRemoteVersion();
                const data = await fetchData(remoteVersion);
                sendResponse({ success: !!data });
            } catch (err) {
                console.error('[KOSTEAM] REFRESH_DATA error:', err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    if (message.type === MSG_CHECK_UPDATE_STATUS) {
        (async () => {
            try {
                const local = await storageGet([CACHE_VERSION_KEY]);
                const remoteVersion = await getRemoteVersion();

                if (!remoteVersion) {
                    sendResponse({ success: false, error: 'Network error' });
                    return;
                }

                const localVersion = local[CACHE_VERSION_KEY];
                const needsUpdate = !localVersion ||
                    localVersion.generated_at !== remoteVersion.generated_at ||
                    localVersion.alias_updated_at !== remoteVersion.alias_updated_at;

                sendResponse({
                    success: true,
                    needsUpdate,
                    localVersion,
                    remoteVersion
                });
            } catch (err) {
                console.error('[KOSTEAM] CHECK_UPDATE_STATUS error:', err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    return false;
});

// Initialize settings on installation
onInstalled(async () => {
    try {
        const current = await storageGet(Object.keys(DEFAULT_SETTINGS));
        const toSet = {};

        for (const key in DEFAULT_SETTINGS) {
            if (current[key] === undefined) {
                toSet[key] = DEFAULT_SETTINGS[key];
            }
        }

        if (Object.keys(toSet).length > 0) {
            await storageSet(toSet);
        }

        checkForUpdates();
    } catch (err) {
        console.error('[KOSTEAM] Installation init error:', err);
    }
});

// Setup periodic update check
createAlarm('checkUpdates', { periodInMinutes: UPDATE_INTERVAL_MINUTES });

onAlarm(alarm => {
    if (alarm.name === 'checkUpdates') {
        checkForUpdates();
    }
});

// Check for updates on browser startup (Chrome only)
onStartup(checkForUpdates);
