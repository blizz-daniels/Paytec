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
  queueRows: [],
};

function parseFlags(row) {
  if (row && row.verification_flags && typeof row.verification_flags === "object") {
    return row.verification_flags;
  }
  try {
    const raw = row && row.verification_notes ? JSON.parse(row.verification_notes) : null;
    if (raw && raw.verification_flags) {
      return raw.verification_flags;
    }
    return raw || {};
  } catch (_err) {
    return {};
  }
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
      <td>${escapeHtml(row.currency || "NGN")} ${escapeHtml(row.amount_paid)}</td>
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
  if (!tbody) {
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
      <td>${escapeHtml(item.currency)} ${escapeHtml(item.expected_amount)}</td>
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
  if (!tbody) {
    return;
  }
  tbody.innerHTML = "";
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="color:#636b8a;">No receipts match the current filters.</td></tr>';
    return;
  }
  rows.forEach((row) => {
    const flags = parseFlags(row);
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
    ].join(" ");

    const actions = [];
    actions.push(`<a class="btn btn-secondary" href="/api/payment-receipts/${row.id}/file" target="_blank" rel="noopener noreferrer">Open File</a>`);
    if (row.status === "submitted") {
      actions.push(`<button class="btn" type="button" data-action="under-review" data-id="${row.id}">Move to Review</button>`);
    }
    if (row.status === "under_review") {
      actions.push(`<button class="btn" type="button" data-action="approve" data-id="${row.id}">Approve</button>`);
      actions.push(
        `<button class="btn" type="button" data-action="reject" data-id="${row.id}" style="background:#b42318;">Reject</button>`
      );
    }
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(row.student_username || "-")}</td>
      <td>${escapeHtml(row.payment_item_title || "-")}</td>
      <td>${escapeHtml(row.currency || "NGN")} ${escapeHtml(row.amount_paid)}</td>
      <td>${escapeHtml(row.transaction_ref || "-")}</td>
      <td>${escapeHtml(formatDate(row.paid_at))}</td>
      <td>${statusBadge(row.status)}</td>
      <td>${flagsHtml}</td>
      <td>${actions.join(" ")}</td>
    `;
    tbody.appendChild(tr);
  });
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

async function loadQueue() {
  const endpoint = paymentState.me.role === "admin" ? "/api/admin/payment-receipts" : "/api/teacher/payment-receipts";
  const params = new URLSearchParams();
  const status = document.getElementById("queueStatus")?.value || "";
  const student = document.getElementById("queueStudent")?.value || "";
  const dateFrom = document.getElementById("queueDateFrom")?.value || "";
  const dateTo = document.getElementById("queueDateTo")?.value || "";
  const paymentItemId = document.getElementById("queuePaymentItem")?.value || "";
  if (status) params.set("status", status);
  if (student) params.set("student", student);
  if (dateFrom) params.set("dateFrom", dateFrom);
  if (dateTo) params.set("dateTo", dateTo);
  if (paymentItemId) params.set("paymentItemId", paymentItemId);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  paymentState.queueRows = await requestJson(`${endpoint}${suffix}`);
  renderQueue(paymentState.queueRows);
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
      await loadStudentReceipts();
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

function bindQueueActions() {
  const queueRows = document.getElementById("receiptQueueRows");
  const filterForm = document.getElementById("queueFilterForm");

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

  if (queueRows) {
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
      if (reviewSection) reviewSection.hidden = true;
      if (queueSection) queueSection.hidden = true;
      bindStudentSubmit();
      await loadStudentReceipts();
      return;
    }

    if (studentSection) studentSection.hidden = true;
    if (reviewSection) reviewSection.hidden = false;
    if (queueSection) queueSection.hidden = false;
    bindPaymentItemsManagement();
    bindQueueActions();
    await loadQueue();
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
