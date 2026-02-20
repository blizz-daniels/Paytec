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

const manageConfigs = [
  {
    key: "notifications",
    endpoint: "/api/notifications",
    listId: "manageNotificationList",
    statusId: "manageNotificationStatus",
    emptyText: "No notifications to manage yet.",
    renderDetails(item) {
      return `
        <p>${escapeHtml(item.body || "")}</p>
        <small>${escapeHtml(item.category || "General")} | Urgent: ${item.is_urgent ? "Yes" : "No"} | Pinned: ${item.is_pinned ? "Yes" : "No"} | Unread (students): ${Number(item.unread_count || 0)} | By ${escapeHtml(item.created_by || "-")}</small>
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
    key: "payment-links",
    endpoint: "/api/payment-links",
    listId: "managePaymentList",
    statusId: "managePaymentStatus",
    emptyText: "No payment links to manage yet.",
    renderDetails(item) {
      return `
        <p>${escapeHtml(item.description || "")}</p>
        <small>URL: ${escapeHtml(item.payment_url || "-")} | By ${escapeHtml(item.created_by || "-")}</small>
      `;
    },
    buildEditPayload(item) {
      const title = window.prompt("Payment link title:", item.title || "");
      if (title === null) {
        return null;
      }
      const description = window.prompt("Description:", item.description || "");
      if (description === null) {
        return null;
      }
      const paymentUrl = window.prompt("Payment URL:", item.payment_url || "");
      if (paymentUrl === null) {
        return null;
      }
      return {
        title: title.trim(),
        description: description.trim(),
        paymentUrl: paymentUrl.trim(),
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
      return `
        <p>${escapeHtml(item.description || "")}</p>
        <small>URL: ${escapeHtml(item.file_url || "-")} | By ${escapeHtml(item.created_by || "-")}</small>
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
      return `
        <p>${escapeHtml(item.description || "")}</p>
        <small>URL: ${escapeHtml(item.file_url || "(none)")} | By ${escapeHtml(item.created_by || "-")}</small>
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

    const payload = {
      title: document.getElementById("handoutTitle").value.trim(),
      description: document.getElementById("handoutDescription").value.trim(),
      fileUrl: document.getElementById("handoutUrl").value.trim(),
    };

    try {
      await submitJson("/api/handouts", payload);
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

const paymentForm = document.getElementById("paymentForm");
if (paymentForm) {
  paymentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = paymentForm.querySelector('button[type="submit"]');
    const loadingToast = window.showToast
      ? window.showToast("Publishing payment link...", { type: "loading", sticky: true })
      : null;
    setButtonBusy(submitButton, true, "Publishing...");
    setStatus("paymentStatus", "Publishing...", false);

    const payload = {
      title: document.getElementById("paymentTitle").value.trim(),
      description: document.getElementById("paymentDescription").value.trim(),
      paymentUrl: document.getElementById("paymentUrl").value.trim(),
    };

    try {
      await submitJson("/api/payment-links", payload);
      paymentForm.reset();
      setStatus("paymentStatus", "Payment link published.", false);
      if (window.showToast) {
        window.showToast("Payment link published.", { type: "success" });
      }
      await loadManageData();
    } catch (err) {
      setStatus("paymentStatus", err.message, true);
      if (window.showToast) {
        window.showToast(err.message || "Could not publish payment link.", { type: "error" });
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

    const payload = {
      title: document.getElementById("sharedFileTitle").value.trim(),
      description: document.getElementById("sharedFileDescription").value.trim(),
      fileUrl: document.getElementById("sharedFileUrl").value.trim(),
    };

    try {
      await submitJson("/api/shared-files", payload);
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

manageConfigs.forEach(bindManageActions);
loadCurrentUser().then(loadManageData);
