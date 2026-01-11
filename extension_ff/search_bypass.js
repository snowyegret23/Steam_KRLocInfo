(function () {
    // Use browser.storage in Firefox, fallback to chrome.storage
    const storage = (typeof browser !== 'undefined' && browser.storage) ? browser.storage : chrome.storage;

    // Firefox returns Promise, Chrome uses callbacks
    const storageGet = storage.local.get(['bypass_language_filter']);

    // Handle both Promise and callback styles
    if (storageGet && typeof storageGet.then === 'function') {
        // Promise-based (Firefox native)
        storageGet.then(settings => {
            processSettings(settings);
        });
    } else {
        // Callback-based (Chrome or wrapped)
        storage.local.get(['bypass_language_filter'], (settings) => {
            processSettings(settings);
        });
    }

    function processSettings(settings) {
        if (!settings.bypass_language_filter) return;

        const url = new URL(window.location.href);
        const path = url.pathname;

        if (path === '/search' || path.startsWith('/search/')) {
            if (!url.searchParams.has('ndl') || url.searchParams.get('ndl') !== '1') {
                url.searchParams.set('ndl', '1');
                window.location.replace(url.toString());
            }
            return;
        }

        if (path.startsWith('/category/') || path.startsWith('/genre/') || path.startsWith('/tags/')) {
            removeKoreanFilter();
        }
    }

    function removeKoreanFilter() {
        let attempts = 0;
        const maxAttempts = 50;

        const tryRemove = () => {
            const filterLinks = document.querySelectorAll('a._2XgkK2m_01lZYUuqv34NBt');

            for (const link of filterLinks) {
                const span = link.querySelector('span');
                if (span && (span.textContent === '한국어' || span.textContent === 'Korean')) {
                    link.click();
                    return;
                }
            }

            attempts++;
            if (attempts < maxAttempts) {
                setTimeout(tryRemove, 100);
            }
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', tryRemove);
        } else {
            tryRemove();
        }
    }
})();
