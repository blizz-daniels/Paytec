function setText(id, value) {
  const node = document.getElementById(id);
  if (node) {
    node.textContent = String(value);
  }
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
    const date = row.logged_in_at ? new Date(row.logged_in_at) : null;
    const dateText = date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : row.logged_in_at || "-";

    tr.innerHTML = `
      <td>${row.username || "-"}</td>
      <td>${row.source || "-"}</td>
      <td>${row.ip || "-"}</td>
      <td>${dateText}</td>
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
    const date = row.created_at ? new Date(row.created_at) : null;
    const dateText = date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : row.created_at || "-";
    tr.innerHTML = `
      <td>${row.actor_username || "-"}</td>
      <td><span class="status-badge">${row.actor_role || "-"}</span></td>
      <td><span class="${getActionBadgeClass(row.action)}">${row.action || "-"}</span></td>
      <td>${row.content_type || "-"}</td>
      <td>${row.target_owner || "-"}</td>
      <td>${row.summary || "-"}</td>
      <td>${dateText}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function loadAdminStats() {
  const errorNode = document.getElementById("adminError");

  try {
    const response = await fetch("/api/admin/stats", { credentials: "same-origin" });
    if (!response.ok) {
      throw new Error("Request failed");
    }

    const stats = await response.json();
    setText("totalUsers", stats.totalUsers || 0);
    setText("totalStudents", stats.totalStudents || 0);
    setText("totalTeachers", stats.totalTeachers || 0);
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

loadAdminStats();
