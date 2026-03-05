(function () {
  "use strict";

  const app = document.getElementById("app");

  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === "class") n.className = v;
      else if (k === "style") n.setAttribute("style", v);
      else n[k] = v;
    });
    children.forEach((c) => n.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return n;
  }

  function send(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        resolve(resp);
      });
    });
  }

  async function getContext() {
    const { aaContext } = await chrome.storage.local.get(["aaContext"]);
    return aaContext || null;
  }

  async function cloudRunFetch(path) {
    const base = "https://advance-appointment-service-361478515851.us-east4.run.app";
    const url = `${base}${path.startsWith("/") ? "" : "/"}${path}`;

    const resp = await send({
      __aa: true,
      type: "CLOUDRUN_FETCH",
      payload: { url, method: "GET" }
    });

    if (!resp?.ok) throw new Error(resp?.error || "Fetch failed");
    return resp.data;
  }

  async function render() {
    app.innerHTML = "";
    app.appendChild(el("div", { style: "padding:14px;font-weight:700;font-size:14px;" }, ["Advance Appointment Scheduler"]));

    const ctx = await getContext();
    if (!ctx?.roId) {
      app.appendChild(el("div", { style: "padding:14px;color:#6b7280;font-size:13px;" }, [
        "Open a Tekmetric Repair Order and go to the payment screen to auto-load context."
      ]));
      return;
    }

    app.appendChild(el("div", { style: "padding:0 14px 10px;color:#6b7280;font-size:12px;" }, [
      `Context: RO #${ctx.roId} (${ctx.origin || "tekmetric"})`
    ]));

    app.appendChild(el("div", { style: "padding:14px;color:#6b7280;font-size:12px;" }, ["Loading RO…"]));

    try {
      const ro = await cloudRunFetch(`/ro/${encodeURIComponent(ctx.roId)}`);

      app.innerHTML = "";
      app.appendChild(el("div", { style: "padding:14px;font-weight:700;font-size:14px;" }, ["Advance Appointment Scheduler"]));

      const customerName = ro?.customer ? `${ro.customer.firstName || ""} ${ro.customer.lastName || ""}`.trim() : "";
      const vehicle = ro?.vehicle ? `${ro.vehicle.year || ""} ${ro.vehicle.make || ""} ${ro.vehicle.model || ""}`.trim() : "";

      app.appendChild(el("div", { style: "padding:0 14px 12px;color:#111827;font-size:13px;font-weight:600;" }, [
        `RO #${ro.roNumber || ctx.roId} · ${customerName} · ${vehicle}`
      ]));

      app.appendChild(el("pre", { style: "margin:0 14px 14px;padding:12px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;overflow:auto;font-size:11px;color:#374151;" }, [
        JSON.stringify({ roId: ro.roId, shopId: ro.shopId, mileage: ro.mileage }, null, 2)
      ]));

      app.appendChild(el("div", { style: "padding:0 14px 14px;color:#6b7280;font-size:12px;" }, [
        "Next: we’ll port your 3-step wizard UI into this sidepanel using the same logic."
      ]));
    } catch (e) {
      app.appendChild(el("div", { style: "padding:14px;color:#b91c1c;font-size:12px;" }, [
        `Failed: ${e.message}`
      ]));
    }
  }

  // Re-render whenever context changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.aaContext) render();
  });

  render();
})();