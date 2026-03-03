(function () {
  "use strict";

  if (!window.AA) window.AA = {};

  const PAYMENT_REGEX =
    /^\/admin\/shop\/[^/]+\/repair-orders\/[^/]+\/payment(?:\/|$)/;

  let lastUrl = location.href;

  function isPaymentRoute() {
    return PAYMENT_REGEX.test(location.pathname);
  }

  function handleRouteChange() {
    // Only auto-open on payment page.
    // Never auto-close.
    if (isPaymentRoute()) {
      if (window.AA.showPanel) {
        window.AA.showPanel();
      }
    }
  }

  function initRouteWatcher() {
    handleRouteChange();

    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;

        setTimeout(() => {
          handleRouteChange();
        }, 150);
      }
    }, 150);
  }

  window.AA.initRouteWatcher = initRouteWatcher;
})();
