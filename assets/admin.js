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
    tr.innerHTML =
      '<td colspan="4" style="padding: 0.75rem; color: #636b8a;">No login activity yet.</td>';
    tbody.appendChild(tr);
    return;
  }

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    const date = row.logged_in_at ? new Date(row.logged_in_at) : null;
    const dateText = date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : row.logged_in_at || "-";

    tr.innerHTML = `
      <td style="padding: 0.5rem; border-bottom: 1px solid #f0f2f8;">${row.username || "-"}</td>
      <td style="padding: 0.5rem; border-bottom: 1px solid #f0f2f8;">${row.source || "-"}</td>
      <td style="padding: 0.5rem; border-bottom: 1px solid #f0f2f8;">${row.ip || "-"}</td>
      <td style="padding: 0.5rem; border-bottom: 1px solid #f0f2f8;">${dateText}</td>
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
  } catch (_err) {
    if (errorNode) {
      errorNode.textContent = "Could not load admin stats.";
      errorNode.hidden = false;
    }
  }
}

loadAdminStats();
