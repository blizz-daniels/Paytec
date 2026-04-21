function setStatus(id, message, isError) {
  const node = document.getElementById(id);
  if (!node) {
    return;
  }
  node.textContent = message;
  node.style.color = isError ? "#a52828" : "#1f2333";
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

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatReactionDetails(item) {
  const details = Array.isArray(item?.reaction_details) ? item.reaction_details : [];
  if (!details.length) {
    return "";
  }
  const preview = details
    .slice(0, 10)
    .map((entry) => `${escapeHtml(entry.username)} (${escapeHtml(entry.reaction)})`)
    .join(", ");
  const extra = details.length > 10 ? ` +${details.length - 10} more` : "";
  return `<small>Reactions by: ${preview}${extra}</small>`;
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

function formatMoney(value) {
  const amount = Number(value || 0);
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0);
}

function formatPayoutDate(value) {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function normalizePayoutBadge(summary, account) {
  if (!account) {
    return { text: "Bank missing", className: "status-badge status-badge--warning" };
  }
  if (Number(account.review_required || 0) === 1 || String(account.recipient_status || "").toLowerCase() !== "active") {
    return { text: "Needs review", className: "status-badge status-badge--error" };
  }
  if (Number(summary?.availableBalance || 0) > 0) {
    return { text: "Ready", className: "status-badge status-badge--success" };
  }
  return { text: "Linked", className: "status-badge" };
}

function setPayoutMessage(nodeId, message, isError = false) {
  const node = document.getElementById(nodeId);
  if (!node) {
    return;
  }
  node.textContent = String(message || "");
  node.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function renderPayoutStats(root, summary) {
  if (!root) {
    return;
  }
  const stats = [
    { label: "Total earned", value: formatMoney(summary?.totalEarned || 0), hint: "All approved lecturer share amounts" },
    { label: "Pending payout", value: formatMoney(summary?.pendingBalance || 0), hint: "Reserved or under review" },
    { label: "Available", value: formatMoney(summary?.availableBalance || 0), hint: "Ready for payout" },
    { label: "Paid out", value: formatMoney(summary?.paidBalance || 0), hint: "Already transferred" },
  ];
  root.innerHTML = stats
    .map(
      (stat) => `
        <article class="payout-stat">
          <span class="payout-stat__label">${escapeHtml(stat.label)}</span>
          <strong class="payout-stat__value">${escapeHtml(stat.value)}</strong>
          <span class="payout-stat__hint">${escapeHtml(stat.hint)}</span>
        </article>
      `
    )
    .join("");
}

function renderPayoutAccount(root, account, summary) {
  if (!root) {
    return;
  }
  if (!account) {
    root.innerHTML = `
      <div class="payout-account__empty">
        <strong>No bank account linked yet.</strong>
        <p>Save your payout bank details to enable lecturer payouts.</p>
      </div>
    `;
    return;
  }

  const badge = normalizePayoutBadge(summary, account);
  root.innerHTML = `
    <dl class="payout-account__details">
      <div><dt>Bank</dt><dd>${escapeHtml(account.bank_name || "-")}</dd></div>
      <div><dt>Account name</dt><dd>${escapeHtml(account.account_name || "-")}</dd></div>
      <div><dt>Account</dt><dd>${escapeHtml(account.account_masked || `•••• ${account.account_last4 || ""}`)}</dd></div>
      <div><dt>Status</dt><dd><span class="${badge.className}">${escapeHtml(badge.text)}</span></dd></div>
      <div><dt>Auto payout</dt><dd>${account.auto_payout_enabled ? "Enabled" : "Disabled"}</dd></div>
      <div><dt>Admin approval</dt><dd>${account.review_required ? "Pending review" : "Approved"}</dd></div>
    </dl>
  `;
}

function renderPayoutHistory(root, transfers) {
  if (!root) {
    return;
  }
  const rows = Array.isArray(transfers) ? transfers : [];
  if (!rows.length) {
    root.innerHTML = '<tr><td colspan="5">No payout transfers yet.</td></tr>';
    return;
  }
  root.innerHTML = rows
    .map((row) => {
      const statusClass =
        row.status === "success"
          ? "status-badge status-badge--success"
          : row.status === "review" || row.status === "failed" || row.status === "reversed"
            ? "status-badge status-badge--error"
            : "status-badge status-badge--warning";
      return `
        <tr>
          <td>${escapeHtml(formatPayoutDate(row.created_at || row.completed_at || row.updated_at))}</td>
          <td>${escapeHtml(row.transfer_reference || row.transfer_code || "—")}</td>
          <td>${escapeHtml(formatMoney(row.total_amount || 0))}</td>
          <td><span class="${statusClass}">${escapeHtml(String(row.status || "queued"))}</span></td>
          <td>${escapeHtml(row.failure_reason || row.review_state || "—")}</td>
        </tr>
      `;
    })
    .join("");
}

async function loadLecturerPayoutData() {
  const section = document.getElementById("lecturerPayoutSection");
  const statsRoot = document.getElementById("lecturerPayoutStats");
  const accountRoot = document.getElementById("lecturerPayoutAccount");
  const historyRoot = document.getElementById("lecturerPayoutHistoryBody");
  const badge = document.getElementById("lecturerPayoutBadge");
  if (!section || !statsRoot || !accountRoot || !historyRoot) {
    return;
  }
  const role = String(currentUser?.role || "").trim().toLowerCase();
  if (role !== "teacher" && role !== "admin") {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  setPayoutMessage("lecturerPayoutStatus", "Loading payout information...");
  if (badge) {
    badge.className = "status-badge status-badge--warning";
    badge.textContent = "Loading";
  }

  try {
    const payload = await requestJson("/api/lecturer/payout-history?limit=10");
    const summary = payload?.summary || {};
    const account = payload?.account || null;
    const transfers = Array.isArray(payload?.transfers) ? payload.transfers : [];

    renderPayoutStats(statsRoot, summary);
    renderPayoutAccount(accountRoot, account, summary);
    renderPayoutHistory(historyRoot, transfers);

    const badgeState = normalizePayoutBadge(summary, account);
    if (badge) {
      badge.className = badgeState.className;
      badge.textContent = badgeState.text;
    }

    setPayoutMessage(
      "lecturerPayoutStatus",
      account
        ? account.review_required
          ? "Your payout account is waiting for admin review before transfers can run."
          : `Available balance ${formatMoney(summary.availableBalance || 0)} is ready for payout handling.`
        : "Link a bank account to start receiving lecturer payouts."
    );
  } catch (err) {
    setPayoutMessage("lecturerPayoutStatus", err.message || "Could not load payout information.", true);
    if (badge) {
      badge.className = "status-badge status-badge--error";
      badge.textContent = "Error";
    }
    renderPayoutStats(statsRoot, {});
    accountRoot.innerHTML = '<p class="auth-subtitle">Could not load payout account details.</p>';
    historyRoot.innerHTML = '<tr><td colspan="5">Could not load payout history.</td></tr>';
  }
}

function formatMarkScore(score, maxScore) {
  const safeScore = Number(score || 0);
  const safeMaxScore = Number(maxScore || 0);
  if (!Number.isFinite(safeScore) || !Number.isFinite(safeMaxScore) || safeMaxScore <= 0) {
    return "0 / 0";
  }
  return `${safeScore.toFixed(2).replace(/\.00$/, "")} / ${safeMaxScore.toFixed(2).replace(/\.00$/, "")}`;
}

function getReviewBadgeClass(status) {
  const normalized = String(status || "pending").trim().toLowerCase();
  if (normalized === "approved") {
    return "status-badge status-badge--success";
  }
  if (normalized === "rejected") {
    return "status-badge status-badge--error";
  }
  return "status-badge status-badge--warning";
}

function renderMarksRows(rows) {
  const root = document.getElementById("marksRows");
  if (!root) {
    return;
  }
  if (!Array.isArray(rows) || !rows.length) {
    root.innerHTML = '<tr><td colspan="6">No marks have been submitted for admin review yet.</td></tr>';
    return;
  }

  root.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.student_username || "-")}</td>
          <td>${escapeHtml(`${row.course_code || "-"}${row.course_title ? ` - ${row.course_title}` : ""}`)}</td>
          <td>${escapeHtml(row.assessment_title || "-")}</td>
          <td>${escapeHtml(formatMarkScore(row.score, row.max_score))}</td>
          <td><span class="${getReviewBadgeClass(row.status)}">${escapeHtml(row.status || "pending")}</span></td>
          <td>${escapeHtml(row.reviewer_note || "Pending admin review")}</td>
        </tr>
      `
    )
    .join("");
}

async function loadLecturerMarkSubmissions() {
  const queueStatus = document.getElementById("marksReviewQueueStatus");
  if (queueStatus) {
    setStatus("marksReviewQueueStatus", "Loading marks review queue...", false);
  }
  try {
    const payload = await requestJson("/api/lecturer/marks-submissions?limit=10");
    const rows = Array.isArray(payload?.items) ? payload.items : [];
    renderMarksRows(rows);
    setStatus(
      "marksReviewQueueStatus",
      rows.length ? "Submitted marks stay pending until an admin approves or rejects them." : "No marks submitted yet.",
      false
    );
  } catch (err) {
    renderMarksRows([]);
    setStatus("marksReviewQueueStatus", err.message || "Could not load submitted marks.", true);
  }
}

const manageConfigs = [
  {
    key: "notifications",
    endpoint: "/api/notifications",
    listId: "manageNotificationList",
    statusId: "manageNotificationStatus",
    emptyText: "No notifications to manage yet.",
    renderDetails(item) {
      const reactedBy = formatReactionDetails(item);
      return `
        <p>${escapeHtml(item.body || "")}</p>
        <small>${escapeHtml(item.category || "General")} | Department: ${escapeHtml(item.target_department || "all")} | Urgent: ${item.is_urgent ? "Yes" : "No"} | Pinned: ${item.is_pinned ? "Yes" : "No"} | Unread (students): ${Number(item.unread_count || 0)} | By ${escapeHtml(item.created_by || "-")}</small>
        ${reactedBy}
      `;
    },
    buildEditPayload(item) {
      const title = window.prompt("Notification title:", item.title || "");
      if (title === null) {
        return null;
      }
      const category = window.prompt("Category:", item.category || "General");
      if (category === null) {
        return null;
      }
      const body = window.prompt("Message:", item.body || "");
      if (body === null) {
        return null;
      }
      const urgentInput = window.prompt("Mark urgent? (yes/no):", item.is_urgent ? "yes" : "no");
      if (urgentInput === null) {
        return null;
      }
      const pinnedInput = window.prompt("Pin this notification? (yes/no):", item.is_pinned ? "yes" : "no");
      if (pinnedInput === null) {
        return null;
      }
      return {
        title: title.trim(),
        category: category.trim(),
        body: body.trim(),
        isUrgent: /^(yes|y|true|1)$/i.test(urgentInput.trim()),
        isPinned: /^(yes|y|true|1)$/i.test(pinnedInput.trim()),
      };
    },
  },
  {
    key: "shared-files",
    endpoint: "/api/shared-files",
    listId: "manageSharedFileList",
    statusId: "manageSharedFileStatus",
    emptyText: "No shared files to manage yet.",
    renderDetails(item) {
      const reactedBy = formatReactionDetails(item);
      return `
        <p>${escapeHtml(item.description || "")}</p>
        <small>File: ${escapeHtml(item.file_url || "-")} | Department: ${escapeHtml(item.target_department || "all")} | By ${escapeHtml(item.created_by || "-")}</small>
        ${reactedBy}
      `;
    },
    buildEditPayload(item) {
      const title = window.prompt("Shared file title:", item.title || "");
      if (title === null) {
        return null;
      }
      const description = window.prompt("Description:", item.description || "");
      if (description === null) {
        return null;
      }
      const fileUrl = window.prompt("File URL:", item.file_url || "");
      if (fileUrl === null) {
        return null;
      }
      return {
        title: title.trim(),
        description: description.trim(),
        fileUrl: fileUrl.trim(),
      };
    },
  },
  {
    key: "handouts",
    endpoint: "/api/handouts",
    listId: "manageHandoutList",
    statusId: "manageHandoutStatus",
    emptyText: "No handouts to manage yet.",
    renderDetails(item) {
      const reactedBy = formatReactionDetails(item);
      return `
        <p>${escapeHtml(item.description || "")}</p>
        <small>File: ${escapeHtml(item.file_url || "(none)")} | Department: ${escapeHtml(item.target_department || "all")} | By ${escapeHtml(item.created_by || "-")}</small>
        ${reactedBy}
      `;
    },
    buildEditPayload(item) {
      const title = window.prompt("Handout title:", item.title || "");
      if (title === null) {
        return null;
      }
      const description = window.prompt("Description:", item.description || "");
      if (description === null) {
        return null;
      }
      const fileUrl = window.prompt("File URL (optional):", item.file_url || "");
      if (fileUrl === null) {
        return null;
      }
      return {
        title: title.trim(),
        description: description.trim(),
        fileUrl: fileUrl.trim(),
      };
    },
  },
];

let currentUser = null;
const manageState = {};

function canManageItem(item) {
  if (!currentUser) {
    return false;
  }
  if (currentUser.role === "admin") {
    return true;
  }
  return item.created_by === currentUser.username;
}

function bindManageActions(config) {
  const root = document.getElementById(config.listId);
  if (!root) {
    return;
  }

  root.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const button = target.closest("button[data-action]");
    if (!button) {
      return;
    }

    const itemId = Number.parseInt(button.dataset.id || "", 10);
    const itemMap = manageState[config.key] || new Map();
    const item = itemMap.get(itemId);
    if (!item) {
      return;
    }

    const action = button.dataset.action;
    if (action === "edit") {
      const payload = config.buildEditPayload(item);
      if (!payload) {
        return;
      }
      const loadingToast = window.showToast
        ? window.showToast("Updating item...", { type: "loading", sticky: true })
        : null;
      setButtonBusy(button, true, "Updating...");
      setStatus(config.statusId, "Updating...", false);
      try {
        await requestJson(`${config.endpoint}/${itemId}`, { method: "PUT", payload });
        setStatus(config.statusId, "Updated successfully.", false);
        if (window.showToast) {
          window.showToast("Updated successfully.", { type: "success" });
        }
        await loadManageData();
      } catch (err) {
        setStatus(config.statusId, err.message, true);
        if (window.showToast) {
          window.showToast(err.message || "Update failed.", { type: "error" });
        }
      } finally {
        setButtonBusy(button, false, "");
        if (loadingToast) {
          loadingToast.close();
        }
      }
      return;
    }

    if (action === "delete") {
      const confirmed = window.confirm("Delete this item?");
      if (!confirmed) {
        return;
      }
      const loadingToast = window.showToast
        ? window.showToast("Deleting item...", { type: "loading", sticky: true })
        : null;
      setButtonBusy(button, true, "Deleting...");
      setStatus(config.statusId, "Deleting...", false);
      try {
        await requestJson(`${config.endpoint}/${itemId}`, { method: "DELETE" });
        setStatus(config.statusId, "Deleted successfully.", false);
        if (window.showToast) {
          window.showToast("Deleted successfully.", { type: "success" });
        }
        await loadManageData();
      } catch (err) {
        setStatus(config.statusId, err.message, true);
        if (window.showToast) {
          window.showToast(err.message || "Delete failed.", { type: "error" });
        }
      } finally {
        setButtonBusy(button, false, "");
        if (loadingToast) {
          loadingToast.close();
        }
      }
    }
  });
}

function renderManageList(config, items) {
  const root = document.getElementById(config.listId);
  if (!root) {
    return;
  }

  const manageableItems = items.filter(canManageItem);
  manageState[config.key] = new Map(manageableItems.map((item) => [item.id, item]));

  if (!manageableItems.length) {
    root.innerHTML = `<p>${escapeHtml(config.emptyText)}</p>`;
    return;
  }

  root.innerHTML = manageableItems
    .map(
      (item) => `
      <article class="update">
        <h4>${escapeHtml(item.title || "(untitled)")}</h4>
        ${config.renderDetails(item)}
        <p style="margin-top: 0.6rem;">
          <button class="btn btn-secondary" type="button" data-action="edit" data-id="${item.id}">Edit</button>
          <button class="btn" type="button" data-action="delete" data-id="${item.id}" style="background:#b42318;">Delete</button>
        </p>
      </article>
    `
    )
    .join("");
}

async function loadManageData() {
  if (!currentUser) {
    return;
  }
  try {
    const payloads = await Promise.all(
      manageConfigs.map((config) => requestJson(config.endpoint, { method: "GET" }))
    );
    payloads.forEach((items, index) => {
      renderManageList(manageConfigs[index], Array.isArray(items) ? items : []);
    });
  } catch (_err) {
    manageConfigs.forEach((config) => {
      setStatus(config.statusId, "Could not load content.", true);
    });
    if (window.showToast) {
      window.showToast("Could not refresh managed content.", { type: "error" });
    }
  }
}

async function loadCurrentUser() {
  try {
    currentUser = await requestJson("/api/me", { method: "GET" });
  } catch (_err) {
    currentUser = null;
  }
}

async function submitJson(url, payload) {
  await requestJson(url, { method: "POST", payload });
}

async function submitFormData(url, formData) {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    body: formData,
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

function isLecturerPageActive() {
  const page = String(document.body?.dataset?.page || "")
    .trim()
    .toLowerCase();
  if (page === "lecturer") {
    return true;
  }
  const pathname = String(window.location.pathname || "")
    .trim()
    .toLowerCase();
  return pathname === "/lecturer" || pathname === "/teacher" || pathname === "/lecturer.html" || pathname === "/teacher.html";
}

function initLecturerPage() {
  if (!isLecturerPageActive()) {
    return;
  }
  const root = document.querySelector("main.container");
  if (root instanceof HTMLElement) {
    if (root.dataset.lecturerInitialized === "1") {
      return;
    }
    root.dataset.lecturerInitialized = "1";
  }

  const notificationForm = document.getElementById("notificationForm");
  if (notificationForm) {
    notificationForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitButton = notificationForm.querySelector('button[type="submit"]');
      const loadingToast = window.showToast
        ? window.showToast("Publishing notification...", { type: "loading", sticky: true })
        : null;
      setButtonBusy(submitButton, true, "Publishing...");
      setStatus("notificationStatus", "Publishing...", false);

      const payload = {
        title: document.getElementById("notificationTitle").value.trim(),
        category: document.getElementById("notificationCategory").value.trim(),
        body: document.getElementById("notificationBody").value.trim(),
        isUrgent: document.getElementById("notificationUrgent").checked,
        isPinned: document.getElementById("notificationPinned").checked,
      };

      try {
        await submitJson("/api/notifications", payload);
        notificationForm.reset();
        document.getElementById("notificationCategory").value = "General";
        document.getElementById("notificationPinned").checked = false;
        setStatus("notificationStatus", "Notification published.", false);
        if (window.showToast) {
          window.showToast("Notification published.", { type: "success" });
        }
        await loadManageData();
      } catch (err) {
        setStatus("notificationStatus", err.message, true);
        if (window.showToast) {
          window.showToast(err.message || "Could not publish notification.", { type: "error" });
        }
      } finally {
        setButtonBusy(submitButton, false, "");
        if (loadingToast) {
          loadingToast.close();
        }
      }
    });
  }

  const handoutForm = document.getElementById("handoutForm");
  if (handoutForm) {
    handoutForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitButton = handoutForm.querySelector('button[type="submit"]');
      const loadingToast = window.showToast
        ? window.showToast("Saving handout...", { type: "loading", sticky: true })
        : null;
      setButtonBusy(submitButton, true, "Saving...");
      setStatus("handoutStatus", "Saving...", false);

      const fileInput = document.getElementById("handoutFileInput");
      const selectedFile = fileInput && fileInput.files ? fileInput.files[0] : null;
      if (!selectedFile) {
        setStatus("handoutStatus", "Please select a handout file.", true);
        if (window.showToast) {
          window.showToast("Please select a handout file.", { type: "error" });
        }
        setButtonBusy(submitButton, false, "");
        if (loadingToast) {
          loadingToast.close();
        }
        return;
      }

      const formData = new FormData();
      formData.append("title", document.getElementById("handoutTitle").value.trim());
      formData.append("description", document.getElementById("handoutDescription").value.trim());
      formData.append("file", selectedFile);

      try {
        await submitFormData("/api/handouts", formData);
        handoutForm.reset();
        setStatus("handoutStatus", "Handout saved.", false);
        if (window.showToast) {
          window.showToast("Handout saved.", { type: "success" });
        }
        await loadManageData();
      } catch (err) {
        setStatus("handoutStatus", err.message, true);
        if (window.showToast) {
          window.showToast(err.message || "Could not save handout.", { type: "error" });
        }
      } finally {
        setButtonBusy(submitButton, false, "");
        if (loadingToast) {
          loadingToast.close();
        }
      }
    });
  }

  const sharedFileForm = document.getElementById("sharedFileForm");
  if (sharedFileForm) {
    sharedFileForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitButton = sharedFileForm.querySelector('button[type="submit"]');
      const loadingToast = window.showToast
        ? window.showToast("Publishing file...", { type: "loading", sticky: true })
        : null;
      setButtonBusy(submitButton, true, "Publishing...");
      setStatus("sharedFileStatus", "Publishing...", false);

      const fileInput = document.getElementById("sharedFileInput");
      const selectedFile = fileInput && fileInput.files ? fileInput.files[0] : null;
      if (!selectedFile) {
        setStatus("sharedFileStatus", "Please select a shared file.", true);
        if (window.showToast) {
          window.showToast("Please select a shared file.", { type: "error" });
        }
        setButtonBusy(submitButton, false, "");
        if (loadingToast) {
          loadingToast.close();
        }
        return;
      }

      const formData = new FormData();
      formData.append("title", document.getElementById("sharedFileTitle").value.trim());
      formData.append("description", document.getElementById("sharedFileDescription").value.trim());
      formData.append("file", selectedFile);

      try {
        await submitFormData("/api/shared-files", formData);
        sharedFileForm.reset();
        setStatus("sharedFileStatus", "Shared file published.", false);
        if (window.showToast) {
          window.showToast("Shared file published.", { type: "success" });
        }
        await loadManageData();
      } catch (err) {
        setStatus("sharedFileStatus", err.message, true);
        if (window.showToast) {
          window.showToast(err.message || "Could not publish file.", { type: "error" });
        }
      } finally {
        setButtonBusy(submitButton, false, "");
        if (loadingToast) {
          loadingToast.close();
        }
      }
      });
  }

  const marksForm = document.getElementById("marksForm");
  if (marksForm) {
    marksForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitButton = marksForm.querySelector('button[type="submit"]');
      const payload = {
        studentUsername: document.getElementById("marksStudentUsername").value.trim(),
        courseCode: document.getElementById("marksCourseCode").value.trim(),
        courseTitle: document.getElementById("marksCourseTitle").value.trim(),
        assessmentTitle: document.getElementById("marksAssessmentTitle").value.trim(),
        score: document.getElementById("marksScore").value.trim(),
        maxScore: document.getElementById("marksMaxScore").value.trim(),
        note: document.getElementById("marksNote").value.trim(),
      };
      const loadingToast = window.showToast
        ? window.showToast("Submitting marks for review...", { type: "loading", sticky: true })
        : null;
      setButtonBusy(submitButton, true, "Submitting...");
      setStatus("marksStatus", "Submitting marks for admin review...", false);

      try {
        await requestJson("/api/lecturer/marks-submissions", {
          method: "POST",
          payload,
        });
        marksForm.reset();
        document.getElementById("marksMaxScore").value = "100";
        setStatus("marksStatus", "Marks submitted and waiting for admin review.", false);
        if (window.showToast) {
          window.showToast("Marks submitted for admin review.", { type: "success" });
        }
        await loadLecturerMarkSubmissions();
      } catch (err) {
        setStatus("marksStatus", err.message || "Could not submit marks.", true);
        if (window.showToast) {
          window.showToast(err.message || "Could not submit marks.", { type: "error" });
        }
      } finally {
        setButtonBusy(submitButton, false, "");
        if (loadingToast) {
          loadingToast.close();
        }
      }
    });
  }

  const payoutRequestForm = document.getElementById("lecturerPayoutRequestForm");
  if (payoutRequestForm) {
    payoutRequestForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitButton = payoutRequestForm.querySelector('button[type="submit"]');
      const amountInput = document.getElementById("lecturerPayoutAmount");
      const amount = String(amountInput?.value || "").trim();
      const payload = amount ? { amount } : {};
      const loadingToast = window.showToast
        ? window.showToast("Submitting payout request...", { type: "loading", sticky: true })
        : null;
      setButtonBusy(submitButton, true, "Requesting...");
      setPayoutMessage("lecturerPayoutStatus", "Submitting payout request...");

      try {
        const response = await requestJson("/api/lecturer/payout-request", {
          method: "POST",
          payload,
        });
        if (window.showToast) {
          window.showToast("Payout request submitted.", { type: "success" });
        }
        setPayoutMessage(
          "lecturerPayoutStatus",
          response?.activeTransfer?.status === "queued"
            ? "Payout request queued for processing."
            : "Payout request processed."
        );
        if (amountInput) {
          amountInput.value = "";
        }
        await loadLecturerPayoutData();
      } catch (err) {
        setPayoutMessage("lecturerPayoutStatus", err.message || "Could not request payout.", true);
        if (window.showToast) {
          window.showToast(err.message || "Could not request payout.", { type: "error" });
        }
      } finally {
        setButtonBusy(submitButton, false, "");
        if (loadingToast) {
          loadingToast.close();
        }
      }
    });
  }

  manageConfigs.forEach(bindManageActions);
  loadCurrentUser().then(async () => {
    await Promise.all([loadManageData(), loadLecturerPayoutData(), loadLecturerMarkSubmissions()]);
  });
}

window.initLecturerPage = initLecturerPage;
initLecturerPage();
