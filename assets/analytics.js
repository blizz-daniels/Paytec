const analyticsState = {
  me: null,
  paymentItems: [],
  charts: Object.create(null),
  defaultCurrency: "NGN",
};

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setStatus(message, isError = false) {
  const node = document.getElementById("analyticsStatus");
  if (!node) {
    return;
  }
  node.textContent = String(message || "");
  node.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function setButtonBusy(button, isBusy, busyLabel) {
  if (!button) {
    return;
  }
  if (!button.dataset.defaultLabel) {
    button.dataset.defaultLabel = button.textContent || "";
  }
  button.disabled = !!isBusy;
  button.textContent = isBusy ? busyLabel : button.dataset.defaultLabel;
}

function setLoadingState(isLoading) {
  const cards = document.querySelectorAll(".analytics-dynamic");
  cards.forEach((node) => {
    node.classList.toggle("analytics-dynamic--loading", !!isLoading);
  });
}

function formatMoney(value, currency = "NGN") {
  const amount = Number(value || 0);
  const safeCurrency = String(currency || "NGN").toUpperCase();
  if (!Number.isFinite(amount)) {
    return `${safeCurrency} 0.00`;
  }
  return `${safeCurrency} ${amount.toFixed(2)}`;
}

function formatCount(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) {
    return "0";
  }
  return String(Math.max(0, Math.round(parsed)));
}

function formatPercent(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) {
    return "0.00%";
  }
  return `${parsed.toFixed(2)}%`;
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (!node) {
    return;
  }
  node.textContent = String(value);
}

async function requestJson(url) {
  const response = await fetch(url, {
    credentials: "same-origin",
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch (_err) {
    payload = null;
  }
  if (!response.ok) {
    throw new Error((payload && payload.error) || "Request failed.");
  }
  return payload;
}

function getDefaultDateRange(days = 30) {
  const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;
  const toDate = new Date();
  toDate.setHours(0, 0, 0, 0);
  const fromDate = new Date(toDate.getTime() - (safeDays - 1) * 24 * 60 * 60 * 1000);
  return {
    from: fromDate.toISOString().slice(0, 10),
    to: toDate.toISOString().slice(0, 10),
  };
}

function buildQuery(params) {
  const search = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === null || value === undefined || value === "") {
      return;
    }
    search.set(key, String(value));
  });
  return search.toString();
}

function getFiltersFromForm() {
  const fromInput = document.getElementById("analyticsFrom");
  const toInput = document.getElementById("analyticsTo");
  const granularityInput = document.getElementById("analyticsGranularity");
  const paymentItemInput = document.getElementById("analyticsPaymentItem");
  const from = fromInput instanceof HTMLInputElement ? String(fromInput.value || "").trim() : "";
  const to = toInput instanceof HTMLInputElement ? String(toInput.value || "").trim() : "";
  const granularity = granularityInput instanceof HTMLSelectElement ? String(granularityInput.value || "day").trim() : "day";
  const paymentItemId =
    paymentItemInput instanceof HTMLSelectElement ? String(paymentItemInput.value || "").trim() : "";
  if (!from || !to) {
    throw new Error("Choose both from and to dates.");
  }
  if (from > to) {
    throw new Error("From date must be earlier than or equal to To date.");
  }
  return {
    from,
    to,
    granularity: granularity || "day",
    paymentItemId: paymentItemId || "",
  };
}

function renderFallbackTable(id, headers, rows, emptyMessage = "No data for selected range.") {
  const container = document.getElementById(id);
  if (!container) {
    return;
  }
  if (!rows.length) {
    container.innerHTML = `<p class="analytics-empty">${escapeHtml(emptyMessage)}</p>`;
    container.hidden = false;
    return;
  }
  const head = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`
    )
    .join("");
  container.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
  container.hidden = false;
}

function destroyChart(key) {
  const chart = analyticsState.charts[key];
  if (chart && typeof chart.destroy === "function") {
    chart.destroy();
  }
  analyticsState.charts[key] = null;
}

function renderChartOrFallback(config) {
  const {
    chartKey,
    canvasId,
    fallbackId,
    chartConfig,
    fallbackHeaders,
    fallbackRows,
    hasData,
    emptyMessage,
  } = config;
  const canvas = document.getElementById(canvasId);
  const fallback = document.getElementById(fallbackId);
  const canRenderChart = Boolean(window.Chart) && canvas instanceof HTMLCanvasElement && hasData;

  if (!canRenderChart) {
    destroyChart(chartKey);
    if (canvas) {
      canvas.hidden = true;
    }
    if (fallback) {
      renderFallbackTable(fallbackId, fallbackHeaders, fallbackRows, emptyMessage);
    }
    return;
  }

  if (canvas) {
    canvas.hidden = false;
  }
  if (fallback) {
    fallback.hidden = true;
    fallback.innerHTML = "";
  }
  destroyChart(chartKey);
  analyticsState.charts[chartKey] = new window.Chart(canvas.getContext("2d"), chartConfig);
}

function renderOverview(payload) {
  const kpis = payload && payload.kpis ? payload.kpis : {};
  setText("kpiTotalCollected", formatMoney(kpis.totalCollected, analyticsState.defaultCurrency));
  setText("kpiOutstandingAmount", formatMoney(kpis.outstandingAmount, analyticsState.defaultCurrency));
  setText("kpiCollectionRate", formatPercent(kpis.collectionRate));
  setText("kpiOpenExceptions", formatCount(kpis.openExceptionsCount));
  setText("kpiAutoApprovalRate", formatPercent(kpis.autoApprovalRate));
  setText("kpiReceiptSuccessRate", formatPercent(kpis.approvedReceiptGenerationSuccessRate));
}

function renderRevenueChart(payload) {
  const series = payload && Array.isArray(payload.series) ? payload.series : [];
  const labels = series.map((row) => row.bucket || "");
  const values = series.map((row) => Number(row.collectedAmount || 0));
  const hasData = values.some((value) => value > 0);
  renderChartOrFallback({
    chartKey: "revenue",
    canvasId: "revenueChart",
    fallbackId: "revenueFallback",
    hasData,
    emptyMessage: "No revenue data for selected range.",
    fallbackHeaders: ["Bucket", "Collected", "Transactions"],
    fallbackRows: series.map((row) => [
      row.bucket || "",
      formatMoney(row.collectedAmount, analyticsState.defaultCurrency),
      formatCount(row.transactionCount),
    ]),
    chartConfig: {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Collected",
            data: values,
            borderColor: "#c99533",
            backgroundColor: "rgba(201, 149, 51, 0.2)",
            fill: true,
            tension: 0.25,
            pointRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
          },
        },
        plugins: {
          legend: {
            display: false,
          },
        },
      },
    },
  });
}

function renderStatusBreakdownChart(payload) {
  const breakdown = payload && Array.isArray(payload.breakdown) ? payload.breakdown : [];
  const labels = breakdown.map((row) => row.status || "unknown");
  const values = breakdown.map((row) => Number(row.count || 0));
  const hasData = values.some((value) => value > 0);
  renderChartOrFallback({
    chartKey: "statusBreakdown",
    canvasId: "statusBreakdownChart",
    fallbackId: "statusBreakdownFallback",
    hasData,
    emptyMessage: "No transaction status data for selected range.",
    fallbackHeaders: ["Status", "Count"],
    fallbackRows: breakdown.map((row) => [row.status || "unknown", formatCount(row.count)]),
    chartConfig: {
      type: "doughnut",
      data: {
        labels,
        datasets: [
          {
            data: values,
            backgroundColor: [
              "#3a7d44",
              "#d08b35",
              "#b94f47",
              "#875f9a",
              "#4f7fb9",
              "#9f6d52",
              "#5c8f78",
            ],
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
      },
    },
  });
}

function renderReconciliationFunnelChart(payload) {
  const stages = payload && Array.isArray(payload.stages) ? payload.stages : [];
  const labels = stages.map((row) => row.stage || "");
  const values = stages.map((row) => Number(row.count || 0));
  const hasData = values.some((value) => value > 0);
  renderChartOrFallback({
    chartKey: "reconciliationFunnel",
    canvasId: "reconciliationFunnelChart",
    fallbackId: "reconciliationFunnelFallback",
    hasData,
    emptyMessage: "No reconciliation funnel data for selected range.",
    fallbackHeaders: ["Stage", "Count"],
    fallbackRows: stages.map((row) => [row.stage || "", formatCount(row.count)]),
    chartConfig: {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Transactions",
            data: values,
            backgroundColor: "#6e501e",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              precision: 0,
            },
          },
        },
        plugins: {
          legend: {
            display: false,
          },
        },
      },
    },
  });
}

function renderTopItemsChart(payload) {
  const items = payload && Array.isArray(payload.items) ? payload.items : [];
  const labels = items.map((row) => row.title || `Item ${row.paymentItemId}`);
  const values = items.map((row) => Number(row.collectedTotal || 0));
  const hasData = values.some((value) => value > 0);
  renderChartOrFallback({
    chartKey: "topItems",
    canvasId: "topItemsChart",
    fallbackId: "topItemsFallback",
    hasData,
    emptyMessage: "No payment item collection data for selected range.",
    fallbackHeaders: ["Item", "Collected", "Outstanding", "Transactions"],
    fallbackRows: items.map((row) => [
      row.title || "",
      formatMoney(row.collectedTotal, row.currency || analyticsState.defaultCurrency),
      formatMoney(row.outstandingAmount, row.currency || analyticsState.defaultCurrency),
      formatCount(row.transactionCount),
    ]),
    chartConfig: {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Collected",
            data: values,
            backgroundColor: "#c99533",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: "y",
        scales: {
          x: {
            beginAtZero: true,
          },
        },
        plugins: {
          legend: {
            display: false,
          },
        },
      },
    },
  });
}

function renderAgingChart(payload) {
  const buckets = payload && Array.isArray(payload.buckets) ? payload.buckets : [];
  const labels = buckets.map((row) => row.label || row.bucket || "");
  const values = buckets.map((row) => Number(row.outstandingAmount || 0));
  const hasData = values.some((value) => value > 0);
  renderChartOrFallback({
    chartKey: "aging",
    canvasId: "agingChart",
    fallbackId: "agingFallback",
    hasData,
    emptyMessage: "No aging data for selected range.",
    fallbackHeaders: ["Bucket", "Outstanding", "Obligations"],
    fallbackRows: buckets.map((row) => [
      row.label || row.bucket || "",
      formatMoney(row.outstandingAmount, analyticsState.defaultCurrency),
      formatCount(row.obligationsCount),
    ]),
    chartConfig: {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Outstanding",
            data: values,
            backgroundColor: ["#3a7d44", "#d08b35", "#b94f47", "#6b3f36"],
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
          },
        },
        plugins: {
          legend: {
            display: false,
          },
        },
      },
    },
  });
}

function renderPaystackFunnelChart(payload) {
  const stages = payload && Array.isArray(payload.stages) ? payload.stages : [];
  const labels = stages.map((row) => row.stage || "");
  const values = stages.map((row) => Number(row.count || 0));
  const hasData = values.some((value) => value > 0);
  renderChartOrFallback({
    chartKey: "paystackFunnel",
    canvasId: "paystackFunnelChart",
    fallbackId: "paystackFunnelFallback",
    hasData,
    emptyMessage: "No Paystack session data for selected range.",
    fallbackHeaders: ["Stage", "Count"],
    fallbackRows: stages.map((row) => [row.stage || "", formatCount(row.count)]),
    chartConfig: {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Sessions",
            data: values,
            backgroundColor: "#4f7fb9",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              precision: 0,
            },
          },
        },
        plugins: {
          legend: {
            display: false,
          },
        },
      },
    },
  });
}

async function loadPaymentItems() {
  const select = document.getElementById("analyticsPaymentItem");
  if (!(select instanceof HTMLSelectElement)) {
    return;
  }
  const rows = await requestJson("/api/payment-items");
  const list = Array.isArray(rows) ? rows : [];
  const normalizedCurrent = String(analyticsState.me?.username || "").trim().toLowerCase();
  const isAdmin = String(analyticsState.me?.role || "").trim().toLowerCase() === "admin";
  const scoped = list.filter((item) => {
    if (isAdmin) {
      return true;
    }
    return String(item.created_by || "").trim().toLowerCase() === normalizedCurrent;
  });
  scoped.sort((left, right) => String(left.title || "").localeCompare(String(right.title || "")));
  analyticsState.paymentItems = scoped;
  if (scoped.length && scoped[0].currency) {
    analyticsState.defaultCurrency = String(scoped[0].currency || "NGN").toUpperCase();
  }
  const currentValue = String(select.value || "").trim();
  const options = ['<option value="">All payment items</option>']
    .concat(
      scoped.map((item) => {
        const id = Number(item.id || 0);
        const title = String(item.title || `Item ${id}`);
        const currency = String(item.currency || "NGN").toUpperCase();
        return `<option value="${id}">${escapeHtml(title)} (${escapeHtml(currency)})</option>`;
      })
    )
    .join("");
  select.innerHTML = options;
  if (currentValue && scoped.some((item) => String(item.id) === currentValue)) {
    select.value = currentValue;
  }
}

function ensureDefaultFilterValues() {
  const defaults = getDefaultDateRange();
  const fromInput = document.getElementById("analyticsFrom");
  const toInput = document.getElementById("analyticsTo");
  const granularityInput = document.getElementById("analyticsGranularity");
  if (fromInput instanceof HTMLInputElement && !fromInput.value) {
    fromInput.value = defaults.from;
  }
  if (toInput instanceof HTMLInputElement && !toInput.value) {
    toInput.value = defaults.to;
  }
  if (granularityInput instanceof HTMLSelectElement && !granularityInput.value) {
    granularityInput.value = "day";
  }
}

async function loadAnalytics() {
  const filters = getFiltersFromForm();
  const query = buildQuery({
    from: filters.from,
    to: filters.to,
    granularity: filters.granularity,
    paymentItemId: filters.paymentItemId,
  });
  setLoadingState(true);
  setStatus("Loading analytics data...");
  const [overview, revenue, statusBreakdown, reconciliationFunnel, topItems, aging, paystackFunnel] = await Promise.all([
    requestJson(`/api/analytics/overview?${query}`),
    requestJson(`/api/analytics/revenue-series?${query}`),
    requestJson(`/api/analytics/status-breakdown?${query}`),
    requestJson(`/api/analytics/reconciliation-funnel?${query}`),
    requestJson(`/api/analytics/top-items?${buildQuery({ ...filters, limit: 10, sort: "collected_desc" })}`),
    requestJson(`/api/analytics/aging?${query}`),
    requestJson(`/api/analytics/paystack-funnel?${query}`),
  ]);
  renderOverview(overview);
  renderRevenueChart(revenue);
  renderStatusBreakdownChart(statusBreakdown);
  renderReconciliationFunnelChart(reconciliationFunnel);
  renderTopItemsChart(topItems);
  renderAgingChart(aging);
  renderPaystackFunnelChart(paystackFunnel);
  setStatus(`Showing analytics from ${filters.from} to ${filters.to}.`);
  setLoadingState(false);
}

function bindEvents() {
  const filterForm = document.getElementById("analyticsFiltersForm");
  const refreshButton = document.getElementById("analyticsRefreshButton");
  const exportButton = document.getElementById("analyticsExportButton");

  if (filterForm) {
    filterForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      setButtonBusy(refreshButton, true, "Refreshing...");
      try {
        await loadAnalytics();
      } catch (err) {
        setStatus(err.message || "Could not load analytics data.", true);
        setLoadingState(false);
        if (window.showToast) {
          window.showToast(err.message || "Could not load analytics data.", { type: "error" });
        }
      } finally {
        setButtonBusy(refreshButton, false, "");
      }
    });
  }

  if (exportButton) {
    exportButton.addEventListener("click", () => {
      try {
        const filters = getFiltersFromForm();
        const query = buildQuery({
          from: filters.from,
          to: filters.to,
          granularity: filters.granularity,
          paymentItemId: filters.paymentItemId,
          limit: 10,
          sort: "collected_desc",
        });
        window.location.assign(`/api/analytics/export.csv?${query}`);
      } catch (err) {
        setStatus(err.message || "Could not export analytics CSV.", true);
      }
    });
  }
}

async function initAnalyticsPage() {
  if (document.body?.dataset?.page !== "analytics") {
    return;
  }
  try {
    analyticsState.me = await requestJson("/api/me");
    const role = String(analyticsState.me?.role || "").trim().toLowerCase();
    if (role !== "teacher" && role !== "admin") {
      throw new Error("Only lecturers/admins can view analytics.");
    }
    ensureDefaultFilterValues();
    bindEvents();
    await loadPaymentItems();
    await loadAnalytics();
  } catch (err) {
    setStatus(err.message || "Could not initialize analytics page.", true);
    setLoadingState(false);
    if (window.showToast) {
      window.showToast(err.message || "Could not initialize analytics page.", { type: "error" });
    }
  }
}

initAnalyticsPage();
