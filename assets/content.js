function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value || "-";
  }
  return date.toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function showContentError(message) {
  const node = document.getElementById("contentError");
  if (!node) {
    return;
  }
  node.textContent = message;
  node.hidden = false;
}

function renderNotifications(items) {
  const root = document.getElementById("notificationsList");
  if (!root) {
    return;
  }

  root.innerHTML = "";
  if (!items.length) {
    root.innerHTML = '<article class="card"><p>No notifications have been posted yet.</p></article>';
    return;
  }

  items.forEach((item) => {
    const article = document.createElement("article");
    article.className = item.is_urgent ? "card update urgent" : "card update";
    article.innerHTML = `
      <p class="tag">${escapeHtml(item.category || "General")}</p>
      <h2>${escapeHtml(item.title)}</h2>
      <p>${escapeHtml(item.body)}</p>
      <small>Posted by: ${escapeHtml(item.created_by)} &bull; ${escapeHtml(formatDate(item.created_at))}</small>
    `;
    root.appendChild(article);
  });
}

function renderHandouts(items) {
  const root = document.getElementById("handoutsList");
  if (!root) {
    return;
  }

  root.innerHTML = "";
  if (!items.length) {
    root.innerHTML = '<article class="card"><p>No handouts have been uploaded yet.</p></article>';
    return;
  }

  items.forEach((item) => {
    const article = document.createElement("article");
    article.className = "card handout";
    const linkText = item.file_url ? "Open File" : "File not attached";
    const href = item.file_url || "#";
    article.innerHTML = `
      <h2>${escapeHtml(item.title)}</h2>
      <p>${escapeHtml(item.description)}</p>
      <a href="${escapeHtml(href)}" class="text-link" ${item.file_url ? 'target="_blank" rel="noopener noreferrer"' : ""}>${escapeHtml(linkText)}</a>
      <p><small>Uploaded by: ${escapeHtml(item.created_by)} &bull; ${escapeHtml(formatDate(item.created_at))}</small></p>
    `;
    root.appendChild(article);
  });
}

function renderPaymentLinks(items) {
  const root = document.getElementById("paymentLinksList");
  if (!root) {
    return;
  }

  root.innerHTML = "";
  if (!items.length) {
    root.innerHTML = "<p>No payment links posted yet.</p>";
    return;
  }

  items.forEach((item) => {
    const article = document.createElement("article");
    article.className = "update";
    article.innerHTML = `
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.description)}</p>
      <a href="${escapeHtml(item.payment_url)}" class="text-link" target="_blank" rel="noopener noreferrer">Open Payment Link</a>
      <p><small>Posted by: ${escapeHtml(item.created_by)} &bull; ${escapeHtml(formatDate(item.created_at))}</small></p>
    `;
    root.appendChild(article);
  });
}

function renderSharedFiles(items) {
  const root = document.getElementById("sharedFilesList");
  if (!root) {
    return;
  }

  root.innerHTML = "";
  if (!items.length) {
    root.innerHTML = "<p>No shared files posted yet.</p>";
    return;
  }

  items.forEach((item) => {
    const article = document.createElement("article");
    article.className = "update";
    article.innerHTML = `
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.description)}</p>
      <a href="${escapeHtml(item.file_url)}" class="text-link" target="_blank" rel="noopener noreferrer">Open File</a>
      <p><small>Uploaded by: ${escapeHtml(item.created_by)} &bull; ${escapeHtml(formatDate(item.created_at))}</small></p>
    `;
    root.appendChild(article);
  });
}

function renderHomeNotifications(items) {
  const root = document.getElementById("homeNotificationsList");
  if (!root) {
    return;
  }

  root.innerHTML = "";
  if (!items.length) {
    root.innerHTML = "<p>No notifications posted yet.</p>";
    return;
  }

  items.forEach((item) => {
    const article = document.createElement("article");
    article.className = item.is_urgent ? "update urgent" : "update";
    article.innerHTML = `
      <p class="tag">${escapeHtml(item.category || "General")}</p>
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.body)}</p>
      <p><small>${escapeHtml(formatDate(item.created_at))}</small></p>
    `;
    root.appendChild(article);
  });
}

function renderHomeHandouts(items) {
  const root = document.getElementById("homeHandoutsList");
  if (!root) {
    return;
  }

  root.innerHTML = "";
  if (!items.length) {
    root.innerHTML = "<p>No handout files posted yet.</p>";
    return;
  }

  items.forEach((item) => {
    const article = document.createElement("article");
    article.className = "update";
    article.innerHTML = `
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.description)}</p>
      <a href="${escapeHtml(item.file_url || "#")}" class="text-link" ${item.file_url ? 'target="_blank" rel="noopener noreferrer"' : ""}>${escapeHtml(item.file_url ? "Open Handout" : "File not attached")}</a>
      <p><small>${escapeHtml(formatDate(item.created_at))}</small></p>
    `;
    root.appendChild(article);
  });
}

async function loadContent() {
  const page = document.body.dataset.page;
  if (!page) {
    return;
  }

  try {
    if (page === "notifications") {
      const res = await fetch("/api/notifications", { credentials: "same-origin" });
      if (!res.ok) {
        throw new Error("notifications");
      }
      const items = await res.json();
      renderNotifications(items);
      return;
    }

    if (page === "handouts") {
      const res = await fetch("/api/handouts", { credentials: "same-origin" });
      if (!res.ok) {
        throw new Error("handouts");
      }
      const items = await res.json();
      renderHandouts(items);
      return;
    }

    if (page === "home") {
      const [notificationsRes, paymentLinksRes, sharedFilesRes, handoutsRes] = await Promise.all([
        fetch("/api/notifications", { credentials: "same-origin" }),
        fetch("/api/payment-links", { credentials: "same-origin" }),
        fetch("/api/shared-files", { credentials: "same-origin" }),
        fetch("/api/handouts", { credentials: "same-origin" }),
      ]);

      if (!notificationsRes.ok || !paymentLinksRes.ok || !sharedFilesRes.ok || !handoutsRes.ok) {
        throw new Error("home");
      }

      const notifications = await notificationsRes.json();
      const paymentLinks = await paymentLinksRes.json();
      const sharedFiles = await sharedFilesRes.json();
      const handouts = await handoutsRes.json();

      renderHomeNotifications(notifications.slice(0, 4));
      renderPaymentLinks(paymentLinks.slice(0, 4));
      renderSharedFiles(sharedFiles.slice(0, 4));
      renderHomeHandouts(handouts.slice(0, 4));
    }
  } catch (_err) {
    showContentError("Could not load content right now. Please refresh.");
  }
}

loadContent();
