(function () {
  "use strict";

  if (!window.AA) window.AA = {};

  const PANEL_WIDTH = 350;

  function getTekmetricRoot() {
    return document.getElementById("root");
  }

  function getTekmetricRightSidebar() {
    return document.querySelector(".MuiDrawer-paperAnchorRight");
  }

  function applyShift() {
    const root = getTekmetricRoot();
    const sidebar = getTekmetricRightSidebar();

    if (root) {
      root.style.transition = "margin-right 0.25s ease";
      root.style.marginRight = PANEL_WIDTH + "px";
    }

    if (sidebar) {
      sidebar.style.transition = "margin-right 0.25s ease";
      sidebar.style.marginRight = PANEL_WIDTH + "px";
    }
  }

  function resetShift() {
    const root = getTekmetricRoot();
    const sidebar = getTekmetricRightSidebar();

    if (root) root.style.marginRight = "0px";
    if (sidebar) sidebar.style.marginRight = "0px";
  }

  function initLayoutWatcher() {
    const observer = new MutationObserver(() => {
      if (window.AA.isPanelMounted && window.AA.isPanelMounted()) {
        applyShift();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  window.AA.applyShift = applyShift;
  window.AA.resetShift = resetShift;
  window.AA.initLayoutWatcher = initLayoutWatcher;
})();
