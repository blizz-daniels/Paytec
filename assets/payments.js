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
  return '<span class="status-badge">submitted</span>';
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
  selectedQueueIds: new Set(),
  statementInfo: null,
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
            `<option value="${item.id}">${escapeHtml(item.title)} - ${escapeHtml(item.currency)} ${escapeHtml(item.expected_amount)}</option>`
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
    tbody.innerHTML = '<tr><td colspan="11" style="color:#636b8a;">No receipts match the current filters.</td></tr>';
    if (selectAllNode) {
      selectAllNode.checked = false;
    }
    return;
  }
  rows.forEach((row) => {
    const flags = parseFlags(row);
    const notes = parseVerificationNotes(row);
    const statementResult = notes?.statement_verification?.result || null;
    const sla = getSlaMeta(row);
    const flagsHtml = [
      flags.amount_matches_expected === false
        ? '<span class="status-badge status-badge--error">Amount mismatch</span>'
        : '<span class="status-badge status-badge--success">Amount ok</span>',
      flags.paid_before_due === false
        ? '<span class="status-badge status-badge--warning">Paid after due</span>'
        : flags.paid_before_due === true
        ? '<span class="status-badge status-badge--success">Paid before due</span>'
        : '<span class="status-badge">No due date</span>',
      flags.duplicate_reference
        ? '<span class="status-badge status-badge--error">Duplicate ref</span>'
        : '<span class="status-badge status-badge--success">Unique ref</span>',
      statementResult
        ? statementResult.matched
          ? '<span class="status-badge status-badge--success">Statement match</span>'
          : '<span class="status-badge status-badge--warning">Statement mismatch</span>'
        : '<span class="status-badge">Statement unchecked</span>',
    ].join(" ");

    const actions = [];
    actions.push(`<a class="btn btn-secondary" href="/api/payment-receipts/${row.id}/file" target="_blank" rel="noopener noreferrer">Open File</a>`);
    actions.push(`<button class="btn btn-secondary" type="button" data-action="history" data-id="${row.id}">Notes</button>`);
    actions.push(`<button class="btn btn-secondary" type="button" data-action="assign-self" data-id="${row.id}">Assign Me</button>`);
    actions.push(`<button class="btn btn-secondary" type="button" data-action="add-note" data-id="${row.id}">Add Note</button>`);
    if (row.status === "submitted" || row.status === "under_review") {
      actions.push(`<button class="btn btn-secondary" type="button" data-action="verify" data-id="${row.id}">Verify</button>`);
    }
    if (row.status === "submitted") {
      actions.push(`<button class="btn" type="button" data-action="under-review" data-id="${row.id}">Move to Review</button>`);
    }
    if (row.status === "under_review") {
      actions.push(`<button class="btn" type="button" data-action="approve" data-id="${row.id}">Approve</button>`);
      actions.push(
        `<button class="btn" type="button" data-action="reject" data-id="${row.id}" style="background:#b42318;">Reject</button>`
      );
    }

    const assignedText = row.assigned_reviewer ? `Assigned: ${row.assigned_reviewer}` : "Unassigned";
    const slaHtml = sla ? `<span class="${sla.className}">${escapeHtml(sla.text)}</span>` : '<span class="status-badge">N/A</span>';
    const checkedAttr = paymentState.selectedQueueIds.has(row.id) ? "checked" : "";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" class="queue-select-row" data-id="${row.id}" ${checkedAttr} /></td>
      <td>${escapeHtml(row.student_username || "-")}</td>
      <td>${escapeHtml(row.payment_item_title || "-")}</td>
      <td>${escapeHtml(formatMoney(row.amount_paid, row.currency))}</td>
      <td>${escapeHtml(row.transaction_ref || "-")}</td>
      <td>${escapeHtml(formatDate(row.paid_at))}</td>
      <td>${statusBadge(row.status)}</td>
      <td>${escapeHtml(assignedText)}</td>
      <td>${slaHtml}</td>
      <td>${flagsHtml}</td>
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
}

async function loadQueue() {
  const endpoint = paymentState.me.role === "admin" ? "/api/admin/payment-receipts" : "/api/teacher/payment-receipts";
  const params = new URLSearchParams();
  const status = document.getElementById("queueStatus")?.value || "";
  const student = document.getElementById("queueStudent")?.value || "";
  const dateFrom = document.getElementById("queueDateFrom")?.value || "";
  const dateTo = document.getElementById("queueDateTo")?.value || "";
  const paymentItemId = document.getElementById("queuePaymentItem")?.value || "";
  const assignment = document.getElementById("queueAssignment")?.value || "all";
  if (status) params.set("status", status);
  if (student) params.set("student", student);
  if (dateFrom) params.set("dateFrom", dateFrom);
  if (dateTo) params.set("dateTo", dateTo);
  if (paymentItemId) params.set("paymentItemId", paymentItemId);
  if (assignment) params.set("assignment", assignment);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  paymentState.queueRows = await requestJson(`${endpoint}${suffix}`);
  const validIds = new Set(paymentState.queueRows.map((row) => row.id));
  paymentState.selectedQueueIds = new Set([...paymentState.selectedQueueIds].filter((id) => validIds.has(id)));
  renderQueue(paymentState.queueRows);
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
  statusNode.textContent = `Current statement: ${paymentState.statementInfo.original_filename} (${paymentState.statementInfo.parsed_row_count} row(s)) uploaded ${formatDate(
    paymentState.statementInfo.uploaded_at
  )}.`;
  statusNode.style.color = "#1f2333";
  if (deleteButton) {
    deleteButton.disabled = false;
  }
}

async function loadStatementInfo() {
  paymentState.statementInfo = await requestJson("/api/teacher/payment-statement");
  renderStatementStatus();
}

async function loadReviewerNotes(receiptId) {
  const rowsNode = document.getElementById("reviewerHistoryRows");
  const statusNode = document.getElementById("reviewerHistoryStatus");
  if (!rowsNode || !statusNode) {
    return;
  }
  try {
    statusNode.textContent = `Loading notes for receipt #${receiptId}...`;
    const rows = await requestJson(`/api/payment-receipts/${receiptId}/notes`);
    if (!rows.length) {
      rowsNode.innerHTML = '<tr><td colspan="3" style="color:#636b8a;">No reviewer notes yet for this receipt.</td></tr>';
    } else {
      rowsNode.innerHTML = rows
        .map(
          (row) => `
            <tr>
              <td>${escapeHtml(formatDate(row.created_at))}</td>
              <td>${escapeHtml(row.reviewer_username || "-")}</td>
              <td>${escapeHtml(row.note || "-")}</td>
            </tr>
          `
        )
        .join("");
    }
    statusNode.textContent = `Showing ${rows.length} note(s) for receipt #${receiptId}.`;
  } catch (err) {
    rowsNode.innerHTML = '<tr><td colspan="3" style="color:#a52828;">Could not load notes history.</td></tr>';
    statusNode.textContent = err.message || "Could not load notes history.";
  }
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
      const loadingToast = window.showToast
        ? window.showToast("Uploading statement...", { type: "loading", sticky: true })
        : null;
      try {
        const formData = new FormData();
        formData.append("statementFile", selectedFile);
        const response = await fetch("/api/teacher/payment-statement", {
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
        if (window.showToast) {
          window.showToast(`Statement uploaded (${payload.parsed_row_count} rows).`, { type: "success" });
        }
        form.reset();
        await loadStatementInfo();
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
        await loadStatementInfo();
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
      setPaymentStatus("bulkActionStatus", "Select at least one receipt first.", true);
      return;
    }
    const action = document.getElementById("bulkActionType")?.value || "";
    if (!action) {
      setPaymentStatus("bulkActionStatus", "Choose a bulk action.", true);
      return;
    }
    const payload = {
      action,
      receiptIds: selectedIds,
      assignee: document.getElementById("bulkAssignee")?.value.trim() || "",
      rejectionReason: document.getElementById("bulkRejectionReason")?.value.trim() || "",
      note: document.getElementById("bulkReviewerNote")?.value.trim() || "",
    };
    const submitButton = form.querySelector('button[type="submit"]');
    setButtonBusy(submitButton, true, "Applying...");
    setPaymentStatus("bulkActionStatus", `Applying ${action} to ${selectedIds.length} receipt(s)...`, false);
    const loadingToast = window.showToast
      ? window.showToast("Applying bulk action...", { type: "loading", sticky: true })
      : null;
    try {
      const result = await requestJson("/api/payment-receipts/bulk", { method: "POST", payload });
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
      await loadQueue();
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

  if (filterForm) {
    filterForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const toast = window.showToast
        ? window.showToast("Applying queue filters...", { type: "loading", sticky: true })
        : null;
      try {
        await loadQueue();
      } catch (err) {
        if (window.showToast) {
          window.showToast(err.message || "Could not load queue.", { type: "error" });
        }
      } finally {
        if (toast) toast.close();
      }
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

      if (action === "history") {
        await loadReviewerNotes(id);
        return;
      }

      if (action === "assign-self") {
        const loadingToast = window.showToast
          ? window.showToast("Assigning receipt...", { type: "loading", sticky: true })
          : null;
        setButtonBusy(button, true, "Assigning...");
        try {
          await requestJson(`/api/payment-receipts/${id}/assign`, { method: "POST", payload: {} });
          if (window.showToast) {
            window.showToast("Receipt assigned.", { type: "success" });
          }
          await loadQueue();
        } catch (err) {
          if (window.showToast) {
            window.showToast(err.message || "Could not assign receipt.", { type: "error" });
          }
        } finally {
          setButtonBusy(button, false, "");
          if (loadingToast) {
            loadingToast.close();
          }
        }
        return;
      }

      if (action === "add-note") {
        const note = window.prompt("Enter reviewer note:");
        if (note === null) {
          return;
        }
        const loadingToast = window.showToast
          ? window.showToast("Saving reviewer note...", { type: "loading", sticky: true })
          : null;
        setButtonBusy(button, true, "Saving...");
        try {
          await requestJson(`/api/payment-receipts/${id}/notes`, { method: "POST", payload: { note: note.trim() } });
          if (window.showToast) {
            window.showToast("Reviewer note saved.", { type: "success" });
          }
          await loadReviewerNotes(id);
        } catch (err) {
          if (window.showToast) {
            window.showToast(err.message || "Could not save reviewer note.", { type: "error" });
          }
        } finally {
          setButtonBusy(button, false, "");
          if (loadingToast) {
            loadingToast.close();
          }
        }
        return;
      }

      if (action === "verify") {
        const loadingToast = window.showToast
          ? window.showToast("Verifying receipt...", { type: "loading", sticky: true })
          : null;
        setButtonBusy(button, true, "Verifying...");
        try {
          await requestJson(`/api/payment-receipts/${id}/verify`, { method: "POST", payload: {} });
          if (window.showToast) {
            window.showToast("Verification complete.", { type: "success" });
          }
          await loadQueue();
          await loadReviewerNotes(id);
        } catch (err) {
          if (window.showToast) {
            window.showToast(err.message || "Could not verify receipt.", { type: "error" });
          }
        } finally {
          setButtonBusy(button, false, "");
          if (loadingToast) {
            loadingToast.close();
          }
        }
        return;
      }

      const endpointByAction = {
        "under-review": `/api/payment-receipts/${id}/under-review`,
        approve: `/api/payment-receipts/${id}/approve`,
        reject: `/api/payment-receipts/${id}/reject`,
      };
      const endpoint = endpointByAction[action];
      if (!endpoint) {
        return;
      }
      const payload = {};
      if (action === "reject") {
        const reason = window.prompt("Why are you rejecting this receipt?");
        if (reason === null) {
          return;
        }
        payload.rejectionReason = reason.trim();
      }
      const note = window.prompt("Optional reviewer note (leave blank to skip):", "");
      if (note !== null && note.trim()) {
        payload.note = note.trim();
      }
      const loadingToast = window.showToast
        ? window.showToast("Updating receipt status...", { type: "loading", sticky: true })
        : null;
      setButtonBusy(button, true, "Updating...");
      try {
        await requestJson(endpoint, { method: "POST", payload });
        if (window.showToast) {
          window.showToast("Receipt status updated.", { type: "success" });
        }
        await loadQueue();
        await loadReviewerNotes(id);
      } catch (err) {
        if (window.showToast) {
          window.showToast(err.message || "Could not update receipt status.", { type: "error" });
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
    await Promise.all([loadQueue(), loadStatementInfo()]);
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
