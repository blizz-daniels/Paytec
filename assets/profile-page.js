function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeRoleLabel(role) {
  const normalized = String(role || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return "Member";
  }
  if (normalized === "teacher") {
    return "Lecturer";
  }
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

function setError(message) {
  const node = document.getElementById("profilePageError");
  if (!node) {
    return;
  }
  if (!message) {
    node.hidden = true;
    node.textContent = "";
    return;
  }
  node.hidden = false;
  node.textContent = String(message);
}

function setChecklistStatus(message, isError = false) {
  const node = document.getElementById("checklistStatus");
  if (!node) {
    return;
  }
  node.textContent = String(message || "");
  node.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function setPasswordStatus(message, isError = false) {
  const node = document.getElementById("passwordStatus");
  if (!node) {
    return;
  }
  node.textContent = String(message || "");
  node.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function updateProfileAvatar(imageUrl, fallbackName) {
  const imageEl = document.querySelector("[data-profile-image]");
  const initialEl = document.querySelector("[data-profile-initial]");
  if (!imageEl || !initialEl) {
    return;
  }
  const firstLetter = String(fallbackName || "")
    .trim()
    .charAt(0)
    .toUpperCase();
  if (imageUrl) {
    imageEl.src = imageUrl;
    imageEl.hidden = false;
    initialEl.hidden = true;
    return;
  }
  imageEl.hidden = true;
  initialEl.hidden = false;
  initialEl.textContent = firstLetter || "?";
}

async function requestJson(url, { method = "GET", payload, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: payload ? { "Content-Type": "application/json" } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
      signal: controller.signal,
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
    return data || {};
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error("Request timed out. Please try again.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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

function setPayoutMessage(nodeId, message, isError = false) {
  const node = document.getElementById(nodeId);
  if (!node) {
    return;
  }
  node.textContent = String(message || "");
  node.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function normalizePayoutBadge(summary, account) {
  if (!account) {
    return { text: "Not linked", className: "status-badge status-badge--warning" };
  }
  if (Number(account.review_required || 0) === 1 || String(account.recipient_status || "").toLowerCase() !== "active") {
    return { text: "Needs review", className: "status-badge status-badge--error" };
  }
  if (Number(summary?.availableBalance || 0) > 0) {
    return { text: "Ready", className: "status-badge status-badge--success" };
  }
  return { text: "Linked", className: "status-badge" };
}

function renderPayoutStats(root, summary) {
  if (!root) {
    return;
  }
  const stats = [
    { label: "Total earned", value: formatMoney(summary?.totalEarned || 0) },
    { label: "Pending payout", value: formatMoney(summary?.pendingBalance || 0) },
    { label: "Available", value: formatMoney(summary?.availableBalance || 0) },
    { label: "Paid out", value: formatMoney(summary?.paidBalance || 0) },
  ];
  root.innerHTML = stats
    .map(
      (stat) => `
        <article class="payout-stat">
          <span class="payout-stat__label">${escapeHtml(stat.label)}</span>
          <strong class="payout-stat__value">${escapeHtml(stat.value)}</strong>
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
        <p>Enter your payout bank details below to activate lecturer payouts.</p>
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

function updateProfilePayoutForm(account) {
  const bankName = document.getElementById("profilePayoutBankName");
  const bankCode = document.getElementById("profilePayoutBankCode");
  const accountName = document.getElementById("profilePayoutAccountName");
  const accountNumber = document.getElementById("profilePayoutAccountNumber");
  const autoEnabled = document.getElementById("profilePayoutAutoEnabled");
  if (bankName) {
    bankName.value = "";
    bankName.placeholder = account?.bank_name || "Bank name";
  }
  if (bankCode) {
    bankCode.value = "";
    bankCode.placeholder = account?.bank_code || "Bank code";
  }
  if (accountName) {
    accountName.value = "";
    accountName.placeholder = account?.account_name || "Account name";
  }
  if (accountNumber) {
    accountNumber.value = "";
    accountNumber.placeholder = account ? "Enter a new account number to replace the linked bank account" : "Enter your account number";
  }
  if (autoEnabled) {
    autoEnabled.checked = Number(account?.auto_payout_enabled ?? 1) === 1;
  }
}

async function loadProfilePayoutData() {
  const section = document.getElementById("profilePayoutSection");
  const statsRoot = document.getElementById("profilePayoutStats");
  const accountRoot = document.getElementById("profilePayoutAccount");
  const historyRoot = document.getElementById("profilePayoutHistoryBody");
  const badge = document.getElementById("profilePayoutBadge");
  if (!section || !statsRoot || !accountRoot || !historyRoot) {
    return;
  }

  const me = window.__profilePageUser || null;
  const role = String(me?.role || "").trim().toLowerCase();
  if (role !== "teacher" && role !== "admin") {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  setPayoutMessage("profilePayoutStatus", "Loading payout information...");
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
    updateProfilePayoutForm(account);

    const badgeState = normalizePayoutBadge(summary, account);
    if (badge) {
      badge.className = badgeState.className;
      badge.textContent = badgeState.text;
    }
    setPayoutMessage(
      "profilePayoutStatus",
      account
        ? `Available payout balance is ${formatMoney(summary.availableBalance || 0)}.`
        : "Add a bank account to enable lecturer payouts."
    );
  } catch (err) {
    setPayoutMessage("profilePayoutStatus", err.message || "Could not load payout information.", true);
    if (badge) {
      badge.className = "status-badge status-badge--error";
      badge.textContent = "Error";
    }
    renderPayoutStats(statsRoot, {});
    accountRoot.innerHTML = '<p class="auth-subtitle">Could not load payout account details.</p>';
    historyRoot.innerHTML = '<tr><td colspan="5">Could not load payout history.</td></tr>';
  }
}

function renderChecklist(items, meRole) {
  const root = document.getElementById("departmentChecklistList");
  if (!root) {
    return;
  }
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) {
    root.innerHTML = '<p class="auth-subtitle">No checklist has been uploaded for your department yet.</p>';
    return;
  }

  root.innerHTML = rows
    .map((item) => {
      const checked = item.completed ? "checked" : "";
      const completedAt = item.completed_at ? new Date(item.completed_at).toLocaleString() : "";
      const completedText = completedAt ? `Completed: ${escapeHtml(completedAt)}` : "Not completed";
      const disabled = meRole === "student" ? "" : "disabled";
      return `
        <article class="profile-checklist-item">
          <label class="profile-checklist-item__label">
            <input type="checkbox" data-checklist-id="${Number(item.id || 0)}" ${checked} ${disabled} />
            <span>${escapeHtml(item.item_text || "")}</span>
          </label>
          <small>${escapeHtml(completedText)}</small>
        </article>
      `;
    })
    .join("");
}

function configurePasswordForm(me) {
  const passwordForm = document.getElementById("profilePasswordForm");
  if (!passwordForm) {
    return;
  }
  const role = String(me?.role || "")
    .trim()
    .toLowerCase();
  const isStudent = role === "student";
  const canSetOneTimeStrongPassword = !!me?.canSetOneTimeStrongPassword;
  const submitButton = passwordForm.querySelector('button[type="submit"]');
  const currentPasswordLabel = passwordForm.querySelector('label[for="profileCurrentPassword"]');

  if (isStudent && !canSetOneTimeStrongPassword) {
    passwordForm.hidden = true;
    setPasswordStatus(
      "You already used your one-time stronger password setup. Use Forgot Password for email OTP reset.",
      false
    );
    return;
  }

  passwordForm.hidden = false;
  if (currentPasswordLabel) {
    currentPasswordLabel.textContent = isStudent ? "Current password (surname)" : "Current password";
  }
  if (submitButton instanceof HTMLButtonElement) {
    const label = isStudent ? "Create stronger password" : "Update password";
    submitButton.textContent = label;
    submitButton.dataset.defaultLabel = label;
  }
  setPasswordStatus(isStudent ? "Create your stronger password once." : "Update your password.", false);
}

async function loadProfilePage() {
  try {
    setError("");
    setChecklistStatus("Loading checklist...");
    const [me, checklistPayload] = await Promise.all([
      requestJson("/api/me"),
      requestJson("/api/profile/checklist"),
    ]);
    window.__profilePageUser = me;

    const profileName = document.getElementById("profilePageName");
    const profileUsername = document.getElementById("profilePageUsername");
    const profileRole = document.getElementById("profilePageRole");
    const profileDepartment = document.getElementById("profilePageDepartment");
    const profileEmail = document.getElementById("profilePageEmail");

    if (profileName) {
      profileName.textContent = me.displayName || me.username || "-";
    }
    if (profileUsername) {
      profileUsername.textContent = me.username || "-";
    }
    if (profileRole) {
      profileRole.textContent = normalizeRoleLabel(me.role);
    }
    if (profileDepartment) {
      profileDepartment.textContent = me.departmentLabel || me.department || "-";
    }
    if (profileEmail) {
      profileEmail.textContent = me.email || "-";
    }
    updateProfileAvatar(me.profileImageUrl || "", me.displayName || me.username || "");

    const payoutSection = document.getElementById("profilePayoutSection");
    if (payoutSection) {
      const role = String(me.role || "").trim().toLowerCase();
      payoutSection.hidden = !(role === "teacher" || role === "admin");
    }

    renderChecklist(checklistPayload.items || [], me.role);
    if (me.role === "student") {
      setChecklistStatus("Tick each task only after it is done.");
    } else {
      setChecklistStatus("Checklist viewing mode.");
    }
    configurePasswordForm(me);

    const payoutForm = document.getElementById("profilePayoutForm");
    if (payoutForm && payoutForm.dataset.bound !== "1") {
      payoutForm.dataset.bound = "1";
      payoutForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (payoutSection && payoutSection.hidden) {
          return;
        }
        const submitButton = payoutForm.querySelector('button[type="submit"]');
        const payload = {
          bankName: String(document.getElementById("profilePayoutBankName")?.value || "").trim(),
          bankCode: String(document.getElementById("profilePayoutBankCode")?.value || "").trim(),
          accountName: String(document.getElementById("profilePayoutAccountName")?.value || "").trim(),
          accountNumber: String(document.getElementById("profilePayoutAccountNumber")?.value || "").trim(),
          autoPayoutEnabled: !!document.getElementById("profilePayoutAutoEnabled")?.checked,
        };
        const loadingToast = window.showToast
          ? window.showToast("Saving payout account...", { type: "loading", sticky: true })
          : null;
        if (submitButton instanceof HTMLButtonElement) {
          submitButton.disabled = true;
          submitButton.textContent = "Saving...";
        }
        setPayoutMessage("profilePayoutStatus", "Saving payout account...");
        try {
          await requestJson("/api/lecturer/payout-account", {
            method: "POST",
            payload,
          });
          const savedMessage = payload.accountNumber
            ? "Payout account saved and sent for admin review."
            : "Payout account preferences updated successfully.";
          setPayoutMessage("profilePayoutStatus", savedMessage);
          if (window.showToast) {
            window.showToast(savedMessage, { type: "success" });
          }
          await loadProfilePayoutData();
        } catch (err) {
          setPayoutMessage("profilePayoutStatus", err.message || "Could not save payout account.", true);
          if (window.showToast) {
            window.showToast(err.message || "Could not save payout account.", { type: "error" });
          }
        } finally {
          if (submitButton instanceof HTMLButtonElement) {
            submitButton.disabled = false;
            submitButton.textContent = "Save payout account";
          }
          if (loadingToast) {
            loadingToast.close();
          }
        }
      });
    }

    const checklistRoot = document.getElementById("departmentChecklistList");
    if (checklistRoot && me.role === "student" && checklistRoot.dataset.bound !== "1") {
      checklistRoot.dataset.bound = "1";
      checklistRoot.addEventListener("change", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") {
          return;
        }
        const checklistId = Number.parseInt(target.dataset.checklistId || "", 10);
        if (!Number.isFinite(checklistId) || checklistId <= 0) {
          return;
        }
        const checked = !!target.checked;
        target.disabled = true;
        setChecklistStatus("Updating checklist...");
        try {
          await requestJson(`/api/profile/checklist/${checklistId}/toggle`, {
            method: "POST",
            payload: { completed: checked },
          });
          if (window.showToast) {
            window.showToast("Checklist updated.", { type: "success" });
          }
          await loadProfilePage();
        } catch (err) {
          target.checked = !checked;
          setChecklistStatus(err.message || "Could not update checklist.", true);
          if (window.showToast) {
            window.showToast(err.message || "Could not update checklist.", { type: "error" });
          }
          target.disabled = false;
          }
        });
    }

    await loadProfilePayoutData();

    const passwordForm = document.getElementById("profilePasswordForm");
    if (passwordForm && passwordForm.dataset.bound !== "1") {
      passwordForm.dataset.bound = "1";
      passwordForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (passwordForm.hidden) {
          return;
        }
        const currentPassword = String(document.getElementById("profileCurrentPassword")?.value || "");
        const newPassword = String(document.getElementById("profileNewPassword")?.value || "");
        const confirmPassword = String(document.getElementById("profileConfirmPassword")?.value || "");
        if (!currentPassword || !newPassword || !confirmPassword) {
          setPasswordStatus("All password fields are required.", true);
          return;
        }
        const payload = {
          currentPassword,
          newPassword,
          confirmPassword,
        };
        const submitButton = passwordForm.querySelector('button[type="submit"]');
        if (submitButton instanceof HTMLButtonElement) {
          submitButton.disabled = true;
          submitButton.textContent = "Saving...";
        }
        setPasswordStatus("Saving password...", false);
        try {
          await requestJson("/api/profile/password", {
            method: "POST",
            payload,
          });
          passwordForm.reset();
          setPasswordStatus("Password saved successfully.", false);
          if (window.showToast) {
            window.showToast("Password saved.", { type: "success" });
          }
          await loadProfilePage();
        } catch (err) {
          setPasswordStatus(err.message || "Could not update password.", true);
          if (window.showToast) {
            window.showToast(err.message || "Could not update password.", { type: "error" });
          }
        } finally {
          if (submitButton instanceof HTMLButtonElement) {
            submitButton.disabled = false;
            submitButton.textContent = submitButton.dataset.defaultLabel || "Update password";
          }
        }
      });
    }
  } catch (err) {
    setError(err.message || "Could not load profile page.");
    setChecklistStatus("", false);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  loadProfilePage();
});
