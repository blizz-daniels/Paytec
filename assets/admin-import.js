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

function renderRows(rowsId, rows) {
  const tbody = document.getElementById(rowsId);
  if (!tbody) {
    return;
  }

  tbody.innerHTML = "";
  if (!rows || !rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      '<td colspan="4" style="padding:0.6rem;color:#636b8a;border-bottom:1px solid #f0f2f8;">No rows analyzed yet.</td>';
    tbody.appendChild(tr);
    return;
  }

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    const isError = row.status === "error" || row.status === "duplicate_in_file";
    tr.innerHTML = `
      <td style="padding:0.45rem;border-bottom:1px solid #f0f2f8;">${escapeHtml(row.lineNumber)}</td>
      <td style="padding:0.45rem;border-bottom:1px solid #f0f2f8;">${escapeHtml(row.identifier || "-")}</td>
      <td style="padding:0.45rem;border-bottom:1px solid #f0f2f8;color:${isError ? "#a52828" : "#1f2333"};">${escapeHtml(row.status)}</td>
      <td style="padding:0.45rem;border-bottom:1px solid #f0f2f8;">${escapeHtml(row.message || "-")}</td>
    `;
    tbody.appendChild(tr);
  });
}

function buildSummaryText(summary, modeLabel) {
  if (!summary) {
    return `${modeLabel} completed.`;
  }
  return [
    `${modeLabel} completed.`,
    `Total: ${Number(summary.totalRows || 0)}`,
    `Valid: ${Number(summary.validRows || 0)}`,
    `Invalid: ${Number(summary.invalidRows || 0)}`,
    `Duplicates: ${Number(summary.duplicateRows || 0)}`,
    `New: ${Number(summary.inserts || 0)}`,
    `Updates: ${Number(summary.updates || 0)}`,
    `Imported: ${Number(summary.imported || 0)}`,
  ].join(" | ");
}

function downloadReport(filename, csvText) {
  const blob = new Blob([String(csvText || "")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function requestImport(endpoint, csvText) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ csvText }),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch (_err) {
    // Keep default payload.
  }

  if (!response.ok) {
    throw new Error(payload.error || "Import request failed.");
  }

  return payload;
}

function bindImportSection(config) {
  const form = document.getElementById(config.formId);
  const fileInput = document.getElementById(config.inputId);
  const previewButton = document.getElementById(config.previewButtonId);
  const reportButton = document.getElementById(config.reportButtonId);

  if (!form || !fileInput || !previewButton || !reportButton) {
    return;
  }

  let latestReportCsv = "";

  async function run(mode) {
    if (!fileInput.files || !fileInput.files[0]) {
      setStatus(config.statusId, "Select a CSV file first.", true);
      return;
    }

    setStatus(
      config.statusId,
      mode === "preview" ? "Previewing roster..." : "Importing roster...",
      false
    );

    try {
      const csvText = await fileInput.files[0].text();
      const endpoint = mode === "preview" ? config.previewEndpoint : config.importEndpoint;
      const payload = await requestImport(endpoint, csvText);
      const summaryText = buildSummaryText(
        payload.summary,
        mode === "preview" ? "Preview" : "Import"
      );
      setStatus(config.statusId, summaryText, false);
      renderRows(config.rowsId, payload.rows || []);
      latestReportCsv = String(payload.reportCsv || "");
      reportButton.hidden = !latestReportCsv;
    } catch (err) {
      setStatus(config.statusId, err.message, true);
      renderRows(config.rowsId, []);
      latestReportCsv = "";
      reportButton.hidden = true;
    }
  }

  previewButton.addEventListener("click", () => {
    run("preview");
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run("import");
  });

  reportButton.addEventListener("click", () => {
    if (!latestReportCsv) {
      return;
    }
    const suffix = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadReport(`${config.role}-import-report-${suffix}.csv`, latestReportCsv);
  });

  renderRows(config.rowsId, []);
}

bindImportSection({
  role: "students",
  formId: "studentImportForm",
  inputId: "studentCsv",
  statusId: "studentImportStatus",
  rowsId: "studentImportRows",
  previewButtonId: "studentPreviewButton",
  reportButtonId: "studentDownloadReport",
  previewEndpoint: "/api/admin/import/students/preview",
  importEndpoint: "/api/admin/import/students",
});

bindImportSection({
  role: "teachers",
  formId: "teacherImportForm",
  inputId: "teacherCsv",
  statusId: "teacherImportStatus",
  rowsId: "teacherImportRows",
  previewButtonId: "teacherPreviewButton",
  reportButtonId: "teacherDownloadReport",
  previewEndpoint: "/api/admin/import/teachers/preview",
  importEndpoint: "/api/admin/import/teachers",
});
