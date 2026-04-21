function setText(id, value) {
  const node = document.getElementById(id);
  if (node) {
    node.textContent = String(value);
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value || "-") : date.toLocaleString();
}

async function requestJson(url, { method = "GET", payload } = {}) {
  const response = await fetch(url, {
    method,
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    credentials: "same-origin",
    body: payload ? JSON.stringify(payload) : undefined,
  });

  let data = null;
  try {
    data = await response.json();
  } catch (_err) {
    // keep fallback
  }

  if (!response.ok) {
    throw new Error((data && data.error) || "Request failed.");
  }
  return data;
}

function renderRows(rows) {
  const tbody = document.getElementById("loginRows");
  if (!tbody) {
    return;
  }

  tbody.innerHTML = "";

  if (!rows || rows.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="4" style="color: #636b8a;">No login activity yet.</td>';
    tbody.appendChild(tr);
    return;
  }

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(row.username || "-")}</td>
      <td>${escapeHtml(row.source || "-")}</td>
      <td>${escapeHtml(row.ip || "-")}</td>
      <td>${escapeHtml(formatDateTime(row.logged_in_at))}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderAuditRows(rows) {
  const tbody = document.getElementById("auditRows");
  if (!tbody) {
    return;
  }

  tbody.innerHTML = "";

  if (!rows || rows.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="7" style="color: #636b8a;">No content audit events yet.</td>';
    tbody.appendChild(tr);
    return;
  }

  function getActionBadgeClass(action) {
    if (action === "delete") {
      return "status-badge status-badge--error";
    }
    if (action === "edit") {
      return "status-badge status-badge--warning";
    }
    return "status-badge status-badge--success";
  }

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(row.actor_username || "-")}</td>
      <td><span class="status-badge">${escapeHtml(row.actor_role || "-")}</span></td>
      <td><span class="${getActionBadgeClass(row.action)}">${escapeHtml(row.action || "-")}</span></td>
      <td>${escapeHtml(row.content_type || "-")}</td>
      <td>${escapeHtml(row.target_owner || "-")}</td>
      <td>${escapeHtml(row.summary || "-")}</td>
      <td>${escapeHtml(formatDateTime(row.created_at))}</td>
    `;
    tbody.appendChild(tr);
  });
}

function payoutBadgeClass(reviewRequired) {
  return reviewRequired ? "status-badge status-badge--warning" : "status-badge status-badge--success";
}

function reviewBadgeClass(status) {
  const normalized = String(status || "pending").trim().toLowerCase();
  if (normalized === "approved") {
    return "status-badge status-badge--success";
  }
  if (normalized === "rejected") {
    return "status-badge status-badge--error";
  }
  return "status-badge status-badge--warning";
}

function renderPayoutAccountRows(rows) {
  const tbody = document.getElementById("payoutAccountRows");
  if (!tbody) {
    return;
  }
  tbody.innerHTML = "";

  if (!rows || rows.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="7" style="color: #636b8a;">No lecturer payout accounts found.</td>';
    tbody.appendChild(tr);
    return;
  }

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    const isPending = Number(row.review_required || 0) === 1;
    tr.innerHTML = `
      <td>${escapeHtml(row.lecturer_username || "-")}</td>
      <td>${escapeHtml(row.lecturer_department || "-")}</td>
      <td>${escapeHtml(row.bank_name || "-")}</td>
      <td>${escapeHtml(row.account_masked || row.account_last4 || "-")}</td>
      <td><span class="${payoutBadgeClass(isPending)}">${isPending ? "Pending review" : "Approved"}</span></td>
      <td>${escapeHtml(formatDateTime(row.updated_at || row.created_at))}</td>
      <td>
        <div class="table-actions">
          <button class="btn btn-secondary btn-small" type="button" data-action="${
            isPending ? "approve-payout-account" : "review-payout-account"
          }" data-id="${Number(row.id || 0)}">
            ${isPending ? "Approve" : "Mark review"}
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function renderMarkReviewRows(rows) {
  const tbody = document.getElementById("markReviewRows");
  if (!tbody) {
    return;
  }
  tbody.innerHTML = "";

  if (!rows || rows.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="7" style="color: #636b8a;">No marks are waiting for review.</td>';
    tbody.appendChild(tr);
    return;
  }

  rows.forEach((row) => {
    const status = String(row.status || "pending").trim().toLowerCase();
    const reviewActions =
      status === "pending"
        ? `
          <div class="table-actions">
            <button class="btn btn-secondary btn-small" type="button" data-action="approve-mark" data-id="${Number(row.id || 0)}">Approve</button>
            <button class="btn btn-danger btn-small" type="button" data-action="reject-mark" data-id="${Number(row.id || 0)}">Reject</button>
          </div>
        `
        : escapeHtml(row.reviewer_note || row.reviewed_by || "-");

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(row.lecturer_username || "-")}</td>
      <td>${escapeHtml(row.student_username || "-")}</td>
      <td>${escapeHtml(`${row.course_code || "-"}${row.course_title ? ` - ${row.course_title}` : ""}`)}</td>
      <td>${escapeHtml(row.assessment_title || "-")}</td>
      <td>${escapeHtml(`${row.score || 0} / ${row.max_score || 0}`)}</td>
      <td><span class="${reviewBadgeClass(status)}">${escapeHtml(status)}</span></td>
      <td>${reviewActions}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function loadAdminStats() {
  const errorNode = document.getElementById("adminError");

  try {
    const stats = await requestJson("/api/admin/stats");
    setText("totalUsers", stats.totalUsers || 0);
    setText("totalStudents", stats.totalStudents || 0);
    setText("totalLecturers", stats.totalLecturers ?? stats.totalTeachers ?? 0);
    setText("totalAdmins", stats.totalAdmins || 0);
    setText("totalLogins", stats.totalLogins || 0);
    setText("uniqueLoggedInUsers", stats.uniqueLoggedInUsers || 0);
    setText("todayLogins", stats.todayLogins || 0);
    renderRows(stats.recentLogins || []);
    renderAuditRows(stats.recentAuditLogs || []);
  } catch (_err) {
    if (errorNode) {
      errorNode.textContent = "Could not load admin stats.";
      errorNode.hidden = false;
    }
    if (window.showToast) {
      window.showToast("Could not load admin stats.", { type: "error" });
    }
  }
}

async function loadPayoutAccountReviewQueue() {
  const statusNode = document.getElementById("adminPayoutAccountStatus");
  if (statusNode) {
    statusNode.textContent = "Loading lecturer payout accounts...";
  }

  try {
    const payload = await requestJson("/api/admin/lecturer/payout-accounts?limit=50");
    const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
    const pendingCount = accounts.filter((account) => account.review_required).length;
    setText("pendingPayoutAccountReviews", pendingCount);
    renderPayoutAccountRows(accounts);
    if (statusNode) {
      statusNode.textContent = pendingCount
        ? `${pendingCount} payout account${pendingCount === 1 ? "" : "s"} currently waiting for review.`
        : "No payout accounts are waiting for review.";
    }
  } catch (err) {
    renderPayoutAccountRows([]);
    if (statusNode) {
      statusNode.textContent = err.message || "Could not load payout account review queue.";
    }
    if (window.showToast) {
      window.showToast(err.message || "Could not load payout account review queue.", { type: "error" });
    }
  }
}

async function loadMarkReviewQueue() {
  const statusNode = document.getElementById("adminMarksReviewStatus");
  if (statusNode) {
    statusNode.textContent = "Loading mark submissions...";
  }

  try {
    const payload = await requestJson("/api/admin/lecturer/marks-submissions?limit=50");
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const pendingCount = items.filter((item) => String(item.status || "").toLowerCase() === "pending").length;
    setText("pendingMarksReviews", pendingCount);
    renderMarkReviewRows(items);
    if (statusNode) {
      statusNode.textContent = pendingCount
        ? `${pendingCount} mark submission${pendingCount === 1 ? "" : "s"} waiting for admin review.`
        : "No mark submissions are waiting for review.";
    }
  } catch (err) {
    renderMarkReviewRows([]);
    if (statusNode) {
      statusNode.textContent = err.message || "Could not load mark review queue.";
    }
    if (window.showToast) {
      window.showToast(err.message || "Could not load mark review queue.", { type: "error" });
    }
  }
}

async function handlePayoutAccountAction(button) {
  const action = String(button.dataset.action || "");
  const accountId = Number.parseInt(button.dataset.id || "", 10);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    return;
  }

  const message =
    action === "approve-payout-account" ? "Approving payout account..." : "Sending payout account back to review...";
  const loadingToast = window.showToast ? window.showToast(message, { type: "loading", sticky: true }) : null;
  button.disabled = true;

  try {
    await requestJson(
      action === "approve-payout-account"
        ? `/api/admin/lecturer/payout-accounts/${accountId}/approve`
        : `/api/admin/lecturer/payout-accounts/${accountId}/review`,
      {
        method: "POST",
      }
    );
    if (window.showToast) {
      window.showToast(
        action === "approve-payout-account" ? "Payout account approved." : "Payout account marked for review.",
        { type: "success" }
      );
    }
    await loadPayoutAccountReviewQueue();
  } catch (err) {
    if (window.showToast) {
      window.showToast(err.message || "Could not update payout account review.", { type: "error" });
    }
  } finally {
    button.disabled = false;
    if (loadingToast) {
      loadingToast.close();
    }
  }
}

async function handleMarkReviewAction(button) {
  const action = String(button.dataset.action || "");
  const submissionId = Number.parseInt(button.dataset.id || "", 10);
  if (!Number.isFinite(submissionId) || submissionId <= 0) {
    return;
  }

  const isApproval = action === "approve-mark";
  const notePrompt = isApproval ? "Optional approval note:" : "Reason for rejection:";
  const note = window.prompt(notePrompt, "");
  if (note === null) {
    return;
  }

  const loadingToast = window.showToast
    ? window.showToast(isApproval ? "Approving marks..." : "Rejecting marks...", { type: "loading", sticky: true })
    : null;
  button.disabled = true;

  try {
    await requestJson(`/api/admin/lecturer/marks-submissions/${submissionId}/review`, {
      method: "POST",
      payload: {
        status: isApproval ? "approved" : "rejected",
        note,
      },
    });
    if (window.showToast) {
      window.showToast(isApproval ? "Marks approved." : "Marks rejected.", { type: "success" });
    }
    await loadMarkReviewQueue();
  } catch (err) {
    if (window.showToast) {
      window.showToast(err.message || "Could not review mark submission.", { type: "error" });
    }
  } finally {
    button.disabled = false;
    if (loadingToast) {
      loadingToast.close();
    }
  }
}

function bindAdminReviewActions() {
  const payoutRoot = document.getElementById("payoutAccountRows");
  if (payoutRoot && payoutRoot.dataset.bound !== "1") {
    payoutRoot.dataset.bound = "1";
    payoutRoot.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const button = target.closest("button[data-action]");
      if (!(button instanceof HTMLButtonElement)) {
        return;
      }
      await handlePayoutAccountAction(button);
    });
  }

  const marksRoot = document.getElementById("markReviewRows");
  if (marksRoot && marksRoot.dataset.bound !== "1") {
    marksRoot.dataset.bound = "1";
    marksRoot.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const button = target.closest("button[data-action]");
      if (!(button instanceof HTMLButtonElement)) {
        return;
      }
      await handleMarkReviewAction(button);
    });
  }
}

bindAdminReviewActions();
loadAdminStats();
loadPayoutAccountReviewQueue();
loadMarkReviewQueue();
