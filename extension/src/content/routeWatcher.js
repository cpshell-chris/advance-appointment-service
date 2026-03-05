(function () {
  "use strict";

  // Payment route: /admin/shop/{shopId}/repair-orders/{roId}/payment
  const PAYMENT_REGEX =
    /^\/admin\/shop\/[^/]+\/repair-orders\/(\d+)\/payment(?:\/|$)/;

  let lastHref = location.href;
  let lastOpenedRoId = null;
  let lastWasPayment = false;

  function getPaymentRoId() {
    const m = location.pathname.match(PAYMENT_REGEX);
    return m ? m[1] : null;
  }

  function isPaymentRoute() {
    return PAYMENT_REGEX.test(location.pathname);
  }

  function openPanelIfNeeded() {
    const onPayment = isPaymentRoute();
    const roId = getPaymentRoId();

    // Track transitions
    const justEnteredPayment = onPayment && !lastWasPayment;
    const roChanged = onPayment && roId && roId !== lastOpenedRoId;

    lastWasPayment = onPayment;

    // Only auto-open on payment.
    // - If panel isn't open yet → open
    // - If RO changed while still on payment → re-open to refresh context
    if (!onPayment) return;

    // Wait until panel.js has loaded and defined window.AA
    if (!window.AA || typeof window.AA.showPanel !== "function") return;

    const isMounted = typeof window.AA.isPanelMounted === "function" && window.AA.isPanelMounted();

    if (!isMounted && (justEnteredPayment || roChanged)) {
      lastOpenedRoId = roId || null;
      window.AA.showPanel();
      return;
    }

    // If mounted but RO changed, hard-refresh the panel so it reloads RO data
    if (isMounted && roChanged) {
      lastOpenedRoId = roId || null;
      if (typeof window.AA.hidePanel === "function") window.AA.hidePanel();
      setTimeout(() => window.AA.showPanel && window.AA.showPanel(), 50);
    }
  }

  function handleMaybeChanged() {
    if (location.href === lastHref) return;
    lastHref = location.href;

    // Tekmetric SPA sometimes needs a beat to update pathname
    setTimeout(openPanelIfNeeded, 150);
  }

  // Initial check (page load)
  openPanelIfNeeded();

  // Poll for SPA route changes
  setInterval(handleMaybeChanged, 200);
})();