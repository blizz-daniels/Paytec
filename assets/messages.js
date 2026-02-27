const messagingState = {
  me: null,
  threads: [],
  activeThreadId: null,
  activeThread: null,
  activeLoadToken: 0,
};

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setStatus(id, message, isError = false) {
  const node = document.getElementById(id);
  if (!node) {
    return;
  }
  node.textContent = String(message || "");
  node.style.color = isError ? "var(--danger)" : "var(--muted)";
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

function formatTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function canCreateThread(role) {
  const normalized = String(role || "")
    .trim()
    .toLowerCase();
  return normalized === "teacher" || normalized === "admin";
}

function summarizeParticipants(participants, currentUsername) {
  const list = Array.isArray(participants) ? participants : [];
  const others = list.filter((entry) => String(entry.username || "").toLowerCase() !== String(currentUsername || "").toLowerCase());
  const source = others.length ? others : list;
  const names = source.slice(0, 3).map((entry) => String(entry.username || "").trim()).filter(Boolean);
  if (!names.length) {
    return "Conversation";
  }
  if (source.length > 3) {
    names.push(`+${source.length - 3}`);
  }
  return names.join(", ");
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch (_err) {
    payload = null;
  }
  if (!response.ok) {
    throw new Error((payload && payload.error) || "Request failed.");
  }
  return payload || {};
}

function renderUnreadBadge(unreadPayload) {
  const unread = unreadPayload || {};
  const unreadThreads = Number(unread.unread_threads || 0);
  const unreadMessages = Number(unread.unread_messages || 0);
  const node = document.getElementById("messagesUnreadBadge");
  if (!node) {
    return;
  }
  node.textContent = `Unread: ${Math.max(0, unreadThreads)} threads / ${Math.max(0, unreadMessages)} msgs`;
}

function renderThreads() {
  const container = document.getElementById("messageThreadList");
  if (!container) {
    return;
  }
  const threads = Array.isArray(messagingState.threads) ? messagingState.threads : [];
  if (!threads.length) {
    container.innerHTML = '<p class="messages-empty">No conversations yet.</p>';
    return;
  }
  container.innerHTML = threads
    .map((thread) => {
      const id = Number(thread.id || 0);
      const isActive = id > 0 && id === messagingState.activeThreadId;
      const unreadCount = Math.max(0, Number(thread.unread_count || 0));
      const preview = String(thread.last_message?.body || "").slice(0, 120);
      const subject = String(thread.subject || "").trim() || summarizeParticipants(thread.participants, messagingState.me?.username);
      const updatedAt = thread.last_message?.created_at || thread.updated_at || thread.created_at;
      return `
        <button
          type="button"
          class="messages-thread-item${isActive ? " messages-thread-item--active" : ""}${unreadCount > 0 ? " messages-thread-item--unread" : ""}"
          data-thread-id="${id}"
        >
          <div class="messages-thread-item__head">
            <p class="messages-thread-item__subject">${escapeHtml(subject)}</p>
            ${unreadCount > 0 ? `<span class="status-badge status-badge--warning">${unreadCount}</span>` : ""}
          </div>
          <p class="messages-thread-item__preview">${escapeHtml(preview || "No messages yet.")}</p>
          <p class="messages-thread-item__meta">${escapeHtml(formatTime(updatedAt) || "")}</p>
        </button>
      `;
    })
    .join("");

  container.querySelectorAll("[data-thread-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const threadId = Number.parseInt(button.getAttribute("data-thread-id"), 10) || 0;
      if (threadId > 0) {
        openThread(threadId, { markRead: true }).catch((err) => {
          setStatus("messagesListStatus", err?.message || "Could not open thread.", true);
        });
      }
    });
  });
}

function renderMessages(payload) {
  const placeholder = document.getElementById("messagePlaceholderState");
  const panel = document.getElementById("messageThreadPanel");
  const bodyList = document.getElementById("messageBodyList");
  const title = document.getElementById("messageThreadTitle");
  const meta = document.getElementById("messageThreadMeta");
  const participantsNode = document.getElementById("messageThreadParticipants");
  if (!placeholder || !panel || !bodyList || !title || !meta || !participantsNode) {
    return;
  }
  if (!payload || !payload.thread) {
    panel.hidden = true;
    placeholder.hidden = false;
    placeholder.textContent = "Select a thread to read and reply.";
    return;
  }

  const subject = String(payload.thread.subject || "").trim();
  title.textContent = subject || summarizeParticipants(payload.participants, messagingState.me?.username);
  meta.textContent = `Started by ${payload.thread.created_by || "unknown"} | Updated ${formatTime(payload.thread.updated_at) || "-"}`;
  participantsNode.textContent = `Participants: ${(payload.participants || [])
    .map((entry) => String(entry.username || ""))
    .filter(Boolean)
    .join(", ")}`;

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (!messages.length) {
    bodyList.innerHTML = '<p class="messages-empty">No messages in this thread yet.</p>';
  } else {
    bodyList.innerHTML = messages
      .map((message) => {
        const mine =
          String(message.sender_username || "").toLowerCase() === String(messagingState.me?.username || "").toLowerCase();
        return `
          <article class="message-bubble${mine ? " message-bubble--mine" : ""}">
            <p class="message-bubble__meta">${escapeHtml(message.sender_username || "unknown")} (${escapeHtml(message.sender_role || "member")})</p>
            <p class="message-bubble__body">${escapeHtml(message.body || "")}</p>
            <p class="message-bubble__time">${escapeHtml(formatTime(message.created_at) || "")}</p>
          </article>
        `;
      })
      .join("");
  }

  panel.hidden = false;
  placeholder.hidden = true;
  bodyList.scrollTop = bodyList.scrollHeight;
}

async function markThreadRead(threadId) {
  const payload = await requestJson(`/api/messages/threads/${threadId}/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  renderUnreadBadge(payload.unread || {});
}

async function openThread(threadId, { markRead = true } = {}) {
  if (!Number.isFinite(threadId) || threadId <= 0) {
    throw new Error("Invalid thread ID.");
  }
  messagingState.activeThreadId = threadId;
  renderThreads();
  const currentToken = messagingState.activeLoadToken + 1;
  messagingState.activeLoadToken = currentToken;
  const bodyList = document.getElementById("messageBodyList");
  if (bodyList) {
    bodyList.innerHTML = '<p class="messages-empty">Loading conversation...</p>';
  }
  const payload = await requestJson(`/api/messages/threads/${threadId}`);
  if (messagingState.activeLoadToken !== currentToken) {
    return;
  }
  messagingState.activeThread = payload;
  renderMessages(payload);
  if (markRead && Number(payload.unread_count || 0) > 0) {
    await markThreadRead(threadId);
    await loadThreads({ preserveSelection: true, suppressStatus: true });
  }
}

async function loadThreads({ preserveSelection = true, suppressStatus = false } = {}) {
  if (!suppressStatus) {
    setStatus("messagesListStatus", "Loading threads...");
  }
  const payload = await requestJson("/api/messages/threads");
  messagingState.threads = Array.isArray(payload.threads) ? payload.threads : [];
  renderThreads();
  renderUnreadBadge(payload.unread || {});
  if (!messagingState.threads.length) {
    messagingState.activeThreadId = null;
    messagingState.activeThread = null;
    renderMessages(null);
    if (!suppressStatus) {
      setStatus("messagesListStatus", "No threads found for your account.");
    }
    return;
  }

  if (preserveSelection && messagingState.activeThreadId) {
    const found = messagingState.threads.some((thread) => Number(thread.id || 0) === messagingState.activeThreadId);
    if (found) {
      if (!suppressStatus) {
        setStatus("messagesListStatus", "Threads updated.");
      }
      return;
    }
  }

  const firstThreadId = Number(messagingState.threads[0].id || 0);
  if (firstThreadId > 0) {
    await openThread(firstThreadId, { markRead: true });
  }
  if (!suppressStatus) {
    setStatus("messagesListStatus", "Threads updated.");
  }
}

async function loadComposeStudents() {
  const composeCard = document.getElementById("messageComposeCard");
  const recipientsInput = document.getElementById("messageRecipientsInput");
  if (!composeCard || !(recipientsInput instanceof HTMLSelectElement)) {
    return;
  }
  if (!canCreateThread(messagingState.me?.role)) {
    composeCard.hidden = true;
    return;
  }
  composeCard.hidden = false;
  setStatus("messageComposeStatus", "Loading student directory...");
  try {
    const payload = await requestJson("/api/messages/students");
    const students = Array.isArray(payload.students) ? payload.students : [];
    recipientsInput.innerHTML = students
      .map((student) => {
        const username = String(student.username || "").trim();
        const display = String(student.display_name || username).trim();
        return `<option value="${escapeHtml(username)}">${escapeHtml(`${display} (${username})`)}</option>`;
      })
      .join("");
    if (!students.length) {
      setStatus("messageComposeStatus", "No students available for messaging.");
    } else {
      setStatus("messageComposeStatus", `Select one or more recipients (${students.length} students).`);
    }
  } catch (err) {
    setStatus("messageComposeStatus", err?.message || "Could not load students.", true);
  }
}

function getSelectedRecipients() {
  const recipientsInput = document.getElementById("messageRecipientsInput");
  if (!(recipientsInput instanceof HTMLSelectElement)) {
    return [];
  }
  return Array.from(recipientsInput.selectedOptions)
    .map((option) => String(option.value || "").trim())
    .filter(Boolean);
}

function bindCreateThreadForm() {
  const form = document.getElementById("messageCreateForm");
  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = document.getElementById("messageCreateButton");
    const subjectInput = document.getElementById("messageSubjectInput");
    const bodyInput = document.getElementById("messageInitialBodyInput");
    const recipients = getSelectedRecipients();
    const subject = subjectInput instanceof HTMLInputElement ? subjectInput.value : "";
    const message = bodyInput instanceof HTMLTextAreaElement ? bodyInput.value : "";
    if (!recipients.length) {
      setStatus("messageComposeStatus", "Select at least one student recipient.", true);
      return;
    }
    if (!String(message || "").trim()) {
      setStatus("messageComposeStatus", "Initial message is required.", true);
      return;
    }

    const loadingToast = window.showToast ? window.showToast("Creating thread...", { type: "loading", sticky: true }) : null;
    setButtonBusy(button, true, "Creating...");
    try {
      const payload = await requestJson("/api/messages/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject,
          recipients,
          message,
        }),
      });
      if (subjectInput instanceof HTMLInputElement) {
        subjectInput.value = "";
      }
      if (bodyInput instanceof HTMLTextAreaElement) {
        bodyInput.value = "";
      }
      const recipientsInput = document.getElementById("messageRecipientsInput");
      if (recipientsInput instanceof HTMLSelectElement) {
        Array.from(recipientsInput.options).forEach((option) => {
          option.selected = false;
        });
      }
      setStatus("messageComposeStatus", "Thread created.");
      if (window.showToast) {
        window.showToast("Thread created.", { type: "success" });
      }
      messagingState.activeThreadId = Number(payload.threadId || 0) || messagingState.activeThreadId;
      await loadThreads({ preserveSelection: true });
      if (messagingState.activeThreadId) {
        await openThread(messagingState.activeThreadId, { markRead: false });
      }
    } catch (err) {
      setStatus("messageComposeStatus", err?.message || "Could not create thread.", true);
      if (window.showToast) {
        window.showToast(err?.message || "Could not create thread.", { type: "error" });
      }
    } finally {
      setButtonBusy(button, false, "Start Thread");
      if (loadingToast) {
        loadingToast.close();
      }
    }
  });
}

function bindReplyForm() {
  const form = document.getElementById("messageReplyForm");
  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const threadId = Number(messagingState.activeThreadId || 0);
    if (!threadId) {
      if (window.showToast) {
        window.showToast("Select a thread first.", { type: "error" });
      }
      return;
    }
    const input = document.getElementById("messageReplyInput");
    const button = document.getElementById("messageReplyButton");
    const message = input instanceof HTMLTextAreaElement ? input.value : "";
    if (!String(message || "").trim()) {
      if (window.showToast) {
        window.showToast("Reply message cannot be empty.", { type: "error" });
      }
      return;
    }

    const loadingToast = window.showToast ? window.showToast("Sending reply...", { type: "loading", sticky: true }) : null;
    setButtonBusy(button, true, "Sending...");
    try {
      await requestJson(`/api/messages/threads/${threadId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (input instanceof HTMLTextAreaElement) {
        input.value = "";
      }
      await openThread(threadId, { markRead: false });
      await loadThreads({ preserveSelection: true, suppressStatus: true });
      if (window.showToast) {
        window.showToast("Reply sent.", { type: "success" });
      }
    } catch (err) {
      if (window.showToast) {
        window.showToast(err?.message || "Could not send reply.", { type: "error" });
      }
    } finally {
      setButtonBusy(button, false, "Send Reply");
      if (loadingToast) {
        loadingToast.close();
      }
    }
  });
}

function bindRefreshButton() {
  const button = document.getElementById("messageRefreshButton");
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  button.addEventListener("click", async () => {
    setButtonBusy(button, true, "Refreshing...");
    try {
      await loadThreads({ preserveSelection: true });
    } catch (err) {
      setStatus("messagesListStatus", err?.message || "Could not refresh threads.", true);
    } finally {
      setButtonBusy(button, false, "Refresh");
    }
  });
}

async function initMessagesPage() {
  try {
    messagingState.me = await requestJson("/api/me");
    bindRefreshButton();
    bindCreateThreadForm();
    bindReplyForm();
    await loadComposeStudents();
    await loadThreads({ preserveSelection: true });
  } catch (err) {
    setStatus("messagesListStatus", err?.message || "Could not load messaging page.", true);
    const placeholder = document.getElementById("messagePlaceholderState");
    if (placeholder) {
      placeholder.textContent = "Unable to load messages right now.";
    }
  }
}

window.addEventListener("DOMContentLoaded", () => {
  initMessagesPage();
});
