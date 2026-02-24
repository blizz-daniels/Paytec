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

const contentState = {
  user: null,
  data: {
    notifications: [],
    handouts: [],
    sharedFiles: [],
  },
  filters: {
    query: "",
    category: "",
    lecturer: "",
    urgency: "all",
    dateFrom: "",
  },
};

const notificationReactionOptions = [
  { key: "like", emoji: "&#128077;", label: "Like" },
  { key: "love", emoji: "&#10084;&#65039;", label: "Love" },
  { key: "haha", emoji: "&#128518;", label: "Haha" },
  { key: "wow", emoji: "&#128558;", label: "Wow" },
  { key: "sad", emoji: "&#128546;", label: "Sad" },
];

function canMarkRead(item) {
  return !!(contentState.user && contentState.user.role === "student" && !item.is_read);
}

function canReactToContent() {
  return !!contentState.user;
}

function normalizeReactionCounts(value) {
  const source = value && typeof value === "object" ? value : {};
  const counts = {};
  notificationReactionOptions.forEach((option) => {
    counts[option.key] = Number(source[option.key] || 0);
  });
  return counts;
}

function buildReactionBar(item, contentType) {
  if (!canReactToContent()) {
    return "";
  }
  const counts = normalizeReactionCounts(item.reaction_counts);
  const selected = String(item.user_reaction || "").toLowerCase();
  const buttons = notificationReactionOptions
    .map((option) => {
      const count = counts[option.key];
      const isSelected = selected === option.key;
      return `
        <button
          type="button"
          class="reaction-btn${isSelected ? " reaction-btn--active" : ""}"
          data-content-type="${contentType}"
          data-reaction="${option.key}"
          data-id="${item.id}"
          aria-label="${escapeHtml(option.label)} reaction"
        >
          <span class="reaction-btn__emoji" aria-hidden="true">${option.emoji}</span>
          <span class="reaction-btn__count">${count}</span>
        </button>
      `;
    })
    .join("");
  return `<div class="reaction-bar">${buttons}</div>`;
}

function normalizeForFilter(item, type) {
  const typeCategoryMap = {
    notification: "Notification",
    handout: "Handout",
    shared: "Shared File",
  };
  const category = String(item.category || typeCategoryMap[type] || "General").trim();
  const createdBy = String(item.created_by || "").trim();
  const title = String(item.title || "").trim();
  const details = String(item.body || item.description || "").trim();
  const createdAt = String(item.created_at || "").trim();
  const isUrgent = !!item.is_urgent;
  const searchText = `${title} ${details} ${category} ${createdBy}`.toLowerCase();
  return {
    category,
    createdBy,
    createdAt,
    isUrgent,
    searchText,
  };
}

function passesFilters(item, type) {
  const normalized = normalizeForFilter(item, type);
  const { query, category, lecturer, urgency, dateFrom } = contentState.filters;

  if (query && !normalized.searchText.includes(query.toLowerCase())) {
    return false;
  }
  if (category && normalized.category !== category) {
    return false;
  }
  if (lecturer && normalized.createdBy !== lecturer) {
    return false;
  }
  if (urgency === "urgent" && !normalized.isUrgent) {
    return false;
  }
  if (urgency === "not_urgent" && normalized.isUrgent) {
    return false;
  }
  if (dateFrom) {
    const start = new Date(`${dateFrom}T00:00:00`);
    const createdAt = new Date(normalized.createdAt);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(createdAt.getTime()) && createdAt < start) {
      return false;
    }
  }
  return true;
}

function applyFilters(items, type) {
  return items.filter((item) => passesFilters(item, type));
}

function renderNotifications(items) {
  const root = document.getElementById("notificationsList");
  if (!root) {
    return;
  }

  root.innerHTML = "";
  if (!items.length) {
    root.innerHTML = '<article class="card"><p>No notifications match your filters.</p></article>';
    return;
  }

  items.forEach((item) => {
    const article = document.createElement("article");
    const pinnedTag = item.is_pinned ? '<span class="tag tag-pinned">Pinned</span>' : "";
    const readBadge =
      contentState.user && contentState.user.role === "student"
        ? `<span class="${item.is_read ? "tag tag-read" : "tag tag-unread"}">${item.is_read ? "Read" : "Unread"}</span>`
        : "";
    const unreadInfo =
      contentState.user && (contentState.user.role === "teacher" || contentState.user.role === "admin")
        ? `<small>Unread students: ${escapeHtml(String(Number(item.unread_count || 0)))}</small>`
        : "";
    const actionButton = canMarkRead(item)
      ? `<button class="btn btn-secondary mark-read-btn" data-id="${item.id}" type="button">Mark as read</button>`
      : "";
    const reactionBar =
      item && (item.auto_generated || item.related_payment_item_id)
        ? ""
        : buildReactionBar(item, "notification");
    article.className = item.is_urgent ? "card update urgent" : "card update";
    article.innerHTML = `
      <p>${pinnedTag} <span class="tag">${escapeHtml(item.category || "General")}</span> ${readBadge}</p>
      <h2>${escapeHtml(item.title)}</h2>
      <p>${escapeHtml(item.body)}</p>
      ${reactionBar}
      ${unreadInfo}
      ${actionButton}
      <small>Posted by: ${escapeHtml(item.created_by)} &bull; ${escapeHtml(formatDate(item.created_at))}</small>
    `;
    root.appendChild(article);
  });
}

function renderNotificationFeed(notifications, sharedFiles) {
  const root = document.getElementById("notificationsList");
  if (!root) {
    return;
  }

  const feedItems = []
    .concat(
      notifications.map((item) => ({ kind: "notification", created_at: item.created_at, item })),
      sharedFiles.map((item) => ({ kind: "shared", created_at: item.created_at, item }))
    )
    .sort((a, b) => {
      const aTime = new Date(a.created_at || 0).getTime();
      const bTime = new Date(b.created_at || 0).getTime();
      return bTime - aTime;
    });

  root.innerHTML = "";
  if (!feedItems.length) {
    root.innerHTML = '<article class="card"><p>No notifications or shared files match your filters.</p></article>';
    return;
  }

  feedItems.forEach((entry) => {
    if (entry.kind === "notification") {
      const notification = entry.item;
      const article = document.createElement("article");
      const pinnedTag = notification.is_pinned ? '<span class="tag tag-pinned">Pinned</span>' : "";
      const readBadge =
        contentState.user && contentState.user.role === "student"
          ? `<span class="${notification.is_read ? "tag tag-read" : "tag tag-unread"}">${notification.is_read ? "Read" : "Unread"}</span>`
          : "";
      const unreadInfo =
        contentState.user && (contentState.user.role === "teacher" || contentState.user.role === "admin")
          ? `<small>Unread students: ${escapeHtml(String(Number(notification.unread_count || 0)))}</small>`
          : "";
      const actionButton = canMarkRead(notification)
        ? `<button class="btn btn-secondary mark-read-btn" data-id="${notification.id}" type="button">Mark as read</button>`
        : "";
      const reactionBar =
        notification && (notification.auto_generated || notification.related_payment_item_id)
          ? ""
          : buildReactionBar(notification, "notification");
      article.className = notification.is_urgent ? "card update urgent" : "card update";
      article.innerHTML = `
        <p>${pinnedTag} <span class="tag">${escapeHtml(notification.category || "General")}</span> ${readBadge}</p>
        <h2>${escapeHtml(notification.title)}</h2>
        <p>${escapeHtml(notification.body)}</p>
        ${reactionBar}
        ${unreadInfo}
        ${actionButton}
        <small>Posted by: ${escapeHtml(notification.created_by)} &bull; ${escapeHtml(formatDate(notification.created_at))}</small>
      `;
      root.appendChild(article);
      return;
    }

    const shared = entry.item;
    const article = document.createElement("article");
    const reactionBar = buildReactionBar(shared, "shared");
    const fileUrl = String(shared.file_url || "");
    const lowered = fileUrl.toLowerCase();
    let mediaHtml = "";
    if (lowered.endsWith(".png")) {
      mediaHtml = `<img class="post-media" src="${escapeHtml(fileUrl)}" alt="${escapeHtml(shared.title || "Shared image")}" loading="lazy" />`;
    } else if (lowered.endsWith(".mp4") || lowered.endsWith(".webm") || lowered.endsWith(".mov")) {
      mediaHtml = `<video class="post-media" controls preload="metadata" src="${escapeHtml(fileUrl)}"></video>`;
    }
    article.className = "card update";
    article.innerHTML = `
      <p><span class="tag">Shared File</span></p>
      <h2>${escapeHtml(shared.title)}</h2>
      <p>${escapeHtml(shared.description)}</p>
      ${mediaHtml}
      ${reactionBar}
      <a href="${escapeHtml(shared.file_url)}" class="text-link" target="_blank" rel="noopener noreferrer">Open File</a>
      <small>Posted by: ${escapeHtml(shared.created_by)} &bull; ${escapeHtml(formatDate(shared.created_at))}</small>
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
    root.innerHTML = '<article class="card"><p>No handouts match your filters.</p></article>';
    return;
  }

  items.forEach((item) => {
    const article = document.createElement("article");
    article.className = "card handout";
    const linkText = item.file_url ? "Open File" : "File not attached";
    const href = item.file_url || "#";
    const reactionBar = buildReactionBar(item, "handout");
    article.innerHTML = `
      <h2>${escapeHtml(item.title)}</h2>
      <p>${escapeHtml(item.description)}</p>
      ${reactionBar}
      <a href="${escapeHtml(href)}" class="text-link" ${item.file_url ? 'target="_blank" rel="noopener noreferrer"' : ""}>${escapeHtml(linkText)}</a>
      <p><small>Uploaded by: ${escapeHtml(item.created_by)} &bull; ${escapeHtml(formatDate(item.created_at))}</small></p>
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
    root.innerHTML = "<p>No shared files match your filters.</p>";
    return;
  }

  items.forEach((item) => {
    const article = document.createElement("article");
    article.className = "update";
    const reactionBar = buildReactionBar(item, "shared");
    const fileUrl = String(item.file_url || "");
    const lowered = fileUrl.toLowerCase();
    let mediaHtml = "";
    if (lowered.endsWith(".png")) {
      mediaHtml = `<img class="post-media" src="${escapeHtml(fileUrl)}" alt="${escapeHtml(item.title || "Shared image")}" loading="lazy" />`;
    } else if (lowered.endsWith(".mp4") || lowered.endsWith(".webm") || lowered.endsWith(".mov")) {
      mediaHtml = `<video class="post-media" controls preload="metadata" src="${escapeHtml(fileUrl)}"></video>`;
    }
    article.innerHTML = `
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.description)}</p>
      ${mediaHtml}
      ${reactionBar}
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
    root.innerHTML = "<p>No notifications match your filters.</p>";
    return;
  }

  items.forEach((item) => {
    const article = document.createElement("article");
    const pinnedTag = item.is_pinned ? '<span class="tag tag-pinned">Pinned</span> ' : "";
    const reactionBar =
      item && (item.auto_generated || item.related_payment_item_id)
        ? ""
        : buildReactionBar(item, "notification");
    article.className = item.is_urgent ? "update urgent" : "update";
    article.innerHTML = `
      <p>${pinnedTag}<span class="tag">${escapeHtml(item.category || "General")}</span></p>
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.body)}</p>
      ${reactionBar}
      <p><small>Posted by: ${escapeHtml(item.created_by)} &bull; ${escapeHtml(formatDate(item.created_at))}</small></p>
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
    root.innerHTML = "<p>No handout files match your filters.</p>";
    return;
  }

  items.forEach((item) => {
    const article = document.createElement("article");
    const reactionBar = buildReactionBar(item, "handout");
    article.className = "update";
    article.innerHTML = `
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.description)}</p>
      ${reactionBar}
      <a href="${escapeHtml(item.file_url || "#")}" class="text-link" ${item.file_url ? 'target="_blank" rel="noopener noreferrer"' : ""}>${escapeHtml(item.file_url ? "Open Handout" : "File not attached")}</a>
      <p><small>Uploaded by: ${escapeHtml(item.created_by)} &bull; ${escapeHtml(formatDate(item.created_at))}</small></p>
    `;
    root.appendChild(article);
  });
}

async function markNotificationRead(notificationId) {
  const response = await fetch(`/api/notifications/${notificationId}/read`, {
    method: "POST",
    credentials: "same-origin",
  });

  let data = null;
  try {
    data = await response.json();
  } catch (_err) {
    // Keep fallback message.
  }

  if (!response.ok) {
    throw new Error((data && data.error) || "Could not mark notification as read.");
  }
}

function getReactionEndpoint(contentType, itemId) {
  if (contentType === "notification") {
    return `/api/notifications/${itemId}/reaction`;
  }
  if (contentType === "handout") {
    return `/api/handouts/${itemId}/reaction`;
  }
  if (contentType === "shared") {
    return `/api/shared-files/${itemId}/reaction`;
  }
  return "";
}

function getItemByContentType(contentType, itemId) {
  if (contentType === "notification") {
    return contentState.data.notifications.find((item) => Number(item.id) === itemId) || null;
  }
  if (contentType === "handout") {
    return contentState.data.handouts.find((item) => Number(item.id) === itemId) || null;
  }
  if (contentType === "shared") {
    return contentState.data.sharedFiles.find((item) => Number(item.id) === itemId) || null;
  }
  return null;
}

async function reactToContent(contentType, itemId, reaction) {
  const endpoint = getReactionEndpoint(contentType, itemId);
  if (!endpoint) {
    throw new Error("Invalid reaction target.");
  }
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reaction }),
  });

  let data = null;
  try {
    data = await response.json();
  } catch (_err) {
    // Keep fallback message.
  }

  if (!response.ok) {
    throw new Error((data && data.error) || "Could not save reaction.");
  }
}

function bindNotificationReadActions() {
  if (window.__contentActionsBound) {
    return;
  }
  window.__contentActionsBound = true;

  document.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const readButton = target.closest(".mark-read-btn");
    if (readButton) {
      const id = Number.parseInt(readButton.getAttribute("data-id") || "", 10);
      if (!Number.isFinite(id) || id <= 0) {
        return;
      }
      readButton.setAttribute("disabled", "disabled");
      readButton.textContent = "Marking...";
      const loadingToast = window.showToast
        ? window.showToast("Marking notification as read...", { type: "loading", sticky: true })
        : null;
      try {
        await markNotificationRead(id);
        if (window.showToast) {
          window.showToast("Notification marked as read.", { type: "success" });
        }
        await loadContent();
      } catch (err) {
        showContentError(err.message || "Could not update read status.");
        if (window.showToast) {
          window.showToast(err.message || "Could not update read status.", { type: "error" });
        }
        readButton.removeAttribute("disabled");
        readButton.textContent = "Mark as read";
      } finally {
        if (loadingToast) {
          loadingToast.close();
        }
      }
      return;
    }

    const reactionButton = target.closest(".reaction-btn");
    if (!reactionButton) {
      return;
    }
    const id = Number.parseInt(reactionButton.getAttribute("data-id") || "", 10);
    const contentType = String(reactionButton.getAttribute("data-content-type") || "").trim();
    const reaction = String(reactionButton.getAttribute("data-reaction") || "").trim();
    if (!Number.isFinite(id) || id <= 0 || !reaction || !contentType) {
      return;
    }
    const existing = getItemByContentType(contentType, id);
    const currentReaction = String(existing?.user_reaction || "").toLowerCase();
    const nextReaction = currentReaction === reaction ? "" : reaction;
    reactionButton.setAttribute("disabled", "disabled");
    const loadingToast = window.showToast
      ? window.showToast("Saving reaction...", { type: "loading", sticky: true })
      : null;
    try {
      await reactToContent(contentType, id, nextReaction);
      await loadContent();
    } catch (err) {
      showContentError(err.message || "Could not save reaction.");
      if (window.showToast) {
        window.showToast(err.message || "Could not save reaction.", { type: "error" });
      }
    } finally {
      if (loadingToast) {
        loadingToast.close();
      }
    }
  });
}

function getPageSources(page) {
  if (page === "notifications") {
    return [
      { type: "notification", items: contentState.data.notifications },
      { type: "shared", items: contentState.data.sharedFiles },
    ];
  }
  if (page === "handouts") {
    return [{ type: "handout", items: contentState.data.handouts }];
  }
  if (page === "home") {
    return [
      { type: "notification", items: contentState.data.notifications },
      { type: "shared", items: contentState.data.sharedFiles },
      { type: "handout", items: contentState.data.handouts },
    ];
  }
  return [];
}

function setSelectOptions(select, values, placeholder) {
  if (!select) {
    return;
  }
  const current = select.value;
  const options = [`<option value="">${escapeHtml(placeholder)}</option>`]
    .concat(values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`))
    .join("");
  select.innerHTML = options;
  if (current && values.includes(current)) {
    select.value = current;
  }
}

function refreshFilterChoices() {
  const page = document.body.dataset.page;
  const sources = getPageSources(page);
  const categories = new Set();
  const lecturers = new Set();

  sources.forEach((source) => {
    source.items.forEach((item) => {
      const normalized = normalizeForFilter(item, source.type);
      if (normalized.category) {
        categories.add(normalized.category);
      }
      if (normalized.createdBy) {
        lecturers.add(normalized.createdBy);
      }
    });
  });

  setSelectOptions(
    document.getElementById("filterCategory"),
    Array.from(categories).sort((a, b) => a.localeCompare(b)),
    "All categories"
  );
  setSelectOptions(
    document.getElementById("filterLecturer"),
    Array.from(lecturers).sort((a, b) => a.localeCompare(b)),
    "All lecturers"
  );

  const categoryNode = document.getElementById("filterCategory");
  const lecturerNode = document.getElementById("filterLecturer");
  if (categoryNode) {
    categoryNode.value = contentState.filters.category;
  }
  if (lecturerNode) {
    lecturerNode.value = contentState.filters.lecturer;
  }
}

function renderPageFromState() {
  const page = document.body.dataset.page;
  if (!page) {
    return;
  }

  if (page === "notifications") {
    const filteredNotifications = applyFilters(contentState.data.notifications, "notification");
    const filteredShared = applyFilters(contentState.data.sharedFiles, "shared");
    renderNotificationFeed(filteredNotifications, filteredShared);
    return;
  }

  if (page === "handouts") {
    const filtered = applyFilters(contentState.data.handouts, "handout");
    renderHandouts(filtered);
    return;
  }

  if (page === "home") {
    renderHomeNotifications(applyFilters(contentState.data.notifications, "notification"));
    renderSharedFiles(applyFilters(contentState.data.sharedFiles, "shared"));
    renderHomeHandouts(applyFilters(contentState.data.handouts, "handout"));
  }
}

function bindFilterBar() {
  const page = document.body.dataset.page;
  if (!page || (page !== "home" && page !== "notifications" && page !== "handouts")) {
    return;
  }
  if (document.getElementById("contentFilters")) {
    return;
  }

  const anchor = document.getElementById("contentError");
  if (!anchor || !anchor.parentElement) {
    return;
  }

  const wrapper = document.createElement("section");
  wrapper.id = "contentFilters";
  wrapper.className = "card content-filters";
  wrapper.innerHTML = `
    <div class="filter-grid">
      <label>
        Search
        <input id="filterSearch" type="search" placeholder="Title, message, description..." />
      </label>
      <label>
        Category
        <select id="filterCategory">
          <option value="">All categories</option>
        </select>
      </label>
      <label>
        Lecturer
        <select id="filterLecturer">
          <option value="">All lecturers</option>
        </select>
      </label>
      <label>
        Date from
        <input id="filterDateFrom" type="date" />
      </label>
      <label>
        Urgency
        <select id="filterUrgency">
          <option value="all">All</option>
          <option value="urgent">Urgent only</option>
          <option value="not_urgent">Not urgent</option>
        </select>
      </label>
      <div class="filter-actions">
        <button id="filterReset" class="btn btn-secondary" type="button">Clear filters</button>
      </div>
    </div>
  `;

  anchor.parentElement.insertBefore(wrapper, anchor);

  const searchNode = document.getElementById("filterSearch");
  const categoryNode = document.getElementById("filterCategory");
  const lecturerNode = document.getElementById("filterLecturer");
  const dateNode = document.getElementById("filterDateFrom");
  const urgencyNode = document.getElementById("filterUrgency");
  const resetNode = document.getElementById("filterReset");

  if (searchNode) {
    searchNode.addEventListener("input", () => {
      contentState.filters.query = searchNode.value.trim();
      renderPageFromState();
    });
  }
  if (categoryNode) {
    categoryNode.addEventListener("change", () => {
      contentState.filters.category = categoryNode.value;
      renderPageFromState();
    });
  }
  if (lecturerNode) {
    lecturerNode.addEventListener("change", () => {
      contentState.filters.lecturer = lecturerNode.value;
      renderPageFromState();
    });
  }
  if (dateNode) {
    dateNode.addEventListener("change", () => {
      contentState.filters.dateFrom = dateNode.value;
      renderPageFromState();
    });
  }
  if (urgencyNode) {
    urgencyNode.addEventListener("change", () => {
      contentState.filters.urgency = urgencyNode.value;
      renderPageFromState();
    });
  }
  if (resetNode) {
    resetNode.addEventListener("click", () => {
      contentState.filters.query = "";
      contentState.filters.category = "";
      contentState.filters.lecturer = "";
      contentState.filters.urgency = "all";
      contentState.filters.dateFrom = "";
      if (searchNode) {
        searchNode.value = "";
      }
      if (categoryNode) {
        categoryNode.value = "";
      }
      if (lecturerNode) {
        lecturerNode.value = "";
      }
      if (urgencyNode) {
        urgencyNode.value = "all";
      }
      if (dateNode) {
        dateNode.value = "";
      }
      renderPageFromState();
    });
  }
}

async function loadContent() {
  const page = document.body.dataset.page;
  if (!page) {
    return;
  }

  try {
    if (page === "notifications") {
      const [meRes, notificationsRes, sharedFilesRes] = await Promise.all([
        fetch("/api/me", { credentials: "same-origin" }),
        fetch("/api/notifications", { credentials: "same-origin" }),
        fetch("/api/shared-files", { credentials: "same-origin" }),
      ]);
      if (!meRes.ok || !notificationsRes.ok || !sharedFilesRes.ok) {
        throw new Error("notifications");
      }
      contentState.user = await meRes.json();
      contentState.data.notifications = await notificationsRes.json();
      contentState.data.sharedFiles = await sharedFilesRes.json();
      refreshFilterChoices();
      renderPageFromState();
      return;
    }

    if (page === "handouts") {
      const [meRes, handoutsRes] = await Promise.all([
        fetch("/api/me", { credentials: "same-origin" }),
        fetch("/api/handouts", { credentials: "same-origin" }),
      ]);
      if (!meRes.ok || !handoutsRes.ok) {
        throw new Error("handouts");
      }
      contentState.user = await meRes.json();
      contentState.data.handouts = await handoutsRes.json();
      refreshFilterChoices();
      renderPageFromState();
      return;
    }

    if (page === "home") {
      const [meRes, notificationsRes, sharedFilesRes, handoutsRes] = await Promise.all([
        fetch("/api/me", { credentials: "same-origin" }),
        fetch("/api/notifications", { credentials: "same-origin" }),
        fetch("/api/shared-files", { credentials: "same-origin" }),
        fetch("/api/handouts", { credentials: "same-origin" }),
      ]);

      if (!meRes.ok || !notificationsRes.ok || !sharedFilesRes.ok || !handoutsRes.ok) {
        throw new Error("home");
      }

      contentState.user = await meRes.json();
      contentState.data.notifications = await notificationsRes.json();
      contentState.data.sharedFiles = await sharedFilesRes.json();
      contentState.data.handouts = await handoutsRes.json();
      refreshFilterChoices();
      renderPageFromState();
    }
  } catch (_err) {
    showContentError("Could not load content right now. Please refresh.");
    if (window.showToast) {
      window.showToast("Could not load content right now. Please refresh.", { type: "error" });
    }
  }
}

bindFilterBar();
bindNotificationReadActions();
loadContent();
