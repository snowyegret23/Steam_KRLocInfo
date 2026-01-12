/**
 * KOSTEAM Search Bypass Script
 * Automatically removes Korean language filter from Steam search/browse pages
 */

import { storageGet } from './shared/api.js';

(function () {
    /**
     * Initialize search bypass functionality
     */
    async function init() {
        try {
            const settings = await storageGet(['bypass_language_filter']);
            const isBypassEnabled = settings.bypass_language_filter !== false;

            if (!isBypassEnabled) return;

            const url = new URL(window.location.href);
            const path = url.pathname;

            // Handle /search pages - add ndl=1 parameter
            if (path === '/search' || path.startsWith('/search/')) {
                if (!url.searchParams.has('ndl') || url.searchParams.get('ndl') !== '1') {
                    url.searchParams.set('ndl', '1');
                    window.location.replace(url.toString());
                }
                return;
            }

            // Handle category/genre/tags pages - click to remove Korean filter
            if (path.startsWith('/category/') 
                || path.startsWith('/genre/') 
                || path.startsWith('/tags/') 
                || path.startsWith('/vr')
                || path.startsWith('/greatondeck')
                || path.startsWith('/specials')
                || path.startsWith('/sale')
            ) {
                if (document.visibilityState === 'visible') {
                    removeKoreanFilter();
                } 
                else {
                    document.addEventListener('visibilitychange', function onVisible() {
                        if (document.visibilityState === 'visible') {
                            removeKoreanFilter();
                            document.removeEventListener('visibilitychange', onVisible);
                        }
                    });
                }
            }
        } catch (err) {
            console.debug('[KOSTEAM] Search bypass error:', err);
        }
    }

    /**
     * Remove Korean language filter using MutationObserver
     * More efficient than polling with setTimeout
     */
    function removeKoreanFilter() {
        let found = false;
        const MAX_WAIT_MS = 10000;

        /**
         * Try to find and click the Korean filter link
         * @returns {boolean} True if filter was found and clicked
         */
        function tryRemoveFilter() {
            // Steam uses obfuscated class names, this may need updates
            const filterLinks = document.querySelectorAll('a._2XgkK2m_01lZYUuqv34NBt');

            for (const link of filterLinks) {
                const span = link.querySelector('span');
                if (span && (span.textContent === '한국어' || span.textContent === 'Korean')) {
                    link.click();
                    return true;
                }
            }
            return false;
        }

        // Try immediately first
        if (tryRemoveFilter()) return;

        // Use MutationObserver for efficiency
        const observer = new MutationObserver((mutations, obs) => {
            if (found) return;

            if (tryRemoveFilter()) {
                found = true;
                obs.disconnect();
            }
        });

        // Start observing when DOM is ready
        function startObserver() {
            if (document.body) {
                observer.observe(document.body, {
                    childList: true,
                    subtree: true
                });

                // Cleanup observer after timeout
                setTimeout(() => {
                    if (!found) {
                        observer.disconnect();
                    }
                }, MAX_WAIT_MS);
            }
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', startObserver);
        } else {
            startObserver();
        }
    }

    // Execute
    init();
})();
