function setStatus(id, message, isError) {
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
        <small>${escapeHtml(item.category || "General")} | Urgent: ${item.is_urgent ? "Yes" : "No"} | By ${escapeHtml(item.created_by || "-")}</small>
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
      return {
        title: title.trim(),
        category: category.trim(),
        body: body.trim(),
        isUrgent: /^(yes|y|true|1)$/i.test(urgentInput.trim()),
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
      setStatus(config.statusId, "Updating...", false);
      try {
        await requestJson(`${config.endpoint}/${itemId}`, { method: "PUT", payload });
        setStatus(config.statusId, "Updated successfully.", false);
        await loadManageData();
      } catch (err) {
        setStatus(config.statusId, err.message, true);
      }
      return;
    }

    if (action === "delete") {
      const confirmed = window.confirm("Delete this item?");
      if (!confirmed) {
        return;
      }
      setStatus(config.statusId, "Deleting...", false);
      try {
        await requestJson(`${config.endpoint}/${itemId}`, { method: "DELETE" });
        setStatus(config.statusId, "Deleted successfully.", false);
        await loadManageData();
      } catch (err) {
        setStatus(config.statusId, err.message, true);
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
    setStatus("notificationStatus", "Publishing...", false);

    const payload = {
      title: document.getElementById("notificationTitle").value.trim(),
      category: document.getElementById("notificationCategory").value.trim(),
      body: document.getElementById("notificationBody").value.trim(),
      isUrgent: document.getElementById("notificationUrgent").checked,
    };

    try {
      await submitJson("/api/notifications", payload);
      notificationForm.reset();
      document.getElementById("notificationCategory").value = "General";
      setStatus("notificationStatus", "Notification published.", false);
      await loadManageData();
    } catch (err) {
      setStatus("notificationStatus", err.message, true);
    }
  });
}

const handoutForm = document.getElementById("handoutForm");
if (handoutForm) {
  handoutForm.addEventListener("submit", async (event) => {
    event.preventDefault();
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
      await loadManageData();
    } catch (err) {
      setStatus("handoutStatus", err.message, true);
    }
  });
}

const paymentForm = document.getElementById("paymentForm");
if (paymentForm) {
  paymentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
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
      await loadManageData();
    } catch (err) {
      setStatus("paymentStatus", err.message, true);
    }
  });
}

const sharedFileForm = document.getElementById("sharedFileForm");
if (sharedFileForm) {
  sharedFileForm.addEventListener("submit", async (event) => {
    event.preventDefault();
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
      await loadManageData();
    } catch (err) {
      setStatus("sharedFileStatus", err.message, true);
    }
  });
}

manageConfigs.forEach(bindManageActions);
loadCurrentUser().then(loadManageData);
