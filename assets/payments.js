function setPaymentStatus(id, message, isError) {
  const node = document.getElementById(id);
  if (!node) {
    return;
  }
  node.textContent = message;
  node.style.color = isError ? "#a52828" : "#1f2333";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value || "-";
  }
  return date.toLocaleString();
}

function formatMoney(value, currency = "NGN") {
  const amount = Number(value || 0);
  const safeCurrency = String(currency || "NGN").toUpperCase();
  if (!Number.isFinite(amount)) {
    return `${safeCurrency} 0.00`;
  }
  return `${safeCurrency} ${amount.toFixed(2)}`;
}

function statusBadge(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "approved") {
    return '<span class="status-badge status-badge--success">approved</span>';
  }
  if (normalized === "rejected") {
    return '<span class="status-badge status-badge--error">rejected</span>';
  }
  if (normalized === "under_review") {
    return '<span class="status-badge status-badge--warning">under review</span>';
  }
  if (normalized === "needs_review") {
    return '<span class="status-badge status-badge--warning">needs review</span>';
  }
  if (normalized === "needs_student_confirmation") {
    return '<span class="status-badge status-badge--warning">needs student confirmation</span>';
  }
  if (normalized === "duplicate") {
    return '<span class="status-badge status-badge--error">duplicate</span>';
  }
  if (normalized === "unmatched") {
    return '<span class="status-badge status-badge--error">unmatched</span>';
  }
  return `<span class="status-badge">${escapeHtml(normalized || "unknown")}</span>`;
}

function reminderBadge(level, text) {
  const normalized = String(level || "").toLowerCase();
  if (normalized === "overdue") {
    return `<span class="status-badge status-badge--error">${escapeHtml(text)}</span>`;
  }
  if (normalized === "today" || normalized === "urgent") {
    return `<span class="status-badge status-badge--warning">${escapeHtml(text)}</span>`;
  }
  if (normalized === "settled") {
    return `<span class="status-badge status-badge--success">${escapeHtml(text)}</span>`;
  }
  return `<span class="status-badge">${escapeHtml(text || "No reminder")}</span>`;
}

function getSlaMeta(row) {
  const status = String(row?.status || "").toLowerCase();
  if (status !== "submitted" && status !== "under_review") {
    return null;
  }
  const submittedAt = new Date(row?.submitted_at || "");
  if (Number.isNaN(submittedAt.getTime())) {
    return null;
  }
  const targetHours = status === "submitted" ? 24 : 8;
  const elapsedHours = (Date.now() - submittedAt.getTime()) / (1000 * 60 * 60);
  const remaining = targetHours - elapsedHours;
  if (remaining >= 0) {
    return {
      className: "status-badge status-badge--success",
      text: `${Math.ceil(remaining)}h left`,
    };
  }
  return {
    className: "status-badge status-badge--error",
    text: `${Math.ceil(Math.abs(remaining))}h overdue`,
  };
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

async function requestJson(url, { method = "GET", payload } = {}) {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  let data = null;
  try {
    data = await response.json();
  } catch (_err) {
    data = null;
  }
  if (!response.ok) {
    throw new Error((data && data.error) || "Request failed.");
  }
  return data;
}

const paymentState = {
  me: null,
  paymentItems: [],
  myReceipts: [],
  ledger: null,
  queueRows: [],
  queuePagination: {
    page: 1,
    pageSize: 50,
    total: 0,
    totalPages: 1,
  },
  selectedQueueIds: new Set(),
  statementInfo: null,
  reconciliationSummary: null,
};

function parseVerificationNotes(row) {
  try {
    const raw = row && row.verification_notes ? JSON.parse(row.verification_notes) : null;
    return raw || {};
  } catch (_err) {
    return {};
  }
}

function parseFlags(row) {
  if (row && row.verification_flags && typeof row.verification_flags === "object") {
    return row.verification_flags;
  }
  const notes = parseVerificationNotes(row);
  if (notes && notes.verification_flags) {
    return notes.verification_flags;
  }
  return notes;
}

function renderPaymentItemSelects(items) {
  const selectIds = ["receiptPaymentItem", "queuePaymentItem"];
  selectIds.forEach((id) => {
    const select = document.getElementById(id);
    if (!select) {
      return;
    }
    const existingValue = select.value;
    const options = [`<option value="">${id === "receiptPaymentItem" ? "Select payment item" : "All"}</option>`]
      .concat(
        items.map(
          (item) =>
            `<option value="${item.id}">${escapeHtml(item.title)} - ${escapeHtml(item.currency)} ${escapeHtml(item.expected_amount)}${
              item.my_reference ? ` (Ref: ${escapeHtml(item.my_reference)})` : ""
            }</option>`
        )
      )
      .join("");
    select.innerHTML = options;
    if (existingValue && items.some((item) => String(item.id) === existingValue)) {
      select.value = existingValue;
    }
  });
}

function renderLedger(ledger) {
  const summary = ledger && ledger.summary ? ledger.summary : {};
  const nextDueItem = ledger && ledger.nextDueItem ? ledger.nextDueItem : null;
  const defaultCurrency = (nextDueItem && nextDueItem.currency) || "NGN";

  const mapping = [
    ["ledgerTotalDue", formatMoney(summary.totalDue, defaultCurrency)],
    ["ledgerApprovedPaid", formatMoney(summary.totalApprovedPaid, defaultCurrency)],
    ["ledgerPendingPaid", formatMoney(summary.totalPendingPaid, defaultCurrency)],
    ["ledgerOutstanding", formatMoney(summary.totalOutstanding, defaultCurrency)],
    ["ledgerOverdueCount", String(Number(summary.overdueCount || 0))],
    ["ledgerDueSoonCount", String(Number(summary.dueSoonCount || 0))],
  ];
  mapping.forEach(([id, text]) => {
    const node = document.getElementById(id);
    if (node) {
      node.textContent = text;
    }
  });

  const nextDueNode = document.getElementById("ledgerNextDue");
  if (nextDueNode) {
    if (!nextDueItem) {
      nextDueNode.textContent = "No upcoming due item.";
    } else {
      nextDueNode.textContent = `${nextDueItem.title} (${formatMoney(nextDueItem.outstanding, nextDueItem.currency)}) - ${nextDueItem.reminder_text}`;
    }
  }
}

function renderReminderCalendar(ledger) {
  const tbody = document.getElementById("paymentReminderRows");
  if (!tbody) {
    return;
  }
  const items = ledger && Array.isArray(ledger.items) ? ledger.items : [];
  tbody.innerHTML = "";
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:#636b8a;">No payment items available.</td></tr>';
    return;
  }

  items.forEach((item) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(item.title || "-")}</td>
      <td>${escapeHtml(item.due_date || "No due date")}</td>
      <td>${reminderBadge(item.reminder_level, item.reminder_text)}</td>
      <td>${escapeHtml(formatMoney(item.outstanding, item.currency))}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderPaymentTimeline(ledger) {
  const tbody = document.getElementById("paymentTimelineRows");
  if (!tbody) {
    return;
  }
  const rows = ledger && Array.isArray(ledger.timeline) ? ledger.timeline : [];
  tbody.innerHTML = "";
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:#636b8a;">No reconciliation updates yet.</td></tr>';
    return;
  }
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(formatDate(row.created_at || ""))}</td>
      <td>${escapeHtml(row.payment_item_title || "-")}</td>
      <td>${escapeHtml(String(row.action || "").replaceAll("_", " ") || "-")}</td>
      <td>${escapeHtml(row.note || "-")}</td>
    `;
    tbody.appendChild(tr);
  });
}
function renderMyReceipts(rows) {
  const tbody = document.getElementById("myReceiptRows");
  if (!tbody) {
    return;
  }
  tbody.innerHTML = "";
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:#636b8a;">No receipts submitted yet.</td></tr>';
    return;
  }
  rows.forEach((row) => {
    const flags = parseFlags(row);
    const reviewNotes = row.rejection_reason || flags.reviewer_note || "-";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(row.payment_item_title || "-")}</td>
      <td>${escapeHtml(formatMoney(row.amount_paid, row.currency))}</td>
      <td>${escapeHtml(row.transaction_ref || "-")}</td>
      <td>${statusBadge(row.status)}</td>
      <td>${escapeHtml(formatDate(row.submitted_at))}</td>
      <td>${escapeHtml(reviewNotes)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderPaymentItemsTable(items) {
  const tbody = document.getElementById("paymentItemRows");
  if (!tbody || !paymentState.me) {
    return;
  }
  tbody.innerHTML = "";
  const manageable = items.filter((item) => paymentState.me.role === "admin" || item.created_by === paymentState.me.username);
  if (!manageable.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:#636b8a;">No payment items yet.</td></tr>';
    return;
  }
  manageable.forEach((item) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(item.title)}</td>
      <td>${escapeHtml(formatMoney(item.expected_amount, item.currency))}</td>
      <td>${escapeHtml(item.due_date || "-")}</td>
      <td>${escapeHtml(item.created_by)}</td>
      <td>
        <button class="btn btn-secondary" type="button" data-action="edit-item" data-id="${item.id}">Edit</button>
        <button class="btn" type="button" data-action="delete-item" data-id="${item.id}" style="background:#b42318;">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function renderQueue(rows) {
  const tbody = document.getElementById("receiptQueueRows");
  const selectAllNode = document.getElementById("queueSelectAll");
  if (!tbody) {
    return;
  }
  tbody.innerHTML = "";
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="color:#636b8a;">No reconciliation exceptions match the current filters.</td></tr>';
    if (selectAllNode) {
      selectAllNode.checked = false;
    }
    return;
  }
  rows.forEach((row) => {
    const reasons = Array.isArray(row.reasons) ? row.reasons : [];
    const reasonHtml = reasons.length
      ? reasons.map((reason) => `<span class="status-badge">${escapeHtml(reason.replaceAll("_", " "))}</span>`).join(" ")
      : '<span class="status-badge">none</span>';
    const actions = [];
    if (row.status !== "approved" && row.status !== "rejected") {
      actions.push(`<button class="btn" type="button" data-action="approve" data-id="${row.id}">Approve</button>`);
      actions.push(
        `<button class="btn" type="button" data-action="reject" data-id="${row.id}" style="background:#b42318;">Reject</button>`
      );
      actions.push(
        `<button class="btn btn-secondary" type="button" data-action="request-student-confirmation" data-id="${row.id}">Request Student</button>`
      );
      actions.push(
        `<button class="btn btn-secondary" type="button" data-action="merge-duplicates" data-id="${row.id}">Merge Duplicate</button>`
      );
    }

    const checkedAttr = paymentState.selectedQueueIds.has(row.id) ? "checked" : "";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" class="queue-select-row" data-id="${row.id}" ${checkedAttr} /></td>
      <td>${escapeHtml(String(row.id || "-"))}</td>
      <td>${escapeHtml(row.student_username || "-")}</td>
      <td>${escapeHtml(row.payment_item_title || "-")}</td>
      <td>${escapeHtml(formatMoney(row.amount, row.currency))}</td>
      <td>${escapeHtml(row.txn_ref || "-")}</td>
      <td>${escapeHtml(row.source || "-")}</td>
      <td>${statusBadge(row.status)}</td>
      <td>${reasonHtml}</td>
      <td>${actions.join(" ")}</td>
    `;
    tbody.appendChild(tr);
  });

  if (selectAllNode) {
    const selectableRows = rows.length;
    const selectedCount = rows.filter((row) => paymentState.selectedQueueIds.has(row.id)).length;
    selectAllNode.checked = selectableRows > 0 && selectedCount === selectableRows;
  }
}

function renderQueuePagination() {
  const infoNode = document.getElementById("queuePageInfo");
  const prevButton = document.getElementById("queuePrevPage");
  const nextButton = document.getElementById("queueNextPage");
  const pagination = paymentState.queuePagination || { page: 1, totalPages: 1, total: 0 };
  if (infoNode) {
    infoNode.textContent = `Page ${pagination.page} of ${pagination.totalPages} (${pagination.total} total)`;
  }
  if (prevButton) {
    prevButton.disabled = pagination.page <= 1;
  }
  if (nextButton) {
    nextButton.disabled = pagination.page >= pagination.totalPages;
  }
}

async function loadPaymentItems() {
  paymentState.paymentItems = await requestJson("/api/payment-items");
  renderPaymentItemSelects(paymentState.paymentItems);
  renderPaymentItemsTable(paymentState.paymentItems);
}

async function loadStudentReceipts() {
  paymentState.myReceipts = await requestJson("/api/my/payment-receipts");
  renderMyReceipts(paymentState.myReceipts);
}

async function loadStudentLedger() {
  paymentState.ledger = await requestJson("/api/my/payment-ledger");
  renderLedger(paymentState.ledger);
  renderReminderCalendar(paymentState.ledger);
  renderPaymentTimeline(paymentState.ledger);
}

async function loadQueue() {
  const endpoint =
    paymentState.me.role === "admin"
      ? "/api/admin/reconciliation/exceptions"
      : "/api/teacher/reconciliation/exceptions";
  const params = new URLSearchParams();
  const status = document.getElementById("queueStatus")?.value || "all";
  const reason = document.getElementById("queueReason")?.value || "all";
  const student = document.getElementById("queueStudent")?.value || "";
  const dateFrom = document.getElementById("queueDateFrom")?.value || "";
  const dateTo = document.getElementById("queueDateTo")?.value || "";
  const paymentItemId = document.getElementById("queuePaymentItem")?.value || "";
  if (status) params.set("status", status);
  if (reason) params.set("reason", reason);
  if (student) params.set("student", student);
  if (dateFrom) params.set("dateFrom", dateFrom);
  if (dateTo) params.set("dateTo", dateTo);
  if (paymentItemId) params.set("paymentItemId", paymentItemId);
  params.set("page", String(paymentState.queuePagination.page || 1));
  params.set("pageSize", String(paymentState.queuePagination.pageSize || 50));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const payload = await requestJson(`${endpoint}${suffix}`);
  if (Array.isArray(payload)) {
    paymentState.queueRows = payload;
    paymentState.queuePagination = {
      page: 1,
      pageSize: payload.length || 50,
      total: payload.length,
      totalPages: 1,
    };
  } else {
    paymentState.queueRows = Array.isArray(payload.items) ? payload.items : [];
    paymentState.queuePagination = {
      page: Number(payload?.pagination?.page || 1),
      pageSize: Number(payload?.pagination?.pageSize || 50),
      total: Number(payload?.pagination?.total || paymentState.queueRows.length || 0),
      totalPages: Number(payload?.pagination?.totalPages || 1),
    };
  }
  const validIds = new Set(paymentState.queueRows.map((row) => row.id));
  paymentState.selectedQueueIds = new Set([...paymentState.selectedQueueIds].filter((id) => validIds.has(id)));
  renderQueue(paymentState.queueRows);
  renderQueuePagination();
}

function renderReconciliationSummary() {
  const summary = paymentState.reconciliationSummary || {};
  const mapping = [
    ["reconAutoApproved", String(Number(summary.auto_approved || 0))],
    ["reconExceptions", String(Number(summary.exceptions || 0))],
    ["reconUnresolved", String(Number(summary.unresolved_obligations || 0))],
    ["reconDuplicates", String(Number(summary.duplicates || 0))],
  ];
  mapping.forEach(([id, value]) => {
    const node = document.getElementById(id);
    if (node) {
      node.textContent = value;
    }
  });
}

async function loadReconciliationSummary() {
  const endpoint =
    paymentState.me.role === "admin"
      ? "/api/admin/reconciliation/summary"
      : "/api/teacher/reconciliation/summary";
  paymentState.reconciliationSummary = await requestJson(endpoint);
  renderReconciliationSummary();
}

function renderStatementStatus() {
  const statusNode = document.getElementById("statementStatus");
  const deleteButton = document.getElementById("deleteStatementButton");
  if (!statusNode) {
    return;
  }
  if (!paymentState.statementInfo || !paymentState.statementInfo.hasStatement) {
    statusNode.textContent = "No statement uploaded yet.";
    statusNode.style.color = "#1f2333";
    if (deleteButton) {
      deleteButton.disabled = true;
    }
    return;
  }
  const unparsedCount = Number(paymentState.statementInfo.unparsed_row_count || 0);
  statusNode.textContent = `Current statement: ${paymentState.statementInfo.original_filename} (${paymentState.statementInfo.parsed_row_count} parsed row(s)${
    unparsedCount > 0 ? `, ${unparsedCount} unparsed` : ""
  }) uploaded ${formatDate(paymentState.statementInfo.uploaded_at)}.`;
  statusNode.style.color = "#1f2333";
  if (deleteButton) {
    deleteButton.disabled = false;
  }
}

async function loadStatementInfo() {
  paymentState.statementInfo = await requestJson("/api/teacher/payment-statement");
  renderStatementStatus();
}

function bindStudentSubmit() {
  const form = document.getElementById("submitReceiptForm");
  if (!form) {
    return;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = form.querySelector('button[type="submit"]');
    setButtonBusy(submitButton, true, "Submitting...");
    setPaymentStatus("submitReceiptStatus", "Submitting receipt...", false);
    const loadingToast = window.showToast
      ? window.showToast("Submitting receipt...", { type: "loading", sticky: true })
      : null;
    try {
      const formData = new FormData();
      const fileInput = document.getElementById("receiptFile");
      const selectedFile = fileInput?.files?.[0];
      formData.append("paymentItemId", document.getElementById("receiptPaymentItem").value);
      formData.append("amountPaid", document.getElementById("receiptAmountPaid").value);
      formData.append("paidAt", document.getElementById("receiptPaidAt").value);
      formData.append("transactionRef", document.getElementById("receiptTransactionRef").value);
      formData.append("note", document.getElementById("receiptNote").value);
      if (selectedFile) {
        formData.append("receiptFile", selectedFile);
      }

      const response = await fetch("/api/payment-receipts", {
        method: "POST",
        credentials: "same-origin",
        body: formData,
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch (_err) {
        payload = null;
      }
      if (!response.ok) {
        throw new Error((payload && payload.error) || "Could not submit receipt.");
      }
      form.reset();
      setPaymentStatus("submitReceiptStatus", "Receipt submitted successfully.", false);
      if (window.showToast) {
        window.showToast("Receipt submitted successfully.", { type: "success" });
      }
      await Promise.all([loadStudentReceipts(), loadStudentLedger()]);
    } catch (err) {
      setPaymentStatus("submitReceiptStatus", err.message, true);
      if (window.showToast) {
        window.showToast(err.message || "Could not submit receipt.", { type: "error" });
      }
    } finally {
      setButtonBusy(submitButton, false, "");
      if (loadingToast) {
        loadingToast.close();
      }
    }
  });
}

function bindStatementManagement() {
  const form = document.getElementById("statementUploadForm");
  const deleteButton = document.getElementById("deleteStatementButton");
  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const fileInput = document.getElementById("statementFile");
      const selectedFile = fileInput?.files?.[0];
      if (!selectedFile) {
        setPaymentStatus("statementStatus", "Choose a statement file first.", true);
        return;
      }
      const submitButton = form.querySelector('button[type="submit"]');
      setButtonBusy(submitButton, true, "Uploading...");
      const dryRun = !!document.getElementById("statementDryRun")?.checked;
      const loadingToast = window.showToast
        ? window.showToast(dryRun ? "Previewing statement (dry run)..." : "Uploading statement...", { type: "loading", sticky: true })
        : null;
      try {
        const formData = new FormData();
        formData.append("statementFile", selectedFile);
        const response = await fetch(`/api/teacher/payment-statement${dryRun ? "?dryRun=true" : ""}`, {
          method: "POST",
          credentials: "same-origin",
          body: formData,
        });
        let payload = null;
        try {
          payload = await response.json();
        } catch (_err) {
          payload = null;
        }
        if (!response.ok) {
          throw new Error((payload && payload.error) || "Could not upload statement.");
        }
        const ingestion = payload?.ingestion || {};
        if (window.showToast) {
          window.showToast(
            `${dryRun ? "Dry run preview" : "Statement uploaded"} (${payload.parsed_row_count} rows). Auto-approved: ${Number(
              ingestion.autoApproved || 0
            )}, Exceptions: ${Number(ingestion.exceptions || 0)}, Invalid: ${Number(ingestion.invalid || 0)}.`,
            { type: dryRun ? "warning" : "success" }
          );
        }
        if (!dryRun) {
          form.reset();
        }
        await Promise.all([dryRun ? Promise.resolve() : loadStatementInfo(), loadQueue(), loadReconciliationSummary()]);
      } catch (err) {
        setPaymentStatus("statementStatus", err.message || "Could not upload statement.", true);
        if (window.showToast) {
          window.showToast(err.message || "Could not upload statement.", { type: "error" });
        }
      } finally {
        setButtonBusy(submitButton, false, "");
        if (loadingToast) {
          loadingToast.close();
        }
      }
    });
  }

  if (deleteButton) {
    deleteButton.addEventListener("click", async () => {
      if (!window.confirm("Delete the current statement of account?")) {
        return;
      }
      setButtonBusy(deleteButton, true, "Deleting...");
      const loadingToast = window.showToast
        ? window.showToast("Deleting statement...", { type: "loading", sticky: true })
        : null;
      try {
        await requestJson("/api/teacher/payment-statement", { method: "DELETE" });
        if (window.showToast) {
          window.showToast("Statement deleted.", { type: "success" });
        }
        await Promise.all([loadStatementInfo(), loadQueue(), loadReconciliationSummary()]);
      } catch (err) {
        setPaymentStatus("statementStatus", err.message || "Could not delete statement.", true);
        if (window.showToast) {
          window.showToast(err.message || "Could not delete statement.", { type: "error" });
        }
      } finally {
        setButtonBusy(deleteButton, false, "");
        if (loadingToast) {
          loadingToast.close();
        }
      }
    });
  }
}

function bindPaymentItemsManagement() {
  const form = document.getElementById("paymentItemForm");
  const rows = document.getElementById("paymentItemRows");
  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitButton = form.querySelector('button[type="submit"]');
      setButtonBusy(submitButton, true, "Saving...");
      const loadingToast = window.showToast
        ? window.showToast("Saving payment item...", { type: "loading", sticky: true })
        : null;
      setPaymentStatus("paymentItemStatus", "Saving payment item...", false);
      try {
        await requestJson("/api/payment-items", {
          method: "POST",
          payload: {
            title: document.getElementById("paymentItemTitle").value.trim(),
            description: document.getElementById("paymentItemDescription").value.trim(),
            expectedAmount: document.getElementById("paymentItemAmount").value,
            currency: document.getElementById("paymentItemCurrency").value.trim().toUpperCase(),
            dueDate: document.getElementById("paymentItemDueDate").value,
            availabilityDays: document.getElementById("paymentItemAvailabilityDays").value,
          },
        });
        form.reset();
        document.getElementById("paymentItemCurrency").value = "NGN";
        setPaymentStatus("paymentItemStatus", "Payment item saved.", false);
        if (window.showToast) {
          window.showToast("Payment item saved.", { type: "success" });
        }
        await loadPaymentItems();
      } catch (err) {
        setPaymentStatus("paymentItemStatus", err.message, true);
        if (window.showToast) {
          window.showToast(err.message || "Could not save payment item.", { type: "error" });
        }
      } finally {
        setButtonBusy(submitButton, false, "");
        if (loadingToast) {
          loadingToast.close();
        }
      }
    });
  }

  if (rows) {
    rows.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const button = target.closest("button[data-action]");
      if (!button) {
        return;
      }
      const action = button.dataset.action;
      const id = Number.parseInt(button.dataset.id || "", 10);
      const item = paymentState.paymentItems.find((entry) => entry.id === id);
      if (!item) {
        return;
      }
      if (action === "edit-item") {
        const title = window.prompt("Title", item.title || "");
        if (title === null) return;
        const description = window.prompt("Description", item.description || "");
        if (description === null) return;
        const expectedAmount = window.prompt("Expected amount", String(item.expected_amount || ""));
        if (expectedAmount === null) return;
        const currency = window.prompt("Currency (3 letters)", item.currency || "NGN");
        if (currency === null) return;
        const dueDate = window.prompt("Due date (YYYY-MM-DD, optional)", item.due_date || "");
        if (dueDate === null) return;
        const availabilityDays = window.prompt(
          "Available for how many days? (optional)",
          item.availability_days ? String(item.availability_days) : ""
        );
        if (availabilityDays === null) return;
        const loadingToast = window.showToast
          ? window.showToast("Updating payment item...", { type: "loading", sticky: true })
          : null;
        try {
          await requestJson(`/api/payment-items/${id}`, {
            method: "PUT",
            payload: {
              title: title.trim(),
              description: description.trim(),
              expectedAmount: expectedAmount.trim(),
              currency: currency.trim().toUpperCase(),
              dueDate: dueDate.trim(),
              availabilityDays: availabilityDays.trim(),
            },
          });
          if (window.showToast) {
            window.showToast("Payment item updated.", { type: "success" });
          }
          await loadPaymentItems();
        } catch (err) {
          if (window.showToast) {
            window.showToast(err.message || "Could not update payment item.", { type: "error" });
          }
        } finally {
          if (loadingToast) {
            loadingToast.close();
          }
        }
      }
      if (action === "delete-item") {
        if (!window.confirm("Delete this payment item?")) {
          return;
        }
        const loadingToast = window.showToast
          ? window.showToast("Deleting payment item...", { type: "loading", sticky: true })
          : null;
        try {
          await requestJson(`/api/payment-items/${id}`, { method: "DELETE" });
          if (window.showToast) {
            window.showToast("Payment item deleted.", { type: "success" });
          }
          await loadPaymentItems();
        } catch (err) {
          if (window.showToast) {
            window.showToast(err.message || "Could not delete payment item.", { type: "error" });
          }
        } finally {
          if (loadingToast) {
            loadingToast.close();
          }
        }
      }
    });
  }
}

function getSelectedQueueIds() {
  return paymentState.queueRows.filter((row) => paymentState.selectedQueueIds.has(row.id)).map((row) => row.id);
}

function bindBulkActions() {
  const form = document.getElementById("bulkActionForm");
  if (!form) {
    return;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const selectedIds = getSelectedQueueIds();
    if (!selectedIds.length) {
      setPaymentStatus("bulkActionStatus", "Select at least one transaction first.", true);
      return;
    }
    const action = document.getElementById("bulkActionType")?.value || "";
    if (!action) {
      setPaymentStatus("bulkActionStatus", "Choose a bulk action.", true);
      return;
    }
    const payload = {
      action,
      transactionIds: selectedIds,
      primaryTransactionId: document.getElementById("bulkPrimaryTransactionId")?.value || "",
      rejectionReason: document.getElementById("bulkRejectionReason")?.value.trim() || "",
      note: document.getElementById("bulkReviewerNote")?.value.trim() || "",
    };
    const submitButton = form.querySelector('button[type="submit"]');
    setButtonBusy(submitButton, true, "Applying...");
    setPaymentStatus("bulkActionStatus", `Applying ${action} to ${selectedIds.length} transaction(s)...`, false);
    const loadingToast = window.showToast
      ? window.showToast("Applying bulk action...", { type: "loading", sticky: true })
      : null;
    try {
      const result = await requestJson("/api/reconciliation/bulk", { method: "POST", payload });
      setPaymentStatus(
        "bulkActionStatus",
        `Bulk action complete. Success: ${result.successCount}, Failed: ${result.failureCount}.`,
        result.failureCount > 0
      );
      if (window.showToast) {
        window.showToast(
          `Bulk action complete. Success: ${result.successCount}, Failed: ${result.failureCount}.`,
          { type: result.failureCount > 0 ? "warning" : "success" }
        );
      }
      paymentState.selectedQueueIds.clear();
      form.reset();
      await Promise.all([loadQueue(), loadReconciliationSummary()]);
    } catch (err) {
      setPaymentStatus("bulkActionStatus", err.message || "Could not apply bulk action.", true);
      if (window.showToast) {
        window.showToast(err.message || "Could not apply bulk action.", { type: "error" });
      }
    } finally {
      setButtonBusy(submitButton, false, "");
      if (loadingToast) {
        loadingToast.close();
      }
    }
  });
}
function bindQueueActions() {
  const queueRows = document.getElementById("receiptQueueRows");
  const filterForm = document.getElementById("queueFilterForm");
  const selectAllNode = document.getElementById("queueSelectAll");
  const prevPageButton = document.getElementById("queuePrevPage");
  const nextPageButton = document.getElementById("queueNextPage");

  if (filterForm) {
    filterForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      paymentState.queuePagination.page = 1;
      const toast = window.showToast
        ? window.showToast("Applying queue filters...", { type: "loading", sticky: true })
        : null;
      try {
        await Promise.all([loadQueue(), loadReconciliationSummary()]);
      } catch (err) {
        if (window.showToast) {
          window.showToast(err.message || "Could not load queue.", { type: "error" });
        }
      } finally {
        if (toast) toast.close();
      }
    });
  }

  if (prevPageButton) {
    prevPageButton.addEventListener("click", async () => {
      if (paymentState.queuePagination.page <= 1) {
        return;
      }
      paymentState.queuePagination.page -= 1;
      await loadQueue();
    });
  }

  if (nextPageButton) {
    nextPageButton.addEventListener("click", async () => {
      if (paymentState.queuePagination.page >= paymentState.queuePagination.totalPages) {
        return;
      }
      paymentState.queuePagination.page += 1;
      await loadQueue();
    });
  }

  if (selectAllNode) {
    selectAllNode.addEventListener("change", () => {
      if (selectAllNode.checked) {
        paymentState.queueRows.forEach((row) => paymentState.selectedQueueIds.add(row.id));
      } else {
        paymentState.selectedQueueIds.clear();
      }
      renderQueue(paymentState.queueRows);
    });
  }

  if (queueRows) {
    queueRows.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) {
        return;
      }
      if (!target.classList.contains("queue-select-row")) {
        return;
      }
      const id = Number.parseInt(target.dataset.id || "", 10);
      if (!Number.isFinite(id) || id <= 0) {
        return;
      }
      if (target.checked) {
        paymentState.selectedQueueIds.add(id);
      } else {
        paymentState.selectedQueueIds.delete(id);
      }
      renderQueue(paymentState.queueRows);
    });

    queueRows.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const button = target.closest("button[data-action]");
      if (!button) {
        return;
      }
      const action = button.dataset.action;
      const id = Number.parseInt(button.dataset.id || "", 10);
      if (!Number.isFinite(id) || id <= 0) {
        return;
      }
      const endpointByAction = {
        approve: `/api/reconciliation/${id}/approve`,
        reject: `/api/reconciliation/${id}/reject`,
        "request-student-confirmation": `/api/reconciliation/${id}/request-student-confirmation`,
        "merge-duplicates": `/api/reconciliation/${id}/merge-duplicates`,
      };
      const endpoint = endpointByAction[action];
      if (!endpoint) {
        return;
      }
      const payload = {};
      if (action === "reject") {
        const reason = window.prompt("Reason for rejection (optional):", "");
        if (reason !== null && reason.trim()) {
          payload.note = reason.trim();
        }
      }
      if (action === "merge-duplicates") {
        const primaryId = window.prompt("Enter primary transaction ID to keep:");
        if (primaryId === null) {
          return;
        }
        payload.primaryTransactionId = primaryId.trim();
      }
      const loadingToast = window.showToast
        ? window.showToast("Applying reconciliation action...", { type: "loading", sticky: true })
        : null;
      setButtonBusy(button, true, "Updating...");
      try {
        await requestJson(endpoint, { method: "POST", payload });
        if (window.showToast) {
          window.showToast("Reconciliation action applied.", { type: "success" });
        }
        await Promise.all([loadQueue(), loadReconciliationSummary()]);
      } catch (err) {
        if (window.showToast) {
          window.showToast(err.message || "Could not apply reconciliation action.", { type: "error" });
        }
      } finally {
        setButtonBusy(button, false, "");
        if (loadingToast) {
          loadingToast.close();
        }
      }
    });
  }
}

async function initPaymentsPage() {
  const page = document.body?.dataset?.page;
  if (page !== "payments") {
    return;
  }
  try {
    paymentState.me = await requestJson("/api/me");
    await loadPaymentItems();

    const studentSection = document.getElementById("studentPaymentsSection");
    const reviewSection = document.getElementById("reviewPaymentsSection");
    const queueSection = document.getElementById("receiptQueueSection");

    if (paymentState.me.role === "student") {
      if (studentSection) studentSection.hidden = false;
      if (reviewSection) reviewSection.remove();
      if (queueSection) queueSection.remove();
      bindStudentSubmit();
      await Promise.all([loadStudentReceipts(), loadStudentLedger()]);
      if (paymentState.ledger && paymentState.ledger.summary && window.showToast) {
        const overdueCount = Number(paymentState.ledger.summary.overdueCount || 0);
        const dueSoonCount = Number(paymentState.ledger.summary.dueSoonCount || 0);
        if (overdueCount > 0) {
          window.showToast(`You have ${overdueCount} overdue payment reminder(s).`, { type: "error" });
        } else if (dueSoonCount > 0) {
          window.showToast(`You have ${dueSoonCount} payment(s) due soon.`, { type: "warning" });
        }
      }
      return;
    }

    if (studentSection) studentSection.remove();
    if (reviewSection) reviewSection.hidden = false;
    if (queueSection) queueSection.hidden = false;
    bindStatementManagement();
    bindPaymentItemsManagement();
    bindQueueActions();
    bindBulkActions();
    await Promise.all([loadQueue(), loadStatementInfo(), loadReconciliationSummary()]);
  } catch (err) {
    const errorNode = document.getElementById("paymentsError");
    if (errorNode) {
      errorNode.textContent = err.message || "Could not load payments page.";
      errorNode.hidden = false;
    }
    if (window.showToast) {
      window.showToast(err.message || "Could not load payments page.", { type: "error" });
    }
  }
}

initPaymentsPage();
